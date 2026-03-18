package config

import "fmt"

var shellTools = []string{"bash", "powershell"}

// ReplaceShellTool swaps bash and powershell in a resolved tool list, keeping
// the first occurrence and dropping duplicates.
func ReplaceShellTool(tools []string, usePowerShell bool) []string {
	shell := "bash"
	if usePowerShell {
		shell = "powershell"
	}
	seen := make(map[string]bool, len(tools))
	out := make([]string, 0, len(tools))
	for _, name := range tools {
		next := name
		if name == "bash" || name == "powershell" {
			next = shell
		}
		if seen[next] {
			continue
		}
		seen[next] = true
		out = append(out, next)
	}
	return out
}

// PowerShellEnabled reports Pie's rule: on Windows, the resolved default tools
// contain powershell and not bash.
func (s *Settings) PowerShellEnabled(platform string) (bool, error) {
	if platform != "windows" {
		return false, nil
	}
	entries, present, err := s.DefaultTools()
	if err != nil {
		return false, err
	}
	tools := append([]string{}, piDefaultTools...)
	if present {
		tools = ResolveDefaultTools(entries)
	}
	hasPowerShell := false
	for _, tool := range tools {
		if tool == "powershell" {
			hasPowerShell = true
		}
		if tool == "bash" {
			return false, nil
		}
	}
	return hasPowerShell, nil
}

// SetPowerShellEnabled resolves the current tools, swaps the shell tool, and
// writes the resulting plain list so a modifier-only list keeps pi's defaults.
func (s *Settings) SetPowerShellEnabled(enabled bool) error {
	entries, present, err := s.DefaultTools()
	if err != nil {
		return err
	}
	tools := append([]string{}, piDefaultTools...)
	if present {
		tools = ResolveDefaultTools(entries)
	}
	next := ReplaceShellTool(tools, enabled)
	if !hasAnyTool(next, shellTools) {
		if enabled {
			next = append(next, "powershell")
		} else {
			next = append(next, "bash")
		}
	}
	if len(next) == 0 {
		return fmt.Errorf("powershell: the tool list would be empty")
	}
	return s.SetDefaultTools(next)
}

func hasAnyTool(tools []string, names []string) bool {
	for _, tool := range tools {
		for _, name := range names {
			if tool == name {
				return true
			}
		}
	}
	return false
}
