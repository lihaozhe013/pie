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
		rows := []settingsRow{
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
			{ID: "context-view", Label: "View system prompt", Kind: settingsAction, Help: "Opens a read-only page; y copies the whole prompt.", Run: func(m *Model, s *settingsState) tea.Cmd {
				return m.viewSystemPrompt("System prompt", snapshot.SystemPrompt)
			}},
		}
		// The external pager is an extra, not a requirement: the page above always
		// works, and this row exists only when one is actually installed.
		if pager, ok := resolvePager(); ok {
			rows = append(rows, settingsRow{
				ID:    "context-pager",
				Label: "Open in " + pager.name,
				Help:  "Shows the prompt in " + pager.name + " and returns here when it exits.",
				Kind:  settingsAction,
				Run: func(m *Model, s *settingsState) tea.Cmd {
					return m.pagerText("system-prompt.md", snapshot.SystemPrompt, pager)
				},
			})
		}
		rows = append(rows, settingsRow{ID: "context-refresh", Label: "Refresh", Kind: settingsAction, Run: func(m *Model, s *settingsState) tea.Cmd {
			m.pendingContext = true
			return m.loadToolSnapshot()
		}})
		tab.Rows = rows
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
	m.showPage(panel)
}

// viewSystemPrompt opens text in the client's own read-only page. This is the
// default way to read the prompt because it needs nothing outside the binary.
// The page returns to whatever overlay opened it, so the Context panel is
// restored on esc.
func (m *Model) viewSystemPrompt(title, text string) tea.Cmd {
	if strings.TrimSpace(text) == "" {
		m.setToast("nothing to show")
		return nil
	}
	viewer := newViewerOverlay(title, text)
	viewer.returnTo = m.overlay
	m.openOverlay(viewer)
	return nil
}

// pagerCmd is an external pager resolved on PATH, with the name the user asked
// for and the arguments that came with it.
type pagerCmd struct {
	name string
	path string
	args []string
}

// pagerCandidates are searched when neither PIE_PAGER nor PAGER names a
// program. more ships with Windows, so the chain degrades instead of failing
// on a platform without less.
var pagerCandidates = []string{"less", "most", "more"}

// resolvePager picks the external pager for the Context panel's optional
// "Open in ..." row. PIE_PAGER wins over PAGER, so a shell-wide pager can stay
// set to something else. A value may carry arguments ("less -R"); it is split
// on whitespace, so a quoted argument is not supported.
func resolvePager() (pagerCmd, bool) {
	for _, env := range []string{"PIE_PAGER", "PAGER"} {
		fields := strings.Fields(os.Getenv(env))
		if len(fields) == 0 {
			continue
		}
		if path, err := exec.LookPath(fields[0]); err == nil {
			return pagerCmd{name: fields[0], path: path, args: fields[1:]}, true
		}
	}
	for _, name := range pagerCandidates {
		if path, err := exec.LookPath(name); err == nil {
			return pagerCmd{name: name, path: path}, true
		}
	}
	return pagerCmd{}, false
}

// pagerText hands text to an external pager through a temporary file and
// returns to the Context panel when the pager exits.
func (m *Model) pagerText(name, text string, pager pagerCmd) tea.Cmd {
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
	// Copy the arguments first: a second press must not append into the spare
	// capacity of the slice this row captured.
	args := append(append([]string{}, pager.args...), file.Name())
	command := exec.Command(pager.path, args...)
	return tea.ExecProcess(command, func(err error) tea.Msg {
		_ = os.Remove(file.Name())
		return contextViewMsg{err: err}
	})
}
