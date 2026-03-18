package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// File names in the agent directory. The first group is shared with pie and
// pi; the last file holds terminal-only preferences.
const (
	SettingsName      = "settings.json"
	ModelsName        = "models.json"
	AuthName          = "auth.json"
	MCPName           = "mcp.json"
	AgentsName        = "AGENTS.md"
	PresetsName       = "pie-tool-presets.json"
	ModelSettingsName = "pie-model-settings.json"
	TUIConfigName     = "pie-settings.json"
)

const (
	// AgentDirEnv overrides pi's agent directory.
	AgentDirEnv = "PI_CODING_AGENT_DIR"
	// defaultAgentDir is the fallback under the home directory.
	defaultAgentDir = ".pi/agent"

	// maxConfigBytes caps a configuration file so a runaway path cannot make
	// the client allocate without bound.
	maxConfigBytes = 32 << 20

	lockTimeout     = 3 * time.Second
	lockStale       = 10 * time.Second
	lockPoll        = 25 * time.Millisecond
	defaultFileMode = 0o600
)

// Paths resolves every shared configuration file from one agent directory.
type Paths struct {
	// Dir is the agent directory, for example ~/.pi/agent.
	Dir string
}

// ResolvePaths locates the agent directory: PI_CODING_AGENT_DIR when set,
// otherwise ~/.pi/agent.
func ResolvePaths() (Paths, error) {
	dir := strings.TrimSpace(os.Getenv(AgentDirEnv))
	if dir != "" {
		expanded, err := expandHome(dir)
		if err != nil {
			return Paths{}, err
		}
		return Paths{Dir: expanded}, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, fmt.Errorf("resolve home directory: %w", err)
	}
	return Paths{Dir: filepath.Join(home, filepath.FromSlash(defaultAgentDir))}, nil
}

// MustPaths is ResolvePaths for callers that already handle the error, such as
// tests and the UI bootstrap.
func MustPaths() Paths {
	paths, err := ResolvePaths()
	if err != nil {
		return Paths{Dir: "."}
	}
	return paths
}

func expandHome(path string) (string, error) {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home directory: %w", err)
		}
		if path == "~" {
			return home, nil
		}
		return filepath.Join(home, path[2:]), nil
	}
	return path, nil
}

// Settings returns the path of settings.json.
func (p Paths) Settings() string { return filepath.Join(p.Dir, SettingsName) }

// Models returns the path of models.json.
func (p Paths) Models() string { return filepath.Join(p.Dir, ModelsName) }

// Auth returns the path of auth.json.
func (p Paths) Auth() string { return filepath.Join(p.Dir, AuthName) }

// MCP returns the path of the global mcp.json.
func (p Paths) MCP() string { return filepath.Join(p.Dir, MCPName) }

// Agents returns the path of the global AGENTS.md.
func (p Paths) Agents() string { return filepath.Join(p.Dir, AgentsName) }

// Presets returns the path of pie-tool-presets.json.
func (p Paths) Presets() string { return filepath.Join(p.Dir, PresetsName) }

// ModelSettings returns the path of pie-model-settings.json.
func (p Paths) ModelSettings() string { return filepath.Join(p.Dir, ModelSettingsName) }

// TUIConfig returns the path of the terminal-only preferences file.
func (p Paths) TUIConfig() string { return filepath.Join(p.Dir, TUIConfigName) }

// Sessions returns the default session directory under the agent directory.
func (p Paths) Sessions() string { return filepath.Join(p.Dir, "sessions") }

// Document is one configuration file held as an ordered JSON tree.
type Document struct {
	path    string
	root    *Value
	existed bool
}

// Path returns the document's file path.
func (d *Document) Path() string { return d.path }

// Root returns the parsed tree. It is never nil.
func (d *Document) Root() *Value { return d.root }

// Existed reports whether the file existed when it was loaded.
func (d *Document) Existed() bool { return d.existed }

// Load reads and parses a configuration file. A missing or empty file is an
// empty object. Unparsable content returns a *SyntaxError and leaves the file
// untouched; a corrupt file is never silently replaced.
func Load(path string) (*Document, error) {
	root, existed, err := loadRoot(path)
	if err != nil {
		return nil, err
	}
	return &Document{path: path, root: root, existed: existed}, nil
}

// LoadObject is Load with the guarantee that the root is an object. Files
// whose root is an array or scalar are refused, because every shared pi file
// is an object.
func LoadObject(path string) (*Document, error) {
	doc, err := Load(path)
	if err != nil {
		return nil, err
	}
	if !doc.root.IsObject() {
		return nil, &SyntaxError{Path: path, Err: errors.New("expected a JSON object")}
	}
	return doc, nil
}

func loadRoot(path string) (*Value, bool, error) {
	data, existed, err := readConfigFile(path)
	if err != nil {
		return nil, existed, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return NewObject(), existed, nil
	}
	root, err := Parse(data)
	if err != nil {
		var syntax *SyntaxError
		if errors.As(err, &syntax) {
			syntax.Path = path
			syntax.Backup, _ = backupCorrupt(path)
		}
		return nil, existed, err
	}
	return root, existed, nil
}

