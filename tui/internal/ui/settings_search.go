package ui

import (
	"fmt"
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// searchSettings finds rows across every tab by label, help, and current value,
// then jumps to the chosen row. It is the terminal counterpart of Pie's
// SettingsSearch.
func (m *Model) searchSettings(query string) tea.Cmd {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return nil
	}
	if m.settingsPanel == nil || m.settingsPanel.single {
		m.settingsPanel = newSettingsState(m)
	}
	var items []pickerItem
	for tabIndex, tab := range m.settingsPanel.tabs {
		for rowIndex, row := range tab.Rows {
			haystack := strings.ToLower(row.Label + " " + row.Help)
			if row.Current != nil {
				haystack += " " + strings.ToLower(row.Current())
			}
			if !strings.Contains(haystack, query) {
				continue
			}
			detail := row.Help
			if detail == "" && row.Current != nil {
				detail = row.Current()
			}
			items = append(items, pickerItem{
				Value:  fmt.Sprintf("%d:%d", tabIndex, rowIndex),
				Label:  tab.Label + " · " + row.Label,
				Detail: detail,
			})
		}
	}
	if len(items) == 0 {
		m.setToast("no setting matches " + query)
		return nil
	}
	m.openOverlay(newPickerOverlay("settings-jump", "Settings matching "+query, items))
	return nil
}

func (m *Model) applySettingsJump(value string) tea.Cmd {
	parts := strings.SplitN(value, ":", 2)
	if len(parts) != 2 {
		return nil
	}
	tabIndex, err := strconv.Atoi(parts[0])
	if err != nil {
		return nil
	}
	rowIndex, err := strconv.Atoi(parts[1])
	if err != nil {
		return nil
	}
	m.settingsPanel = newSettingsState(m)
	if tabIndex < 0 || tabIndex >= len(m.settingsPanel.tabs) {
		return nil
	}
	m.settingsPanel.active = tabIndex
	m.settingsPanel.row = rowIndex
	m.openSettingsOverlay()
	return nil
}
