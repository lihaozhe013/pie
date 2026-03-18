package session

import (
	"encoding/json"

	"github.com/lihaozhe013/pie/tui/internal/config"
)

// Entry types pie writes into the session log.
const (
	ToolSelectionEntryType = "pie:tool-selection"
	WorkModeEntryType      = "pie:work-mode"
)

// LogEntry is one session log entry as `get_entries` returns it. Only the
// fields the client inspects are typed; message entries stay opaque.
type LogEntry struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	CustomType string          `json:"customType"`
	Data       json.RawMessage `json:"data"`
}

// ToolSelection is the newest tool pin a session carries.
type ToolSelection struct {
	Tools          []string
	ExtensionTools string
}

// ReadToolSelection returns the newest valid selection. Absent, cleared, or
// unreadable entries mean the session follows settings.json defaultTools.
func ReadToolSelection(entries []LogEntry) (ToolSelection, bool) {
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		if entry.Type != "custom" || entry.CustomType != ToolSelectionEntryType {
			continue
		}
		var data struct {
			Version        int      `json:"version"`
			Tools          []string `json:"tools"`
			Cleared        bool     `json:"cleared"`
			ExtensionTools string   `json:"extensionTools"`
		}
		if err := json.Unmarshal(entry.Data, &data); err != nil || data.Version != 1 {
			continue
		}
		if data.Cleared {
			return ToolSelection{}, false
		}
		if data.Tools == nil {
			continue
		}
		valid := true
		for _, name := range data.Tools {
			if !config.SelectableToolName.MatchString(name) {
				valid = false
				break
			}
		}
		if !valid {
			continue
		}
		policy := data.ExtensionTools
		if policy != "selected" {
			policy = "all"
		}
		return ToolSelection{Tools: config.SortToolNames(data.Tools), ExtensionTools: policy}, true
	}
	return ToolSelection{}, false
}

// ReadWorkMode returns the newest valid work mode, or "" when the session has
// none. Task modes are parsed so a plan entry behind them is not mistaken for
// the current mode, but only plan changes terminal behavior.
func ReadWorkMode(entries []LogEntry) string {
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		if entry.Type != "custom" || entry.CustomType != WorkModeEntryType {
			continue
		}
		var data struct {
			Version int     `json:"version"`
			Mode    *string `json:"mode"`
		}
		if err := json.Unmarshal(entry.Data, &data); err != nil || data.Version != 1 {
			continue
		}
		if data.Mode == nil {
			return ""
		}
		switch *data.Mode {
		case "plan", "autonomous", "orchestrator":
			return *data.Mode
		}
	}
	return ""
}