// readConfigFile reads at most maxConfigBytes from a regular file. Symbolic
// links are followed.
func readConfigFile(path string) ([]byte, bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, err
	}
	if !info.Mode().IsRegular() {
		return nil, true, fmt.Errorf("%s: not a regular file", path)
	}
	if info.Size() > maxConfigBytes {
		return nil, true, fmt.Errorf("%s: file is too large (%d bytes)", path, info.Size())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, true, err
	}
	return data, true, nil
}

// backupCorrupt copies an unparsable file aside so the user can recover it,
// and returns the backup path.
func backupCorrupt(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	suffix := time.Now().Format("20060102-150405")
	backup := path + ".corrupt-" + suffix
	for i := 1; ; i++ {
		if _, err := os.Stat(backup); errors.Is(err, os.ErrNotExist) {
			break
		}
		backup = fmt.Sprintf("%s.corrupt-%s-%d", path, suffix, i)
	}
	if err := os.WriteFile(backup, data, defaultFileMode); err != nil {
		return "", err
	}
	return backup, nil
}

// Save writes the document's current tree under the shared lock. It refuses to
// replace a file that cannot be parsed.
//
// ReplaceRecovering is the opt-in exception for files pie owns and resets.
func (d *Document) Save() error {
	return d.replace(d.root)
}

// Replace writes an arbitrary tree, keeping the file's parse guard.
func (d *Document) Replace(root *Value) error {
	return d.replace(root)
}

func (d *Document) replace(root *Value) error {
	if root == nil {
		root = NewObject()
	}
	release, err := acquireLock(d.path)
	if err != nil {
		return err
	}
	defer release()

	if _, _, err := loadRoot(d.path); err != nil {
		return fmt.Errorf("refusing to overwrite %s: %w", d.path, err)
	}
	if err := writeFileAtomic(d.path, Marshal(root), defaultFileMode); err != nil {
		return err
	}
	d.root = root
	d.existed = true
	return nil
}

// ReplaceRecovering writes a whole tree, setting aside an unparsable file
// first instead of refusing. It is for the files pie owns and treats this way,
// such as its custom tool presets; an I/O error still aborts.
func (d *Document) ReplaceRecovering(root *Value) error {
	if root == nil {
		root = NewObject()
	}
	release, err := acquireLock(d.path)
	if err != nil {
		return err
	}
	defer release()

	if _, _, err := loadRoot(d.path); err != nil {
		var syntax *SyntaxError
		if !errors.As(err, &syntax) || syntax.Backup == "" {
			return fmt.Errorf("refusing to overwrite %s: %w", d.path, err)
		}
	}
	if err := writeFileAtomic(d.path, Marshal(root), defaultFileMode); err != nil {
		return err
	}
	d.root = root
	d.existed = true
	return nil
}

// Update applies mutate to a freshly loaded tree under the lock, then writes
// it. Reading under the lock keeps a concurrent pie or pi write from being
// overwritten with stale values.
func Update(path string, mutate func(root *Value) error) error {
	release, err := acquireLock(path)
	if err != nil {
		return err
	}
	defer release()

	root, existed, err := loadRoot(path)
	if err != nil {
		return err
	}
	if !root.IsObject() {
		return &SyntaxError{Path: path, Err: errors.New("expected a JSON object")}
	}
	if err := mutate(root); err != nil {
		return err
	}
	content := Marshal(root)
	if existed {
		if current, readErr := os.ReadFile(path); readErr == nil && string(current) == string(content) {
			return nil
		}
	}
	return writeFileAtomic(path, content, defaultFileMode)
}

// acquireLock takes a cross-process lock beside path. The lock is a file
// created with O_EXCL holding the owner's pid and start time; a lock older
// than lockStale is removed so a crashed process cannot block edits forever.
func acquireLock(path string) (func(), error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("create %s: %w", dir, err)
		}
	}
	lockPath := path + ".lock"
	deadline := time.Now().Add(lockTimeout)
	for {
		file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, defaultFileMode)
		if err == nil {
			fmt.Fprintf(file, "%d\n%d\n", os.Getpid(), time.Now().UnixNano())
			_ = file.Close()
			return func() { _ = os.Remove(lockPath) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("lock %s: %w", path, err)
		}
		if info, statErr := os.Stat(lockPath); statErr == nil && time.Since(info.ModTime()) > lockStale {
			_ = os.Remove(lockPath)
			continue
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("lock %s: timed out after %s", path, lockTimeout)
		}
		time.Sleep(lockPoll)
	}
}

// writeFileAtomic writes data to a temporary file in the destination directory
// and renames it over path, following a symbolic link so a dotfiles setup keeps
// working. The file is private regardless of the umask.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	target := path
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			return fmt.Errorf("resolve %s: %w", path, err)
		}
		target = resolved
	}
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	temp, err := os.CreateTemp(dir, "."+filepath.Base(target)+".tmp-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer func() { _ = os.Remove(tempName) }()
	if err := temp.Chmod(mode); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempName, target); err != nil {
		return err
	}
	syncDir(dir)
	return nil
}

// ReadText reads a plain text configuration file such as AGENTS.md. A missing
// file reads as empty.
func ReadText(path string) (string, error) {
	data, _, err := readConfigFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// WriteText replaces a plain text configuration file atomically.
func WriteText(path, text string) error {
	release, err := acquireLock(path)
	if err != nil {
		return err
	}
	defer release()
	return writeFileAtomic(path, []byte(text), defaultFileMode)
}
