package ui

import (
	"sort"
	"strings"
)

// settingsLineKind is one rendered line of a settings page: a gap, a section
// heading, or a row.
type settingsLineKind int

const (
	settingsLineGap settingsLineKind = iota
	settingsLineSection
	settingsLineRow
)

type settingsLine struct {
	kind  settingsLineKind
	group int
	row   int
}

// filterActive reports whether the query has any non-space content.
func (s *settingsState) filterActive() bool {
	return strings.TrimSpace(s.filter) != ""
}

// displayLines lays out the rows the page currently shows. Without a filter the
// Settings page shows one category and a domain page shows every section; with
// a filter, matches replace that order, grouped under their section headings.
func (s *settingsState) displayLines() []settingsLine {
	if len(s.tabs) == 0 {
		return nil
	}
	if s.filterActive() {
		return s.filteredLines()
	}

	lines := make([]settingsLine, 0, s.totalRows())
	if s.page.Mode == pageCategories {
		group := s.activeGroup()
		if group < 0 || group >= len(s.tabs) {
			return nil
		}
		for row := range s.tabs[group].Rows {
			lines = append(lines, settingsLine{kind: settingsLineRow, group: group, row: row})
		}
		return lines
	}

	headings := 0
	for _, tab := range s.tabs {
		if len(tab.Rows) > 0 {
			headings++
		}
	}
	for group := range s.tabs {
		if len(s.tabs[group].Rows) == 0 {
			continue
		}
		if headings > 1 {
			if len(lines) > 0 {
				lines = append(lines, settingsLine{kind: settingsLineGap})
			}
			lines = append(lines, settingsLine{kind: settingsLineSection, group: group})
		}
		for row := range s.tabs[group].Rows {
			lines = append(lines, settingsLine{kind: settingsLineRow, group: group, row: row})
		}
	}
	return lines
}

// filteredLines ranks rows inside their group and keeps the groups in page
// order, so the list does not jump between sections while the query grows.
func (s *settingsState) filteredLines() []settingsLine {
	terms := strings.Fields(strings.ToLower(strings.TrimSpace(s.filter)))
	if len(terms) == 0 {
		return nil
	}

	type hit struct {
		row   int
		score int
	}
	matches := make([][]hit, len(s.tabs))
	for group := range s.tabs {
		for row := range s.tabs[group].Rows {
			score, ok := fuzzyPickerScore(terms, s.searchItem(group, row))
			if !ok {
				continue
			}
			matches[group] = append(matches[group], hit{row: row, score: score})
		}
		sort.SliceStable(matches[group], func(i, j int) bool {
			if matches[group][i].score != matches[group][j].score {
				return matches[group][i].score > matches[group][j].score
			}
			return matches[group][i].row < matches[group][j].row
		})
	}

	lines := make([]settingsLine, 0)
	for group := range s.tabs {
		if len(matches[group]) == 0 {
			continue
		}
		if len(lines) > 0 {
			lines = append(lines, settingsLine{kind: settingsLineGap})
		}
		lines = append(lines, settingsLine{kind: settingsLineSection, group: group})
		for _, match := range matches[group] {
			lines = append(lines, settingsLine{kind: settingsLineRow, group: group, row: match.row})
		}
	}
	return lines
}

// searchItem carries the label, help, and current value a query can match. The
// label outranks the help text in fuzzyPickerScore.
func (s *settingsState) searchItem(group, row int) pickerItem {
	entry := s.tabs[group].Rows[row]
	current := ""
	if entry.Current != nil {
		current = entry.Current()
	}
	return pickerItem{
		Label:    entry.Label,
		Detail:   entry.Help,
		Keywords: strings.TrimSpace(entry.Help + " " + current),
	}
}

// targets lists the selectable rows in display order.
func (s *settingsState) targets() []settingsTarget {
	lines := s.displayLines()
	targets := make([]settingsTarget, 0, len(lines))
	for _, line := range lines {
		if line.kind == settingsLineRow {
			targets = append(targets, settingsTarget{group: line.group, row: line.row})
		}
	}
	return targets
}
