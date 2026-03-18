package ui

import (
	"fmt"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

// contextUsage applies pie-model-settings.json's cap to pi's reported window,
// matching the meter Pie draws. A cap never enlarges a model's native window.
func (m *Model) contextUsage() *rpc.ContextUsage {
	usage := m.stats.ContextUsage
	if usage == nil {
		return nil
	}
	capped := *usage
	if m.modelSettings != nil {
		if limit, applies := m.modelSettings.ContextWindowLimit(); applies && limit > 0 && limit < capped.ContextWindow {
			capped.ContextWindow = limit
			capped.Percent = 100 * float64(capped.Tokens) / float64(limit)
		}
	}
	return &capped
}

// openStats shows the session counters and refreshes them while the panel is
// open. The same numbers power the status bar's token estimate.
func (m *Model) openStats() tea.Cmd {
	m.showStatsPanel()
	return m.refreshStats()
}

func (m *Model) showStatsPanel() {
	tab := settingsTab{ID: "stats", Label: "Statistics"}

	tab.Rows = []settingsRow{
		{ID: "stats-session", Label: "Session", Kind: settingsInfo, Current: func() string {
			session := m.state.SessionName
			if session == "" {
				session = m.state.SessionID
			}
			if session == "" {
				session = "(unsaved)"
			}
			return session
		}},
		{ID: "stats-model", Label: "Model", Kind: settingsInfo, Current: func() string {
			if m.state.Model == nil {
				return "no model"
			}
			return m.state.Model.Label()
		}},
		{ID: "stats-messages", Label: "Messages", Kind: settingsInfo, Current: func() string {
			return fmt.Sprintf("%d user · %d assistant · %d tool calls · %d total",
				m.stats.UserMessages, m.stats.AssistantMessages, m.stats.ToolCalls, m.stats.TotalMessages)
		}},
		{ID: "stats-tokens", Label: "Tokens", Kind: settingsInfo, Current: func() string {
			return formatTokens(m.stats.Tokens.Total)
		}, Help: fmt.Sprintf("input %s · output %s · cache read %s · cache write %s",
			formatTokens(m.stats.Tokens.Input), formatTokens(m.stats.Tokens.Output),
			formatTokens(m.stats.Tokens.CacheRead), formatTokens(m.stats.Tokens.CacheWrite))},
		{ID: "stats-cost", Label: "Cost", Kind: settingsInfo, Current: func() string {
			return fmt.Sprintf("$%.4f", m.stats.Cost)
		}},
		{ID: "stats-context", Label: "Context", Kind: settingsInfo, Current: func() string {
			usage := m.contextUsage()
			if usage == nil || usage.ContextWindow <= 0 {
				return "(not reported)"
			}
			return fmt.Sprintf("%s / %s · %.0f%%", formatTokens(usage.Tokens), formatTokens(usage.ContextWindow), usage.Percent)
		}},
		{ID: "stats-file", Label: "Session file", Kind: settingsInfo, Current: func() string {
			if m.stats.SessionFile == "" {
				return "(unsaved)"
			}
			return m.stats.SessionFile
		}},
		{ID: "stats-refresh", Label: "Refresh", Kind: settingsAction, Run: func(m *Model, s *settingsState) tea.Cmd {
			return m.refreshStats()
		}},
	}
	panel := newSettingsPanel("Statistics", []settingsTab{tab})
	panel.action = "stats"
	m.settingsPanel = panel
	m.openOverlay(&overlay{kind: overlaySettings, action: "stats", settings: panel})
}

// statsPanelOpen reports whether the statistics panel is the active overlay.
// The rows read the live model fields, so a refresh can update the values
// without rebuilding the panel and losing its cursor.
func (m *Model) statsPanelOpen() bool {
	return m.overlay != nil && m.overlay.action == "stats"
}
