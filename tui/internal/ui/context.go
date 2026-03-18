package ui

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

type contextViewMsg struct{ err error }

// openContext asks the bridge for the live prompt and tool inventory and shows
// it. The bridge is the only source: pi's RPC has no get_system_prompt or
// get_tools command.
func (m *Model) openContext() tea.Cmd {
	if !m.bridgeReady {
		m.showContextPanel()
		return nil
	}
	m.pendingContext = true
	if m.toolSnapshot != nil {
		m.showContextPanel()
	}
	return m.loadToolSnapshot()
}

func (m *Model) showContextPanel() {
	tab := settingsTab{ID: "context", Label: "Context"}
	if !m.bridgeReady {
		tab.Rows = []settingsRow{
			{ID: "context-bridge", Label: "Bridge", Kind: settingsInfo, Current: func() string { return "unavailable" }},
			{ID: "context-hint", Label: "Why", Kind: settingsInfo, Current: func() string {
				return "The system prompt and tool list are read through pie's bridge extension."
			}},
		}
	} else if m.toolSnapshot == nil {
		tab.Rows = []settingsRow{
			{ID: "context-loading", Label: "Loading", Kind: settingsInfo, Current: func() string { return "reading via /pie-publish…" }},
			{ID: "context-refresh", Label: "Refresh", Kind: settingsAction, Run: func(m *Model, s *settingsState) tea.Cmd {
				m.pendingContext = true
				return m.loadToolSnapshot()
			}},
		}
	} else {
		snapshot := m.toolSnapshot
		active := 0
		for _, tool := range snapshot.Tools {
			if tool.Active {
				active++
			}
		}
		lines := strings.Count(snapshot.SystemPrompt, "\n") + 1
		tab.Rows = []settingsRow{
			{ID: "context-tools", Label: "Tools", Kind: settingsInfo, Current: func() string {
				return fmt.Sprintf("%d active · %d defined", active, len(snapshot.Tools))
			}},
			{ID: "context-prompt", Label: "System prompt", Kind: settingsInfo, Current: func() string {
				return fmt.Sprintf("%d lines · %d bytes", lines, len(snapshot.SystemPrompt))
			}},
			{ID: "context-mode", Label: "Work mode", Kind: settingsInfo, Current: func() string {
				if snapshot.WorkMode == "" {
					return "default"
				}
				return snapshot.WorkMode
			}},
			{ID: "context-view", Label: "View system prompt", Kind: settingsAction, Help: "Opens $PAGER on a temporary copy.", Run: func(m *Model, s *settingsState) tea.Cmd {
				return m.viewText("pie-system-prompt.md", snapshot.SystemPrompt)
			}},
			{ID: "context-refresh", Label: "Refresh", Kind: settingsAction, Run: func(m *Model, s *settingsState) tea.Cmd {
				m.pendingContext = true
				return m.loadToolSnapshot()
			}},
		}
		for _, tool := range snapshot.Tools {
			tool := tool
			state := "inactive"
			if tool.Active {
				state = "active"
			}
			tab.Rows = append(tab.Rows, settingsRow{
				ID:      "tool-" + tool.Name,
				Label:   tool.Name,
				Kind:    settingsInfo,
				Current: func() string { return state },
				Help:    tool.Description,
			})
		}
	}
	panel := newSettingsPanel("Context", []settingsTab{tab})
	panel.action = "context"
	m.settingsPanel = panel
	m.openOverlay(&overlay{kind: overlaySettings, action: "context", settings: panel})
}

func (m *Model) viewText(name, text string) tea.Cmd {
	if strings.TrimSpace(text) == "" {
		m.setToast("nothing to show")
		return nil
	}
	file, err := os.CreateTemp("", "pie-*"+name)
	if err != nil {
		m.addError("temp file: " + err.Error())
		return nil
	}
	if _, err := file.WriteString(text); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		m.addError("temp file: " + err.Error())
		return nil
	}
	_ = file.Close()
	pager := strings.TrimSpace(os.Getenv("PAGER"))
	if pager == "" {
		pager = "less"
	}
	fields := strings.Fields(pager)
	command := exec.Command(fields[0], append(fields[1:], file.Name())...)
	return tea.ExecProcess(command, func(err error) tea.Msg {
		_ = os.Remove(file.Name())
		return contextViewMsg{err: err}
	})
}
