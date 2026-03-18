package skills

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Scopes mirror pi's skill sources: the agent directory, the project, and an
// explicit settings path.
const (
	ScopeGlobal  = "global"
	ScopeProject = "project"
	ScopePath    = "path"
	ScopePackage = "package"
)

// Skill is one loaded SKILL.md or standalone markdown skill.
type Skill struct {
	Name        string
	Description string
	FilePath    string
	Dir         string
	Scope       string
	Disabled    bool
}

// Diagnostic explains a skill that was skipped or a collision.
type Diagnostic struct {
	Path    string
	Message string
}

// Load discovers skills exactly where pi does: the agent skills directory, the
// project's .pi/skills, and explicit settings paths.
func Load(agentDir, cwd string, extraPaths []string) ([]Skill, []Diagnostic) {
	var diagnostics []Diagnostic
	seenPaths := map[string]bool{}
	byName := map[string]Skill{}
	order := []string{}

	add := func(found []Skill, diags []Diagnostic) {
		for _, diagnostic := range diags {
			diagnostics = append(diagnostics, diagnostic)
		}
		for _, skill := range found {
			real := skill.FilePath
			if resolved, err := filepath.EvalSymlinks(skill.FilePath); err == nil {
				real = resolved
			}
			if seenPaths[real] {
				continue
			}
			if existing, ok := byName[skill.Name]; ok {
				diagnostics = append(diagnostics, Diagnostic{
					Path:    skill.FilePath,
					Message: fmt.Sprintf("name %q collides with %s", skill.Name, existing.FilePath),
				})
				continue
			}
			seenPaths[real] = true
			byName[skill.Name] = skill
			order = append(order, skill.Name)
		}
	}

	add(scanDir(filepath.Join(agentDir, "skills"), ScopeGlobal))
	if home, err := os.UserHomeDir(); err == nil {
		// The skills CLI's global store; pi sees it through symlinks, but the
		// web panel also lists it directly so a broken link stays visible.
		add(scanDir(filepath.Join(home, ".agents", "skills"), ScopeGlobal))
	}
	add(scanDir(filepath.Join(cwd, ".pi", "skills"), ScopeProject))
	add(scanPackageSkills(agentDir))
	for _, raw := range extraPaths {
		path := raw
		if !filepath.IsAbs(path) {
			path = filepath.Join(cwd, path)
		}
		info, err := os.Stat(path)
		if err != nil {
			diagnostics = append(diagnostics, Diagnostic{Path: path, Message: "skill path does not exist"})
			continue
		}
		if info.IsDir() {
			add(scanDir(path, ScopePath))
			continue
		}
		if !strings.HasSuffix(strings.ToLower(path), ".md") {
			diagnostics = append(diagnostics, Diagnostic{Path: path, Message: "skill path is not a markdown file"})
			continue
		}
		if skill, ok := loadFile(path, ScopePath); ok {
			add([]Skill{skill}, nil)
		}
	}

	list := make([]Skill, 0, len(order))
	for _, name := range order {
		list = append(list, byName[name])
	}
	// Enabled skills first, then by name, matching the web panel's order.
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Disabled != list[j].Disabled {
			return !list[i].Disabled
		}
		return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name)
	})
	return list, diagnostics
}

