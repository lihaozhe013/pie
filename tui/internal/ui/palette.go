package ui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// paletteItems lists every command the palette can run. Aliases are folded
// into the detail line so a filter still finds the canonical command by a
// familiar name, while the list keeps one row per command.
func (m *Model) paletteItems() []pickerItem {
	items := make([]pickerItem, 0, len(builtinCommandTable)+len(m.commands))
	seen := make(map[string]bool, len(builtinCommandTable))

	for _, command := range builtinCommandTable {
		seen[command.Name] = true
		aliases := make([]string, 0, len(command.Aliases))
		for _, alias := range command.Aliases {
			// An alias pi owns is forwarded to pi, so advertising it here
			// would be a lie.
			if m.piOwns(alias) {
				continue
			}
			aliases = append(aliases, alias)
		}
		detail := command.Detail
		if len(aliases) > 0 {
			detail += " · aliases: " + strings.Join(aliases, ", ")
		}
		items = append(items, pickerItem{Value: command.Name, Label: command.Name, Detail: detail})
	}

	for _, command := range m.commands {
		value := "/" + command.Name
		if seen[value] {
			continue
		}
		seen[value] = true
		detail := command.Description
		if detail == "" {
			detail = command.Source
		} else if command.Source != "" {
			detail += " (" + command.Source + ")"
		}
		items = append(items, pickerItem{Value: value, Label: value, Detail: detail})
	}
	return items
}

// openPalette shows the command launcher. Commands run through the same
// dispatcher as the composer, but the draft is left untouched, so a command
// stays reachable while a prompt is half written.
func (m *Model) openPalette() tea.Cmd {
	overlay := newPickerOverlay("palette", "Command palette", m.paletteItems())
	overlay.filter.Placeholder = "type to filter commands"
	m.openOverlay(overlay)
	return nil
}

// runPaletteItem closes the palette and executes one command.
func (m *Model) runPaletteItem(value string) tea.Cmd {
	m.closeOverlay()
	return m.dispatchCommand(value)
}
