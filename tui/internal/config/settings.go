package config

import (
	"fmt"
	"strings"
)

// ThinkingLevels are the levels pi accepts in settings and on the command
// line, from least to most reasoning.
var ThinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

// IsThinkingLevel reports whether level is a known thinking level.
func IsThinkingLevel(level string) bool {
	for _, known := range ThinkingLevels {
		if level == known {
			return true
		}
	}
	return false
}

// TypeError reports a shared file whose key has the wrong JSON type.
type TypeError struct {
	Path     string
	Key      string
	Expected string
	Got      Kind
}

func (e *TypeError) Error() string {
	return fmt.Sprintf("%s: %q must be %s", e.Path, e.Key, e.Expected)
}

// Settings is a snapshot of settings.json. Reads use the snapshot; every write
// reloads under the lock so a concurrent pie or pi edit is not overwritten.
type Settings struct {
	path string
	root *Value
}

// LoadSettings reads settings.json. A missing file is an empty object.
func LoadSettings(paths Paths) (*Settings, error) {
	doc, err := LoadObject(paths.Settings())
	if err != nil {
		return nil, err
	}
	return &Settings{path: paths.Settings(), root: doc.Root()}, nil
}

// Path returns the settings file path.
func (s *Settings) Path() string { return s.path }

// Root returns the current tree.
func (s *Settings) Root() *Value { return s.root }

// Reload refreshes the snapshot from disk.
func (s *Settings) Reload() error {
	doc, err := LoadObject(s.path)
	if err != nil {
		return err
	}
	s.root = doc.Root()
	return nil
}

// Update applies fn to a freshly loaded settings object and writes it back.
func (s *Settings) Update(fn func(root *Value) error) error {
	if err := Update(s.path, fn); err != nil {
		return err
	}
	return s.Reload()
}

// Get returns a raw member.
func (s *Settings) Get(key string) *Value { return s.root.Get(key) }

// DefaultProvider returns the configured startup provider.
func (s *Settings) DefaultProvider() (string, error) {
	return s.stringValue("defaultProvider")
}

// DefaultModel returns the configured startup model.
func (s *Settings) DefaultModel() (string, error) {
	return s.stringValue("defaultModel")
}

// DefaultThinkingLevel returns the configured startup thinking level, or
// "medium" when unset, matching pi.
func (s *Settings) DefaultThinkingLevel() (string, error) {
	level, err := s.stringValue("defaultThinkingLevel")
	if err != nil {
		return "", err
	}
	if level == "" {
		return "medium", nil
	}
	return level, nil
}

func (s *Settings) stringValue(key string) (string, error) {
	value := s.root.Get(key)
	if value == nil {
		return "", nil
	}
	text, ok := value.AsString()
	if !ok {
		return "", &TypeError{Path: s.path, Key: key, Expected: "a string", Got: value.Kind()}
	}
	return text, nil
}

// EnabledModels returns the model patterns from enabledModels. The second
// result reports whether the key exists; absent means every model is enabled.
func (s *Settings) EnabledModels() ([]string, bool, error) {
	return s.stringSlice("enabledModels")
}

// Skills returns the explicit skill files or directories from settings.json.
func (s *Settings) Skills() ([]string, error) {
	items, _, err := s.stringSlice("skills")
	return items, err
}

// DefaultTools returns the raw defaultTools entries, including +name and
// -name modifiers. Absent means pi's built-in defaults.
func (s *Settings) DefaultTools() ([]string, bool, error) {
	return s.stringSlice("defaultTools")
}

func (s *Settings) stringSlice(key string) ([]string, bool, error) {
	value := s.root.Get(key)
	if value == nil {
		return nil, false, nil
	}
	items, ok := value.AsStrings()
	if !ok {
		return nil, true, &TypeError{Path: s.path, Key: key, Expected: "an array of strings", Got: value.Kind()}
	}
	return items, true, nil
}

// ModelThinkingLevels returns the per-model startup thinking levels keyed by
// exact "provider/model".
func (s *Settings) ModelThinkingLevels() (map[string]string, error) {
	value := s.root.Get("modelThinkingLevels")
	if value == nil {
		return nil, nil
	}
	if !value.IsObject() {
		return nil, &TypeError{Path: s.path, Key: "modelThinkingLevels", Expected: "an object", Got: value.Kind()}
	}
	out := make(map[string]string, value.Len())
	for _, key := range value.Keys() {
		level, ok := value.Get(key).AsString()
		if !ok {
			return nil, &TypeError{Path: s.path, Key: "modelThinkingLevels." + key, Expected: "a string", Got: value.Get(key).Kind()}
		}
		out[key] = level
	}
	return out, nil
}

// ShowCacheMissNotices reports whether pi shows cache-miss notices.
func (s *Settings) ShowCacheMissNotices() (bool, error) {
	value := s.root.Get("showCacheMissNotices")
	if value == nil {
		return false, nil
	}
	flag, ok := value.AsBool()
	if !ok {
		return false, &TypeError{Path: s.path, Key: "showCacheMissNotices", Expected: "a boolean", Got: value.Kind()}
	}
	return flag, nil
}