// scanDir follows pi's rules: a directory with SKILL.md is one skill and is not
// recursed into; otherwise root markdown files are skills and subdirectories
// are searched for SKILL.md.
func scanDir(dir, scope string) ([]Skill, []Diagnostic) {
	var found []Skill
	var diagnostics []Diagnostic

	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return nil, nil
	}
	if skillFile := filepath.Join(dir, "SKILL.md"); fileExists(skillFile) {
		if skill, ok := loadFile(skillFile, scope); ok {
			found = append(found, skill)
		}
		return found, nil
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, []Diagnostic{{Path: dir, Message: err.Error()}}
	}
	for _, entry := range entries {
		name := entry.Name()
		path := filepath.Join(dir, name)
		isDir := entry.IsDir()
		if entry.Type()&os.ModeSymlink != 0 {
			if info, err := os.Stat(path); err == nil {
				isDir = info.IsDir()
			}
		}
		if isDir {
			if strings.HasPrefix(name, ".") || name == "node_modules" {
				continue
			}
			children, childDiagnostics := scanDir(path, scope)
			found = append(found, children...)
			diagnostics = append(diagnostics, childDiagnostics...)
			continue
		}
		if !strings.HasSuffix(strings.ToLower(name), ".md") || strings.EqualFold(name, "SKILL.md") {
			continue
		}
		if skill, ok := loadFile(path, scope); ok {
			found = append(found, skill)
		}
	}
	return found, diagnostics
}

// scanPackageSkills finds skills a pi package ships in its manifest's
// `pi.skills` list. Installed npm packages live under <agent>/npm/node_modules.
func scanPackageSkills(agentDir string) ([]Skill, []Diagnostic) {
	root := filepath.Join(agentDir, "npm", "node_modules")
	if _, err := os.ReadDir(root); err != nil {
		return nil, nil
	}
	var found []Skill
	var diagnostics []Diagnostic
	var visit func(dir string)
	visit = func(dir string) {
		manifestPath := filepath.Join(dir, "package.json")
		data, err := os.ReadFile(manifestPath)
		if err != nil {
			return
		}
		var manifest struct {
			Pi struct {
				Skills []string `json:"skills"`
			} `json:"pi"`
		}
		if err := json.Unmarshal(data, &manifest); err != nil {
			return
		}
		for _, raw := range manifest.Pi.Skills {
			path := raw
			if !filepath.IsAbs(path) {
				path = filepath.Join(dir, strings.TrimPrefix(path, "./"))
			}
			info, err := os.Stat(path)
			if err != nil {
				diagnostics = append(diagnostics, Diagnostic{Path: path, Message: "package skill path does not exist"})
				continue
			}
			if info.IsDir() {
				children, childDiagnostics := scanDir(path, ScopePackage)
				found = append(found, children...)
				diagnostics = append(diagnostics, childDiagnostics...)
			} else if skill, ok := loadFile(path, ScopePackage); ok {
				found = append(found, skill)
			}
		}
	}
	var walk func(dir string)
	walk = func(dir string) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			path := filepath.Join(dir, entry.Name())
			if strings.HasPrefix(entry.Name(), "@") {
				walk(path)
				continue
			}
			visit(path)
		}
	}
	walk(root)
	return found, diagnostics
}

