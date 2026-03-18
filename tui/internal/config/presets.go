package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
)

// Custom tool preset rules, shared with pie's editor and API.
const (
	CustomPresetsVersion = 1
	CustomPresetMaxCount = 20
	CustomPresetNameMax  = 40
	CustomPresetIDMax    = 64
	CustomPresetPrefix   = "custom:"
)

// SelectableToolName matches a tool name a preset may contain: a pi tool, an
// inline pie tool, a goal tool, or an MCP tool.
var SelectableToolName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)

var customPresetIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

// CanonicalCodingTools are the built-in coding tools in the order pie lists
// them. Presets sort these first and everything else alphabetically.
var CanonicalCodingTools = []string{"bash", "read", "edit", "write", "grep", "find", "ls"}

// BuiltinPreset is one preset that ships with pie. A nil Tools list means the
// preset pins nothing and pi resolves settings.json defaultTools instead.
type BuiltinPreset struct {
	ID          string
	Name        string
	Description string
	Tools       []string
	WorkMode    string
}

// BuiltinPresets are the presets pie offers, in dropdown order. Task-related
// presets (autonomous, orchestrator) are intentionally absent: the terminal
// client does not implement the task workspace.
var BuiltinPresets = []BuiltinPreset{
	{
		ID:          "configured",
		Name:        "configured",
		Description: "Follow the tools configured in settings.json",
		Tools:       nil,
	},
	{
		ID:          "plan",
		Name:        "plan",
		Description: "Read-only tools; the agent plans and asks instead of implementing",
		Tools:       []string{"read", "grep", "find", "ls"},
		WorkMode:    "plan",
	},
	{
		ID:          "none",
		Name:        "chat only",
		Description: "No coding tools; conversation only",
		Tools:       []string{},
	},
	{
		ID:          "read-only",
		Name:        "read-only",
		Description: "Read, grep, find, and ls only",
		Tools:       []string{"read", "grep", "find", "ls"},
	},
	{
		ID:          "default",
		Name:        "default",
		Description: "Read, bash, edit, and write",
		Tools:       []string{"read", "bash", "edit", "write"},
	},
	{
		ID:          "full",
		Name:        "full",
		Description: "Every built-in coding tool",
		Tools:       []string{"bash", "read", "edit", "write", "grep", "find", "ls"},
	},
}

// BuiltinPresetByID finds a built-in preset.
func BuiltinPresetByID(id string) (BuiltinPreset, bool) {
	for _, preset := range BuiltinPresets {
		if preset.ID == id {
			return preset, true
		}
	}
	return BuiltinPreset{}, false
}

// CustomPreset is one user-defined preset from pie-tool-presets.json.
type CustomPreset struct {
	ID                string
	Name              string
	Tools             []string
	IncludeExtensions bool
}

// PresetFile is a snapshot of pie-tool-presets.json.
type PresetFile struct {
	path    string
	presets []CustomPreset
	invalid error
}

// LoadPresets reads the custom preset file. Unparsable content reads as an
// empty list and is reported through Invalid, matching pie's behavior of
// showing no presets rather than failing the panel.
func LoadPresets(paths Paths) *PresetFile {
	path := paths.Presets()
	doc, err := Load(path)
	if err != nil {
		var syntax *SyntaxError
		if errors.As(err, &syntax) {
			return &PresetFile{path: path, invalid: err}
		}
		return &PresetFile{path: path, invalid: err}
	}
	if !doc.Existed() || doc.Root().Len() == 0 {
		// A missing file, and the empty object an interrupted first write can
		// leave, both mean "no presets yet".
		return &PresetFile{path: path}
	}
	presets, parseErr := ParsePresets(doc.Root())
	if parseErr != nil {
		return &PresetFile{path: path, invalid: parseErr}
	}
	return &PresetFile{path: path, presets: presets}
}

// Path returns the preset file path.
func (f *PresetFile) Path() string { return f.path }

// Presets returns the valid presets; empty when the file is invalid.
func (f *PresetFile) Presets() []CustomPreset {
	out := make([]CustomPreset, len(f.presets))
	copy(out, f.presets)
	return out
}

// Invalid reports why the file could not be used, if it could not.
func (f *PresetFile) Invalid() error { return f.invalid }

// Find returns a preset by ID.
func (f *PresetFile) Find(id string) (CustomPreset, bool) {
	for _, preset := range f.presets {
		if preset.ID == id {
			return preset, true
		}
	}
	return CustomPreset{}, false
}

