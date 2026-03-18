package config

import (
	"fmt"
	"strings"
)

// DefaultContextWindowLimit is the cap applied when pie-model-settings.json has
// never configured one. Models with a larger native window run as if they were
// this size.
const DefaultContextWindowLimit = 350_000

// ModelSettings is a snapshot of pie-model-settings.json, pie's own model
// settings file beside pi's.
type ModelSettings struct {
	path string
	root *Value
}

// LoadModelSettings reads pie-model-settings.json. A missing file reads as an
// empty object.
func LoadModelSettings(paths Paths) (*ModelSettings, error) {
	doc, err := LoadObject(paths.ModelSettings())
	if err != nil {
		return nil, err
	}
	return &ModelSettings{path: paths.ModelSettings(), root: doc.Root()}, nil
}

// Path returns the file path.
func (m *ModelSettings) Path() string { return m.path }

// Root returns the current tree.
func (m *ModelSettings) Root() *Value { return m.root }

// ContextWindowLimit returns the saved cap and whether a cap applies. A
// missing key, an invalid value, or an unreadable value reads as the
// first-install default; an explicit null is the blank save that means "no
// cap". Those two states are distinct in the file and in this result.
func (m *ModelSettings) ContextWindowLimit() (int, bool) {
	value := m.root.Get("contextWindowLimit")
	if value == nil {
		return DefaultContextWindowLimit, true
	}
	if value.IsNull() {
		return 0, false
	}
	limit, ok := parseContextWindow(value)
	if !ok {
		return DefaultContextWindowLimit, true
	}
	return limit, true
}

// ContextWindowConfigured reports whether the file names the key at all.
func (m *ModelSettings) ContextWindowConfigured() bool {
	return m.root.Has("contextWindowLimit")
}

// SetContextWindowLimit saves a cap, or writes a literal null when limit is
// nil. Other keys in the file survive.
func (m *ModelSettings) SetContextWindowLimit(limit *int) error {
	if limit != nil && *limit <= 0 {
		return fmt.Errorf("contextWindowLimit must be positive")
	}
	err := Update(m.path, func(root *Value) error {
		if limit == nil {
			root.Set("contextWindowLimit", NewNull())
			return nil
		}
		root.SetNumber("contextWindowLimit", float64(*limit))
		return nil
	})
	if err != nil {
		return err
	}
	return m.Reload()
}

// Reload refreshes the snapshot.
func (m *ModelSettings) Reload() error {
	doc, err := LoadObject(m.path)
	if err != nil {
		return err
	}
	m.root = doc.Root()
	return nil
}

// parseContextWindow accepts a positive integer or a numeric string, matching
// pie's parser.
func parseContextWindow(value *Value) (int, bool) {
	if n, ok := value.AsInt(); ok && n > 0 {
		return n, true
	}
	if text, ok := value.AsString(); ok {
		text = strings.TrimSpace(strings.ReplaceAll(text, ",", ""))
		var n int
		if _, err := fmt.Sscanf(text, "%d", &n); err == nil && n > 0 {
			return n, true
		}
	}
	return 0, false
}
