package ui

import (
	"fmt"
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// settingsSearchItems lists every settings row as a picker item. The label
// carries the tab name so a whole section is searchable, and Keywords carries
// help plus the current value, which the picker ranks below a label match.
func (m *Model) settingsSearchItems() []pickerItem {
	tabs := m.buildSettingsTabs()
	items := make([]pickerItem, 0)
	for tabIndex, tab := range tabs {
		for rowIndex, row := range tab.Rows {
			current := ""
			if row.Current != nil {
				current = row.Current()
			}
			detail := row.Help
			if detail == "" {
				detail = current
			}
			items = append(items, pickerItem{
				Value:    fmt.Sprintf("%d:%d", tabIndex, rowIndex),
				Label:    tab.Label + " · " + row.Label,
				Detail:   detail,
				Keywords: strings.TrimSpace(row.Help + " " + current),
			})
		}
	}
	return items
}

// openSettingsSearch shows a live fuzzy finder over every settings row. It is
// the terminal counterpart of Pie's SettingsSearch.
func (m *Model) openSettingsSearch() {
	picker := newPickerOverlay("settings-jump", "Search settings", m.settingsSearchItems())
	picker.fuzzyFilter = true
	picker.filter.Placeholder = "type a tab, row, or value"
	if m.overlay != nil && m.overlay.kind == overlaySettings {
		picker.returnTo = m.overlay
	}
	m.openOverlay(picker)
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
	if rowIndex < 0 || rowIndex >= len(m.settingsPanel.tabs[tabIndex].Rows) {
		return nil
	}
	m.settingsPanel.active = tabIndex
	m.settingsPanel.row = rowIndex
	m.openSettingsOverlay()
	return nil
}
