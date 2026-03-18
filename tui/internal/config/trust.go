package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// trustRequiringResources are the project resources pi refuses to load until
// the folder is trusted, from pi's trust manager.
var trustRequiringResources = []string{
	"settings.json",
	"mcp.json",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
}

// ProjectRequiresTrust reports whether the project has trust-requiring
// resources under .pi.
func ProjectRequiresTrust(cwd string) bool {
	for _, name := range trustRequiringResources {
		if _, err := os.Stat(filepath.Join(cwd, ".pi", name)); err == nil {
			return true
		}
	}
	return false
}

// ProjectTrusted resolves trust.json's nearest decision for cwd. Pi inherits a
// parent folder's decision and a null value continues the search upward. A
// missing store means no decision, which is untrusted.
func ProjectTrusted(agentDir, cwd string) (bool, error) {
	path := filepath.Join(agentDir, "trust.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	var store map[string]json.RawMessage
	if err := json.Unmarshal(data, &store); err != nil {
		return false, err
	}
	decisions := make(map[string]bool, len(store))
	for key, raw := range store {
		var value bool
		if err := json.Unmarshal(raw, &value); err != nil {
			// null and invalid values do not decide; pi only accepts booleans.
			continue
		}
		decisions[canonicalPath(key)] = value
	}
	current := canonicalPath(cwd)
	for {
		if decision, ok := decisions[current]; ok {
			return decision, nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			return false, nil
		}
		current = parent
	}
}

func canonicalPath(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		absolute = path
	}
	current := absolute
	var missing []string
	for {
		if resolved, err := filepath.EvalSymlinks(current); err == nil {
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}
			return filepath.Clean(resolved)
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		missing = append(missing, filepath.Base(current))
		current = parent
	}
	return filepath.Clean(absolute)
}