// SessionDir returns the configured session directory and whether it is set.
func (s *Settings) SessionDir() (string, bool, error) {
	value := s.root.Get("sessionDir")
	if value == nil {
		return "", false, nil
	}
	dir, ok := value.AsString()
	if !ok {
		return "", false, &TypeError{Path: s.path, Key: "sessionDir", Expected: "a string", Got: value.Kind()}
	}
	return dir, dir != "", nil
}

// Packages returns the pi package entries as raw values; an entry may be a
// source string or an object.
func (s *Settings) Packages() ([]*Value, bool, error) {
	value := s.root.Get("packages")
	if value == nil {
		return nil, false, nil
	}
	if !value.IsArray() {
		return nil, true, &TypeError{Path: s.path, Key: "packages", Expected: "an array", Got: value.Kind()}
	}
	return value.Items(), true, nil
}

// SetEnabledModels replaces enabledModels. An empty slice writes [], which
// enables no models; use ClearEnabledModels to fall back to every model.
func (s *Settings) SetEnabledModels(models []string) error {
	for _, model := range models {
		if strings.TrimSpace(model) == "" {
			return fmt.Errorf("enabledModels: empty model pattern")
		}
	}
	return s.Update(func(root *Value) error {
		root.SetStrings("enabledModels", models)
		return nil
	})
}

// ClearEnabledModels removes the key so pi enables every model again.
func (s *Settings) ClearEnabledModels() error {
	return s.Update(func(root *Value) error {
		root.Delete("enabledModels")
		return nil
	})
}

// SetModelThinkingLevel saves a per-model startup level.
func (s *Settings) SetModelThinkingLevel(modelKey, level string) error {
	if modelKey == "" {
		return fmt.Errorf("modelThinkingLevels: empty model key")
	}
	if !IsThinkingLevel(level) {
		return fmt.Errorf("modelThinkingLevels: unknown thinking level %q", level)
	}
	return s.Update(func(root *Value) error {
		levels := root.Get("modelThinkingLevels")
		if levels == nil || !levels.IsObject() {
			levels = NewObject()
			root.Set("modelThinkingLevels", levels)
		}
		levels.SetString(modelKey, level)
		return nil
	})
}

// ClearModelThinkingLevel removes one model's saved level.
func (s *Settings) ClearModelThinkingLevel(modelKey string) error {
	return s.Update(func(root *Value) error {
		if levels := root.Get("modelThinkingLevels"); levels != nil && levels.IsObject() {
			levels.Delete(modelKey)
			if levels.Len() == 0 {
				root.Delete("modelThinkingLevels")
			}
		}
		return nil
	})
}

// SetShowCacheMissNotices toggles pi's cache-miss notices. Off is pi's default,
// so it removes the key rather than storing false, as Pie does.
func (s *Settings) SetShowCacheMissNotices(enabled bool) error {
	return s.Update(func(root *Value) error {
		if !enabled {
			root.Delete("showCacheMissNotices")
			return nil
		}
		root.SetBool("showCacheMissNotices", true)
		return nil
	})
}

// SetSessionDir pins the session storage directory. An empty value removes
// the key.
func (s *Settings) SetSessionDir(dir string) error {
	return s.Update(func(root *Value) error {
		if dir == "" {
			root.Delete("sessionDir")
			return nil
		}
		root.SetString("sessionDir", dir)
		return nil
	})
}

// SetDefaultProvider saves the startup provider.
func (s *Settings) SetDefaultProvider(provider string) error {
	return s.Update(func(root *Value) error {
		if provider == "" {
			root.Delete("defaultProvider")
			return nil
		}
		root.SetString("defaultProvider", provider)
		return nil
	})
}

// SetDefaultModel saves the startup model.
func (s *Settings) SetDefaultModel(model string) error {
	return s.Update(func(root *Value) error {
		if model == "" {
			root.Delete("defaultModel")
			return nil
		}
		root.SetString("defaultModel", model)
		return nil
	})
}

// SetDefaultThinkingLevel saves the startup thinking level.
func (s *Settings) SetDefaultThinkingLevel(level string) error {
	if !IsThinkingLevel(level) {
		return fmt.Errorf("defaultThinkingLevel: unknown level %q", level)
	}
	return s.Update(func(root *Value) error {
		root.SetString("defaultThinkingLevel", level)
		return nil
	})
}

// SetDefaultTools replaces the defaultTools entries, including +name and
// -name modifiers. An empty slice writes [], which disables the built-in tools.
func (s *Settings) SetDefaultTools(entries []string) error {
	for _, entry := range entries {
		if strings.TrimSpace(entry) == "" {
			return fmt.Errorf("defaultTools: empty entry")
		}
	}
	return s.Update(func(root *Value) error {
		root.SetStrings("defaultTools", entries)
		return nil
	})
}

// ClearDefaultTools removes the key so pi's defaults apply.
func (s *Settings) ClearDefaultTools() error {
	return s.Update(func(root *Value) error {
		root.Delete("defaultTools")
		return nil
	})
}
