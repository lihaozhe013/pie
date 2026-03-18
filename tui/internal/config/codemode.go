package config

import (
	"fmt"
	"strings"
)

// CodemodeInlineBudgetMax is the largest inline budget pie's settings accept.
const CodemodeInlineBudgetMax = 1_000_000

// pi's built-in tool list, used only to resolve a defaultTools list that holds
// modifiers without plain names. Codemode detection is the caller here.
var piDefaultTools = []string{"read", "bash", "edit", "write"}

// ResolveDefaultTools applies pi's rule: plain names replace the defaults, then
// +name adds and -name removes, in order.
func ResolveDefaultTools(entries []string) []string {
	plain := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !strings.HasPrefix(entry, "+") && !strings.HasPrefix(entry, "-") {
			plain = append(plain, entry)
		}
	}
	tools := plain
	if len(plain) == 0 && len(entries) > 0 {
		tools = append([]string{}, piDefaultTools...)
	}
	for _, entry := range entries {
		if len(entry) < 2 || (entry[0] != '+' && entry[0] != '-') {
			continue
		}
		name := entry[1:]
		index := -1
		for i, tool := range tools {
			if tool == name {
				index = i
				break
			}
		}
		if entry[0] == '+' && index < 0 {
			tools = append(tools, name)
		} else if entry[0] == '-' && index >= 0 {
			tools = append(tools[:index], tools[index+1:]...)
		}
	}
	return tools
}

// CodemodePreference reports "always" when a new session starts with codemode
// active, "automatic" otherwise.
func (s *Settings) CodemodePreference() (string, error) {
	entries, present, err := s.DefaultTools()
	if err != nil || !present {
		return "automatic", err
	}
	for _, tool := range ResolveDefaultTools(entries) {
		if tool == "codemode" {
			return "always", nil
		}
	}
	return "automatic", nil
}

// WithCodemodePreference edits defaultTools minimally. The second result is
// false when the key should be removed instead of written.
func WithCodemodePreference(entries []string, present bool, preference string) ([]string, bool, error) {
	if preference != "automatic" && preference != "always" {
		return nil, false, fmt.Errorf("codemode: unknown preference %q", preference)
	}
	kept := make([]string, 0, len(entries))
	hasPlain := false
	for _, entry := range entries {
		name := strings.TrimPrefix(strings.TrimPrefix(entry, "+"), "-")
		if name == "codemode" {
			continue
		}
		if !strings.HasPrefix(entry, "+") && !strings.HasPrefix(entry, "-") {
			hasPlain = true
		}
		kept = append(kept, entry)
	}
	if preference == "always" {
		return append(kept, "+codemode"), true, nil
	}
	if len(kept) > 0 {
		return kept, true, nil
	}
	if present && hasPlain {
		return []string{}, true, nil
	}
	return nil, false, nil
}

// SetCodemodePreference writes the defaultTools key for a preference.
func (s *Settings) SetCodemodePreference(preference string) error {
	entries, present, err := s.DefaultTools()
	if err != nil {
		return err
	}
	next, keep, err := WithCodemodePreference(entries, present, preference)
	if err != nil {
		return err
	}
	if !keep {
		return s.ClearDefaultTools()
	}
	return s.SetDefaultTools(next)
}

// CodemodeMode returns "on" (pi's default) or "only".
func (s *Settings) CodemodeMode() (string, error) {
	value := s.root.GetPath("codemode", "mode")
	if value == nil {
		return "on", nil
	}
	mode, ok := value.AsString()
	if !ok || (mode != "on" && mode != "only") {
		return "", &TypeError{Path: s.path, Key: "codemode.mode", Expected: `"on" or "only"`, Got: value.Kind()}
	}
	return mode, nil
}

// SetCodemodeMode writes codemode.mode; "on" deletes the key because it is
// pi's default.
func (s *Settings) SetCodemodeMode(mode string) error {
	if mode != "on" && mode != "only" {
		return fmt.Errorf("codemode.mode: unknown mode %q", mode)
	}
	return s.Update(func(root *Value) error {
		if mode == "on" {
			if object := root.Get("codemode"); object != nil && object.IsObject() {
				object.Delete("mode")
			}
			return nil
		}
		object := root.Get("codemode")
		if object == nil || !object.IsObject() {
			object = NewObject()
			root.Set("codemode", object)
		}
		object.SetString("mode", "only")
		return nil
	})
}

// CodemodeInlineBudget returns the saved budget and whether it is set.
func (s *Settings) CodemodeInlineBudget() (int, bool, error) {
	value := s.root.GetPath("codemode", "inlineBudget")
	if value == nil {
		return 0, false, nil
	}
	budget, ok := value.AsInt()
	if !ok || budget < 0 || budget > CodemodeInlineBudgetMax {
		return 0, true, &TypeError{Path: s.path, Key: "codemode.inlineBudget", Expected: "a whole number from 0 to 1000000", Got: value.Kind()}
	}
	return budget, true, nil
}

// SetCodemodeInlineBudget writes the budget, or deletes it when budget is nil.
func (s *Settings) SetCodemodeInlineBudget(budget *int) error {
	if budget != nil && (*budget < 0 || *budget > CodemodeInlineBudgetMax) {
		return fmt.Errorf("codemode.inlineBudget: out of range")
	}
	return s.Update(func(root *Value) error {
		if budget == nil {
			if object := root.Get("codemode"); object != nil && object.IsObject() {
				object.Delete("inlineBudget")
			}
			return nil
		}
		object := root.Get("codemode")
		if object == nil || !object.IsObject() {
			object = NewObject()
			root.Set("codemode", object)
		}
		object.SetNumber("inlineBudget", float64(*budget))
		return nil
	})
}