// Save writes the presets. A file that cannot be parsed is set aside first,
// as pie does, and replaced with the new document.
func (f *PresetFile) Save(presets []CustomPreset) error {
	if err := ValidatePresets(presets); err != nil {
		return err
	}
	normalized := make([]CustomPreset, len(presets))
	for i, preset := range presets {
		tools, err := NormalizePresetTools(preset.Tools)
		if err != nil {
			return fmt.Errorf("preset %q: %w", preset.Name, err)
		}
		normalized[i] = CustomPreset{
			ID:                preset.ID,
			Name:              strings.TrimSpace(preset.Name),
			Tools:             tools,
			IncludeExtensions: preset.IncludeExtensions,
		}
	}

	// A parseable JSON document with the wrong shape is set aside too, so a
	// hand-edited file is never silently replaced.
	if f.invalid != nil {
		var syntax *SyntaxError
		if !errors.As(f.invalid, &syntax) {
			if _, err := backupCorrupt(f.path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}

	root := NewObject()
	root.SetNumber("version", CustomPresetsVersion)
	list := NewArray()
	for _, preset := range normalized {
		entry := NewObject()
		entry.SetString("id", preset.ID)
		entry.SetString("name", preset.Name)
		entry.SetBool("includeExtensions", preset.IncludeExtensions)
		entry.SetStrings("tools", preset.Tools)
		list.Append(entry)
	}
	root.Set("presets", list)

	doc := &Document{path: f.path, root: root}
	if err := doc.ReplaceRecovering(root); err != nil {
		return err
	}
	f.presets = normalized
	f.invalid = nil
	return nil
}

// ParsePresets validates a whole document and returns its presets. Unknown
// fields are dropped; a structurally invalid document is an error.
func ParsePresets(root *Value) ([]CustomPreset, error) {
	if root == nil || !root.IsObject() {
		return nil, fmt.Errorf("expected a preset document object")
	}
	version, ok := root.Get("version").AsInt()
	if !ok || version != CustomPresetsVersion {
		return nil, fmt.Errorf("expected preset document version %d", CustomPresetsVersion)
	}
	list := root.Get("presets")
	if list == nil || !list.IsArray() {
		return nil, fmt.Errorf("expected a presets array")
	}
	if list.Len() > CustomPresetMaxCount {
		return nil, fmt.Errorf("at most %d presets are allowed", CustomPresetMaxCount)
	}

	ids := make(map[string]bool, list.Len())
	names := make(map[string]bool, list.Len())
	out := make([]CustomPreset, 0, list.Len())
	for i := 0; i < list.Len(); i++ {
		entry := list.Index(i)
		if entry == nil || !entry.IsObject() {
			return nil, fmt.Errorf("preset %d is not an object", i+1)
		}
		id, err := parsePresetID(entry.Get("id"))
		if err != nil {
			return nil, fmt.Errorf("preset %d: %w", i+1, err)
		}
		name, err := parsePresetName(entry.Get("name"))
		if err != nil {
			return nil, fmt.Errorf("preset %d: %w", i+1, err)
		}
		tools, err := normalizePresetTools(entry.Get("tools"))
		if err != nil {
			return nil, fmt.Errorf("preset %d: %w", i+1, err)
		}
		includeExtensions := true
		if value := entry.Get("includeExtensions"); value != nil {
			flag, ok := value.AsBool()
			if !ok {
				return nil, fmt.Errorf("preset %d: includeExtensions must be a boolean", i+1)
			}
			includeExtensions = flag
		}
		idKey := strings.ToLower(id)
		nameKey := strings.ToLower(name)
		if ids[idKey] {
			return nil, fmt.Errorf("duplicate preset id %q", id)
		}
		if names[nameKey] {
			return nil, fmt.Errorf("duplicate preset name %q", name)
		}
		ids[idKey] = true
		names[nameKey] = true
		out = append(out, CustomPreset{ID: id, Name: name, Tools: tools, IncludeExtensions: includeExtensions})
	}
	return out, nil
}

// ValidatePresets checks a list before saving it.
func ValidatePresets(presets []CustomPreset) error {
	if len(presets) > CustomPresetMaxCount {
		return fmt.Errorf("at most %d presets are allowed", CustomPresetMaxCount)
	}
	ids := make(map[string]bool, len(presets))
	names := make(map[string]bool, len(presets))
	for i, preset := range presets {
		if !customPresetIDPattern.MatchString(preset.ID) || len(preset.ID) > CustomPresetIDMax {
			return fmt.Errorf("preset %d: invalid id", i+1)
		}
		trimmed := strings.TrimSpace(preset.Name)
		if trimmed == "" || len(trimmed) > CustomPresetNameMax {
			return fmt.Errorf("preset %d: name must be 1-%d characters", i+1, CustomPresetNameMax)
		}
		if len(preset.Tools) == 0 {
			return fmt.Errorf("preset %d: select at least one tool", i+1)
		}
		for _, tool := range preset.Tools {
			if tool == "powershell" {
				continue
			}
			if !SelectableToolName.MatchString(tool) {
				return fmt.Errorf("preset %d: invalid tool name %q", i+1, tool)
			}
		}
		idKey := strings.ToLower(preset.ID)
		nameKey := strings.ToLower(trimmed)
		if ids[idKey] {
			return fmt.Errorf("duplicate preset id %q", preset.ID)
		}
		if names[nameKey] {
			return fmt.Errorf("duplicate preset name %q", trimmed)
		}
		ids[idKey] = true
		names[nameKey] = true
	}
	return nil
}

func parsePresetID(value *Value) (string, error) {
	id, ok := value.AsString()
	if !ok || id == "" || len(id) > CustomPresetIDMax || !customPresetIDPattern.MatchString(id) {
		return "", fmt.Errorf("invalid id")
	}
	return id, nil
}

func parsePresetName(value *Value) (string, error) {
	name, ok := value.AsString()
	if !ok {
		return "", fmt.Errorf("name must be a string")
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > CustomPresetNameMax {
		return "", fmt.Errorf("name must be 1-%d characters", CustomPresetNameMax)
	}
	return name, nil
}

func normalizePresetTools(value *Value) ([]string, error) {
	names, ok := value.AsStrings()
	if !ok {
		return nil, fmt.Errorf("tools must be an array of strings")
	}
	out, err := NormalizePresetTools(names)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// NormalizePresetTools validates, deduplicates, and sorts a tool list. An empty
// combination is rejected: chat only is the built-in preset for that.
func NormalizePresetTools(names []string) ([]string, error) {
	if len(names) == 0 {
		return nil, fmt.Errorf("select at least one tool")
	}
	seen := make(map[string]bool, len(names))
	out := make([]string, 0, len(names))
	for _, name := range names {
		if name == "powershell" {
			name = "bash"
		}
		if !SelectableToolName.MatchString(name) {
			return nil, fmt.Errorf("invalid tool name %q", name)
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return SortToolNames(out), nil
}

// SortToolNames orders coding tools canonically, then other names
// alphabetically.
func SortToolNames(names []string) []string {
	order := make(map[string]int, len(CanonicalCodingTools))
	for i, name := range CanonicalCodingTools {
		order[name] = i
	}
	out := make([]string, 0, len(names))
	seen := make(map[string]bool, len(names))
	for _, name := range names {
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	sort.SliceStable(out, func(i, j int) bool {
		leftIndex, leftCoding := order[out[i]]
		rightIndex, rightCoding := order[out[j]]
		switch {
		case leftCoding && rightCoding:
			return leftIndex < rightIndex
		case leftCoding:
			return true
		case rightCoding:
			return false
		default:
			return out[i] < out[j]
		}
	})
	return out
}

// NewPresetID returns an id no existing preset file can already hold.
func NewPresetID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "p" + hex.EncodeToString([]byte(fmt.Sprintf("%d", len(buf))))
	}
	return "p" + hex.EncodeToString(buf[:])
}

// LookupSelection resolves a built-in id or custom:<id> selection to its tool
// list. The second result is false when the selection no longer exists.
func LookupSelection(selection string, custom []CustomPreset) (tools []string, includeExtensions bool, ok bool) {
	if strings.HasPrefix(selection, CustomPresetPrefix) {
		id := strings.TrimPrefix(selection, CustomPresetPrefix)
		for _, preset := range custom {
			if preset.ID == id {
				return append([]string(nil), preset.Tools...), preset.IncludeExtensions, true
			}
		}
		return nil, false, false
	}
	preset, found := BuiltinPresetByID(selection)
	if !found {
		return nil, false, false
	}
	if preset.Tools == nil {
		return nil, true, true
	}
	return append([]string(nil), preset.Tools...), true, true
}

// PresetForToolNames infers the preset a live tool selection corresponds to.
// A work mode wins over tool names because plan and read-only share a list.
func PresetForToolNames(tools []string, workMode string, custom []CustomPreset) string {
	switch workMode {
	case "plan":
		return "plan"
	}
	canonical := func(names []string) string {
		parts := make([]string, 0, len(names))
		for _, name := range names {
			if name == "powershell" {
				name = "bash"
			}
			parts = append(parts, name)
		}
		sort.Strings(parts)
		return strings.Join(parts, ",")
	}
	if tools == nil {
		return "configured"
	}
	if len(tools) == 0 {
		return "none"
	}
	key := canonical(tools)
	for _, preset := range custom {
		if canonical(preset.Tools) == key {
			return CustomPresetPrefix + preset.ID
		}
	}
	for _, preset := range BuiltinPresets {
		if preset.Tools == nil || preset.WorkMode != "" {
			continue
		}
		if canonical(preset.Tools) == key {
			return preset.ID
		}
	}
	return "default"
}