func loadFile(path, scope string) (Skill, bool) {
	content, err := os.ReadFile(path)
	if err != nil {
		return Skill{}, false
	}
	frontmatter := ParseFrontmatter(string(content))
	description, _ := frontmatter.Values["description"]
	description = strings.TrimSpace(description)
	if description == "" {
		return Skill{}, false
	}
	name := strings.TrimSpace(frontmatter.Values["name"])
	if name == "" {
		if strings.EqualFold(filepath.Base(path), "SKILL.md") {
			name = filepath.Base(filepath.Dir(path))
		} else {
			name = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		}
	}
	return Skill{
		Name:        name,
		Description: description,
		FilePath:    path,
		Dir:         filepath.Dir(path),
		Scope:       scope,
		Disabled:    strings.EqualFold(frontmatter.Values[disableKey], "true"),
	}, true
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// SetDisabled toggles the skill file's disable-model-invocation key. The write
// follows symlinks and keeps the file's mode, like the web panel's edit.
func SetDisabled(path string, disable bool) error {
	if !strings.HasSuffix(strings.ToLower(path), ".md") {
		return fmt.Errorf("%s is not a skill file", path)
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	updated, err := SetDisableModelInvocation(string(content), disable)
	if err != nil {
		return err
	}
	if updated == string(content) {
		return nil
	}
	return os.WriteFile(path, []byte(updated), info.Mode().Perm())
}

// SearchResult is one skill.sh hit.
type SearchResult struct {
	Package  string
	Installs string
	URL      string
}

// Search queries the skills.sh API, defaulting to the public instance.
func Search(ctx context.Context, base, query string, limit int) ([]SearchResult, error) {
	if strings.TrimSpace(query) == "" {
		return nil, fmt.Errorf("query required")
	}
	if base == "" {
		base = os.Getenv("SKILLS_API_URL")
	}
	if base == "" {
		base = "https://skills.sh"
	}
	if limit <= 0 || limit > 50 {
		limit = 50
	}
	endpoint := strings.TrimRight(base, "/") + "/api/search?q=" + url.QueryEscape(query) + "&limit=" + strconv.Itoa(limit)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 20 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("skills.sh search failed: HTTP %d", response.StatusCode)
	}
	var payload struct {
		Skills []struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			Source   string `json:"source"`
			Installs int    `json:"installs"`
		} `json:"skills"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, err
	}
	results := make([]SearchResult, 0, len(payload.Skills))
	for _, item := range payload.Skills {
		if item.Name == "" || (item.Source == "" && item.ID == "") {
			continue
		}
		source := item.Source
		if source == "" {
			source = item.ID
		}
		result := SearchResult{
			Package:  source + "@" + item.Name,
			Installs: formatInstalls(item.Installs),
		}
		if item.ID != "" {
			result.URL = strings.TrimRight(base, "/") + "/" + item.ID
		}
		results = append(results, result)
	}
	return results, nil
}

func formatInstalls(count int) string {
	switch {
	case count >= 1_000_000:
		return trimZero(float64(count)/1_000_000) + "M installs"
	case count >= 1_000:
		return trimZero(float64(count)/1_000) + "K installs"
	case count > 0:
		label := "installs"
		if count == 1 {
			label = "install"
		}
		return fmt.Sprintf("%d %s", count, label)
	default:
		return ""
	}
}

func trimZero(value float64) string {
	text := strconv.FormatFloat(value, 'f', 1, 64)
	return strings.TrimSuffix(text, ".0")
}

// Install runs the skills CLI the same way the web panel does.
func Install(ctx context.Context, pkg, cwd string, global bool) (string, error) {
	if strings.TrimSpace(pkg) == "" {
		return "", fmt.Errorf("package required")
	}
	args := []string{"-y", "skills", "add", strings.TrimSpace(pkg), "-y", "--agent", "pi"}
	if global {
		args = append(args, "-g")
	}
	return runNpx(ctx, args, cwd, 90*time.Second)
}

// UpdateAll updates every installed skill of one scope.
func UpdateAll(ctx context.Context, cwd string, global bool) (string, error) {
	args := []string{"-y", "skills", "update", "-y"}
	if global {
		args = append(args, "-g")
	} else {
		args = append(args, "-p")
	}
	return runNpx(ctx, args, cwd, 120*time.Second)
}

func runNpx(ctx context.Context, args []string, cwd string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(ctx, "npx", args...)
	command.Dir = cwd
	command.Env = append(os.Environ(), "FORCE_COLOR=0", "NO_COLOR=1")
	output, err := command.CombinedOutput()
	clean := stripANSI(string(output))
	if err != nil {
		if strings.TrimSpace(clean) != "" {
			return clean, fmt.Errorf("%s", lastLines(clean, 6))
		}
		return clean, err
	}
	return clean, nil
}

func stripANSI(value string) string {
	var builder strings.Builder
	escaping := false
	for _, r := range value {
		if escaping {
			if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
				escaping = false
			}
			continue
		}
		if r == 0x1b {
			escaping = true
			continue
		}
		builder.WriteRune(r)
	}
	return builder.String()
}

func lastLines(value string, count int) string {
	lines := strings.Split(strings.TrimSpace(value), "\n")
	if len(lines) > count {
		lines = lines[len(lines)-count:]
	}
	return strings.Join(lines, "\n")
}
