package ui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/lihaozhe013/pie/tui/internal/session"
)

// goalInstallHint is the manual install step pie does not do for the user.
const goalInstallHint = "pi install npm:pi-better-goal"

func isGoalLogEntry(entry session.LogEntry) bool {
	return entry.Type == "custom" &&
		(entry.CustomType == session.GoalEntryType || entry.CustomType == session.LegacyGoalEntryType)
}

// openGoalPanel shows the goal package's state and sends its /goal commands.
// It never runs the continuation loop itself: the installed package owns it.
func (m *Model) openGoalPanel() tea.Cmd {
	m.settingsPanel = m.goalPanel()
	m.openOverlay(&overlay{kind: overlaySettings, action: "goal", settings: m.settingsPanel})
	return nil
}

func (m *Model) goalPanel() *settingsState {
	tab := settingsTab{ID: "goal", Label: "Goal"}
	panel := newSettingsPanel("Goal", []settingsTab{tab})
	panel.action = "goal"

	if !m.goalAvailable {
		tab.Note = "The goal package is not installed."
		tab.Rows = []settingsRow{
			{ID: "goal-status", Label: "Status", Kind: settingsInfo, Current: func() string { return "unavailable" }},
			{ID: "goal-install", Label: "Install", Kind: settingsInfo, Current: func() string { return goalInstallHint }},
			{ID: "goal-restart", Label: "Then", Kind: settingsInfo, Current: func() string { return "restart pie to load the extension" }},
		}
		panel.tabs = []settingsTab{tab}
		return panel
	}

	if !m.goalEnabled {
		tab.Note = "Goal controls are disabled in Settings › General."
		tab.Rows = []settingsRow{{
			ID:    "goal-enable",
			Label: "Goal controls",
			Help:  "Show the goal panel and its status in the header.",
			Kind:  settingsAction,
			Run: func(m *Model, s *settingsState) tea.Cmd {
				if m.prefs == nil {
					s.err = "pie-settings.json is unavailable"
					return nil
				}
				if err := m.prefs.SetGoalEnabled(true); err != nil {
					s.err = err.Error()
					return nil
				}
				m.goalEnabled = true
				return m.openGoalPanel()
			},
		}}
		panel.tabs = []settingsTab{tab}
		return panel
	}

	status := "no goal"
	phase := ""
	if m.hasGoal {
		status = m.goal.Status
		if status == "" {
			status = "waiting"
		}
		phase = session.GoalPhase(m.goal.Status)
	}

	tab.Note = "The installed goal package runs the loop; this panel only reports it and sends /goal commands."
	tab.Rows = append(tab.Rows,
		settingsRow{ID: "goal-status", Label: "Status", Kind: settingsInfo, Current: func() string { return status }},
		settingsRow{ID: "goal-tokens", Label: "Tokens", Kind: settingsInfo, Current: func() string {
			if !m.hasGoal || !m.goal.HasTokens {
				return "(not reported)"
			}
			if m.goal.TokenBudget != nil && *m.goal.TokenBudget > 0 {
				return fmt.Sprintf("%s / %s", formatTokens(int(m.goal.TokensUsed)), formatTokens(int(*m.goal.TokenBudget)))
			}
			return formatTokens(int(m.goal.TokensUsed))
		}},
	)

	objective := ""
	if m.hasGoal {
		objective = m.goal.Objective
	}
	if phase == "running" {
		tab.Rows = append(tab.Rows, settingsRow{
			ID: "goal-objective", Label: "Objective", Kind: settingsInfo,
			Current: func() string { return objective },
			Help:    "Pause the goal before changing its objective.",
		})
	} else {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "goal-objective",
			Label: "Objective",
			Help:  "Written when you start or update the goal.",
			Kind:  settingsText,
			Current: func() string {
				if strings.TrimSpace(objective) == "" {
					return "(empty)"
				}
				return objective
			},
			EditValue: func() string { return objective },
			Apply: func(value string) error {
				objective = value
				return nil
			},
		})
	}

	send := func(command string) func(m *Model, s *settingsState) tea.Cmd {
		return func(m *Model, s *settingsState) tea.Cmd {
			if m.busy {
				s.err = "wait for the current turn to finish, or use Stop run"
				return nil
			}
			m.closeOverlay()
			return m.sendPrompt(command)
		}
	}

	startLabel := "Start goal"
	if m.hasGoal {
		startLabel = "Update goal"
	}
	tab.Rows = append(tab.Rows, settingsRow{
		ID:    "goal-start",
		Label: startLabel,
		Kind:  settingsAction,
		Run: func(m *Model, s *settingsState) tea.Cmd {
			if m.busy {
				s.err = "wait for the current turn to finish, or use Stop run"
				return nil
			}
			value := strings.TrimSpace(objective)
			if value == "" {
				s.err = "an objective is required"
				return nil
			}
			if len([]rune(value)) > 4000 {
				s.err = "the objective is longer than 4000 characters"
				return nil
			}
			m.closeOverlay()
			return m.sendPrompt("/goal " + value)
		},
	})
	if phase == "running" {
		tab.Rows = append(tab.Rows, settingsRow{ID: "goal-pause", Label: "Pause", Kind: settingsAction, Run: send("/goal pause")})
	}
	if phase == "waiting" {
		tab.Rows = append(tab.Rows, settingsRow{ID: "goal-resume", Label: "Resume", Kind: settingsAction, Run: send("/goal resume")})
	}
	if m.hasGoal && phase != "done" {
		tab.Rows = append(tab.Rows, settingsRow{ID: "goal-complete", Label: "Mark complete", Kind: settingsAction, Run: send("/goal complete")})
	}
	if m.hasGoal {
		tab.Rows = append(tab.Rows, settingsRow{ID: "goal-clear", Label: "Clear", Kind: settingsAction, Run: send("/goal clear")})
	}
	if m.busy {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "goal-stop",
			Label: "Stop run",
			Help:  "Interrupts the running turn; the goal stays paused until you resume it.",
			Kind:  settingsAction,
			Run: func(m *Model, s *settingsState) tea.Cmd {
				m.closeOverlay()
				return m.abort()
			},
		})
	}
	tab.Rows = append(tab.Rows, settingsRow{
		ID:    "goal-settings",
		Label: "Goal settings",
		Help:  "Opens the package's own settings (auto-continue, conversational resume, pause on escape).",
		Kind:  settingsAction,
		Run:   send("/goal settings"),
	})

	panel.tabs = []settingsTab{tab}
	return panel
}

// goalStatusSegment is the header chip, empty when there is nothing to show.
func (m *Model) goalStatusSegment() string {
	if !m.goalEnabled || !m.goalAvailable || !m.hasGoal {
		return ""
	}
	status := m.goal.Status
	if status == "" {
		status = "waiting"
	}
	return "goal:" + status
}
