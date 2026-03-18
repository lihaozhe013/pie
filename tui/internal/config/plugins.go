package config

import (
	"fmt"
	"strings"
)

// Package is one pi package entry from settings.json.
type Package struct {
	Source   string
	Disabled bool
	// Filtered marks an object entry that enables at least one resource list.
	// Disabling it would drop those filters, so the caller is told to use the
	// package's own switch instead (the web panel does the same).
	Filtered bool
}

var packageResourceKeys = []string{"extensions", "skills", "prompts", "themes"}

// PackageEntries reads the packages array. A malformed entry is skipped rather
// than guessed at.
func (s *Settings) PackageEntries() ([]Package, error) {
	raw, _, err := s.Packages()
	if err != nil {
		return nil, err
	}
	entries := make([]Package, 0, len(raw))
	for _, value := range raw {
		if source, ok := value.AsString(); ok && strings.TrimSpace(source) != "" {
			entries = append(entries, Package{Source: source})
			continue
		}
		if !value.IsObject() {
			continue
		}
		source, _ := value.Get("source").AsString()
		if strings.TrimSpace(source) == "" {
			continue
		}
		entry := Package{Source: source}
		entry.Disabled = packageDisabled(value)
		entry.Filtered = !entry.Disabled
		entries = append(entries, entry)
	}
	return entries, nil
}

// SetPackageDisabled enables or disables one source. Disabling a filtered entry
// is refused because it would discard the filters; enabling keeps every other
// key (autoload, for instance).
func (s *Settings) SetPackageDisabled(source string, disabled bool) error {
	return s.Update(func(root *Value) error {
		packages := root.Get("packages")
		if packages == nil || !packages.IsArray() {
			return fmt.Errorf("%s does not configure packages", s.path)
		}
		found := false
		for i, value := range packages.Items() {
			if _, ok := value.AsString(); ok {
				if value.StringOr("") != source {
					continue
				}
				found = true
				if !disabled {
					return nil
				}
				replacement, _ := FromAny(map[string]any{
					"source":     source,
					"extensions": []any{},
					"skills":     []any{},
					"prompts":    []any{},
					"themes":     []any{},
				})
				packages.SetIndex(i, replacement)
				continue
			}
			if !value.IsObject() {
				continue
			}
			entrySource, _ := value.Get("source").AsString()
			if entrySource != source {
				continue
			}
			found = true
			filtered := false
			for _, key := range packageResourceKeys {
				list := value.Get(key)
				if list != nil && (!list.IsArray() || len(list.Items()) > 0) {
					filtered = true
				}
			}
			if packageDisabled(value) == disabled {
				return nil
			}
			if disabled && filtered {
				return fmt.Errorf("%s has resource filters; disable it from its own settings instead", source)
			}
			if disabled {
				clone := value.Clone()
				for _, key := range packageResourceKeys {
					clone.Set(key, NewArray())
				}
				packages.SetIndex(i, clone)
				continue
			}
			// Enable: drop the emptied lists, keep the rest.
			remaining := make([]string, 0, len(value.Keys()))
			for _, key := range value.Keys() {
				if key == "extensions" || key == "skills" || key == "prompts" || key == "themes" {
					continue
				}
				remaining = append(remaining, key)
			}
			if len(remaining) == 1 {
				replacement, _ := FromAny(source)
				packages.SetIndex(i, replacement)
				continue
			}
			clone := NewObject()
			for _, key := range value.Keys() {
				if key == "extensions" || key == "skills" || key == "prompts" || key == "themes" {
					continue
				}
				clone.Set(key, value.Get(key).Clone())
			}
			packages.SetIndex(i, clone)
		}
		if !found {
			return fmt.Errorf("%s is not in %s", source, s.path)
		}
		return nil
	})
}

// packageDisabled matches the web panel: every resource list is present and empty.
func packageDisabled(value *Value) bool {
	for _, key := range packageResourceKeys {
		list := value.Get(key)
		if list == nil || !list.IsArray() || len(list.Items()) != 0 {
			return false
		}
	}
	return true
}

// LoadSettingsAt reads a settings file at an explicit path (the project's
// .pi/settings.json).
func LoadSettingsAt(path string) (*Settings, error) {
	doc, err := LoadObject(path)
	if err != nil {
		return nil, err
	}
	return &Settings{path: path, root: doc.Root()}, nil
}
