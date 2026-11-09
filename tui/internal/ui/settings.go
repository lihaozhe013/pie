package ui

import (
	"fmt"
	"strings"
	"unicode"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/lihaozhe013/pie/tui/internal/config"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

// settingsRowKind selects how one settings row is edited.
type settingsRowKind int

const (
	settingsInfo settingsRowKind = iota
	settingsToggle
	settingsChoice
	settingsText
	settingsAction
)

// settingsRow is one editable line of a settings group.
type settingsRow struct {
	ID    string
	Label string
	Help  string
	Kind  settingsRowKind

	Current   func() string
	EditValue func() string
	Choices   []pickerItem
	Apply     func(string) error
	Bool      func() bool
	SetBool   func(bool) error
	Run       func(m *Model, s *settingsState) tea.Cmd
}

// settingsTab is one group of rows: a category on the Settings page, or a
// section on a domain page such as Models.
type settingsTab struct {
	ID    string
	Label string
	Note  string
	Rows  []settingsRow
}

// settingsPageMode selects how a page presents its groups.
type settingsPageMode int

const (
	// pageCategories is the Settings home: a category bar shows one group at a
	// time and the filter spans every group.
	pageCategories settingsPageMode = iota
	// pageSections stacks every group under its own heading, the way a domain
	// page such as Models reads.
	pageSections
)

// settingsPage is one top-level panel. The Settings home is the only page that
// uses pageCategories; domain pages use pageSections.
type settingsPage struct {
	ID    string
	Title string
	Mode  settingsPageMode
	Tabs  []settingsTab
}

// settingsTarget identifies one row inside the page.
type settingsTarget struct {
	group int
	row   int
}

// settingsState survives a round trip through a picker or the instruction
// editor, so the cursor, filter, and scroll position return where the user left
// them.
type settingsState struct {
	page settingsPage

	tabs     []settingsTab
	active   int
	sel      settingsTarget
	seen     map[int]int
	scroll   int
	listRows int

	filter string

	editing bool
	input   textinput.Model

	notice string
	err    string

	// detail marks a drill-down panel: its builder owns the rows, so a rebuild
	// leaves them alone, and esc returns through back when one is set.
	detail bool
	back   func(*Model) tea.Cmd
	action string
}

// newPageState builds a top-level page panel.
func newPageState(page settingsPage) *settingsState {
	state := newSettingsPanel(page.Title, page.Tabs)
	state.page = settingsPage{ID: page.ID, Title: page.Title, Mode: page.Mode}
	state.action = "page-" + page.ID
	state.detail = false
	return state
}

// newSettingsPanel builds a drill-down panel: goal, statistics, context, a
// provider or package detail, or the preset editor. Such a panel keeps the rows
// it was built with.
func newSettingsPanel(title string, tabs []settingsTab) *settingsState {
	input := textinput.New()
	input.Prompt = ""
	input.CharLimit = 0
	state := &settingsState{
		page:   settingsPage{Title: title, Mode: pageSections},
		tabs:   tabs,
		seen:   make(map[int]int),
		input:  input,
		detail: true,
		action: "settings",
	}
	state.clampSelection()
	return state
}

// rebuild refreshes the rows from disk while keeping the current group and row.
func (s *settingsState) rebuild(m *Model) {
	if s.detail || s.page.ID == "" {
		return
	}
	groupID, rowID := s.selectedIDs()
	page := m.buildPage(s.page.ID)
	if len(page.Tabs) == 0 {
		return
	}
	s.page = settingsPage{ID: page.ID, Title: page.Title, Mode: page.Mode}
	s.tabs = page.Tabs
	s.active = 0
	s.sel = settingsTarget{}
	if groupID != "" {
		for i, tab := range s.tabs {
			if tab.ID == groupID {
				s.active = i
				s.sel.group = i
				break
			}
		}
	}
	if rowID != "" && s.sel.group < len(s.tabs) {
		for i, row := range s.tabs[s.sel.group].Rows {
			if row.ID == rowID {
				s.sel.row = i
				break
			}
		}
	}
	s.clampSelection()
}

// selectedIDs names the current group and row, so a rebuild can find them
// again after the builders renumber the list.
func (s *settingsState) selectedIDs() (string, string) {
	if s.sel.group < 0 || s.sel.group >= len(s.tabs) {
		return "", ""
	}
	tab := s.tabs[s.sel.group]
	if s.sel.row < 0 || s.sel.row >= len(tab.Rows) {
		return tab.ID, ""
	}
	return tab.ID, tab.Rows[s.sel.row].ID
}

// activeGroup is the group being browsed. While a filter is active it follows
// the selected match, so the category bar never points at a different section
// than the one under the cursor.
func (s *settingsState) activeGroup() int {
	if s.page.Mode != pageCategories {
		return s.sel.group
	}
	if s.filterActive() && s.sel.group >= 0 && s.sel.group < len(s.tabs) {
		return s.sel.group
	}
	if s.active < 0 || s.active >= len(s.tabs) {
		return 0
	}
	return s.active
}

func (s *settingsState) currentRow() *settingsRow {
	if s.sel.group < 0 || s.sel.group >= len(s.tabs) {
		return nil
	}
	rows := s.tabs[s.sel.group].Rows
	if s.sel.row < 0 || s.sel.row >= len(rows) {
		return nil
	}
	return &rows[s.sel.row]
}

// currentGroup is the group the cursor is in.
func (s *settingsState) currentGroup() settingsTab {
	if s.sel.group < 0 || s.sel.group >= len(s.tabs) {
		return settingsTab{}
	}
	return s.tabs[s.sel.group]
}

func (s *settingsState) clampSelection() {
	if len(s.tabs) == 0 {
		s.sel = settingsTarget{}
		return
	}
	if s.page.Mode == pageCategories {
		if s.active < 0 || s.active >= len(s.tabs) {
			s.active = 0
		}
		s.sel.group = s.active
	}
	if s.sel.group < 0 || s.sel.group >= len(s.tabs) {
		s.sel.group = 0
	}
	rows := s.tabs[s.sel.group].Rows
	if s.sel.row < 0 || s.sel.row >= len(rows) {
		s.sel.row = maxInt(0, len(rows)-1)
	}
}

// selectTab moves the cursor to the first row of one category.
func (s *settingsState) selectTab(id string) {
	for i, tab := range s.tabs {
		if tab.ID != id {
			continue
		}
		s.active = i
		s.sel = settingsTarget{group: i, row: s.seen[i]}
		s.scroll = 0
		s.clampSelection()
		return
	}
	s.active = 0
	s.sel = settingsTarget{row: s.seen[0]}
	s.clampSelection()
}

// move walks the visible rows, wrapping at both ends.
func (s *settingsState) move(delta int) {
	targets := s.targets()
	if len(targets) == 0 {
		return
	}
	index := -1
	for i, target := range targets {
		if target == s.sel {
			index = i
			break
		}
	}
	if index < 0 {
		index = 0
	} else {
		index = (index + delta + len(targets)) % len(targets)
	}
	s.sel = targets[index]
	s.seen[s.sel.group] = s.sel.row
	s.err = ""
	s.notice = ""
}

func (s *settingsState) moveFirst() {
	targets := s.targets()
	if len(targets) == 0 {
		return
	}
	s.sel = targets[0]
	s.seen[s.sel.group] = s.sel.row
	s.scroll = 0
}

func (s *settingsState) moveLast() {
	targets := s.targets()
	if len(targets) == 0 {
		return
	}
	s.sel = targets[len(targets)-1]
	s.seen[s.sel.group] = s.sel.row
	s.scroll = 0
}

// switchGroup changes category on the Settings page. A filter spans every
// group, so switching would fight the result list and is ignored there.
func (s *settingsState) switchGroup(delta int) {
	if s.page.Mode != pageCategories || len(s.tabs) < 2 || s.filterActive() {
		return
	}
	s.seen[s.sel.group] = s.sel.row
	s.active = (s.active + delta + len(s.tabs)) % len(s.tabs)
	s.sel = settingsTarget{group: s.active, row: s.seen[s.active]}
	s.scroll = 0
	s.err = ""
	s.notice = ""
	s.clampSelection()
}

// setFilter replaces the query and keeps the best match selected.
func (s *settingsState) setFilter(value string) {
	s.filter = value
	s.scroll = 0
	s.err = ""
	s.notice = ""
	if !s.filterActive() && s.page.Mode == pageCategories {
		// Clearing the query returns the category bar to the row under the
		// cursor instead of the category the search started from.
		s.active = s.sel.group
	}
	targets := s.targets()
	if len(targets) == 0 {
		return
	}
	for _, target := range targets {
		if target == s.sel {
			return
		}
	}
	s.sel = targets[0]
}

func (s *settingsState) clearFilter() {
	s.filter = ""
	s.scroll = 0
	if s.page.Mode == pageCategories {
		s.active = s.sel.group
	}
	s.clampSelection()
}

// jumpToSelection leaves the filter on the row the query found. Activating that
// row takes a second enter, so a search cannot write a setting by accident.
func (s *settingsState) jumpToSelection() {
	s.filter = ""
	if s.page.Mode == pageCategories {
		s.active = s.sel.group
	}
	s.seen[s.sel.group] = s.sel.row
	s.clampSelection()
	s.scroll = 0
}

func (s *settingsState) backspaceFilter() {
	if s.filter == "" {
		return
	}
	runes := []rune(s.filter)
	s.setFilter(string(runes[:len(runes)-1]))
}

func (s *settingsState) deleteFilterWord() {
	trimmed := strings.TrimRight(s.filter, " ")
	index := strings.LastIndex(trimmed, " ")
	if index < 0 {
		s.setFilter("")
		return
	}
	s.setFilter(strings.TrimRight(trimmed[:index], " "))
}

func (s *settingsState) appendFilter(text string) {
	var b strings.Builder
	for _, r := range text {
		switch {
		case r == '\n' || r == '\r' || r == '\t':
			b.WriteRune(' ')
		case unicode.IsPrint(r):
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return
	}
	s.setFilter(s.filter + b.String())
}

// padPlain pads a plain string to width without counting escape codes.
func padPlain(s string, width int) string {
	if gap := width - lipglossWidth(s); gap > 0 {
		return s + strings.Repeat(" ", gap)
	}
	return truncateLine(s, width)
}

// padBetween puts one styled string at the left and another at the right of a
// line exactly width cells wide.
func padBetween(left, right string, width int) string {
	rightWidth := lipglossWidth(right)
	if rightWidth >= width {
		return truncateLine(right, width)
	}
	if leftWidth := lipglossWidth(left); leftWidth+rightWidth >= width {
		left = truncateLine(left, maxInt(0, width-rightWidth-1))
	}
	gap := width - lipglossWidth(left) - rightWidth
	if gap < 1 {
		gap = 1
	}
	return left + strings.Repeat(" ", gap) + right
}

// rowValue is the plain value cell and whether the row opens something.
func rowValue(row settingsRow) (string, bool) {
	var value string
	chevron := false
	switch row.Kind {
	case settingsInfo:
		if row.Current != nil {
			value = row.Current()
		}
	case settingsToggle:
		value = "false"
		if row.Bool != nil && row.Bool() {
			value = "true"
		}
	case settingsChoice, settingsText:
		if row.Current != nil {
			value = row.Current()
		}
		if value == "" {
			value = "—"
		}
		chevron = true
	case settingsAction:
		if row.Current != nil {
			value = row.Current()
		}
		chevron = true
	}
	return oneLine(value), chevron
}

// oneLine collapses newlines and repeated spaces so a value, help text, or
// error can never break the page's fixed line grid.
func oneLine(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

// styledValue paints the value cell for an unselected row. value is already
// truncated to the cell, so the row can never grow past the page width.
func styledValue(st styles, row settingsRow, value string, chevron bool) string {
	switch row.Kind {
	case settingsInfo:
		return st.muted.Render(value)
	case settingsToggle:
		if row.Bool != nil && row.Bool() {
			return st.settingsOn.Render(value)
		}
		return st.settingsOff.Render(value)
	default:
		out := st.pickerItem.Render(value)
		if chevron {
			out += "  " + st.settingsChevron.Render("›")
		}
		return out
	}
}

// View renders the page inside a box that fills the transcript area.
func (s *settingsState) View(st styles, boxWidth, bodyHeight int) string {
	textWidth := maxInt(20, boxWidth-4)
	contentRows := maxInt(3, bodyHeight-4)

	grouped := s.page.Mode == pageCategories && len(s.tabs) > 1
	status := s.err != "" || s.notice != ""
	fixed := 6 // title, rule, help, rule, filter, hints
	if grouped {
		fixed++
	}
	if status {
		fixed++
	}
	listRows := contentRows - fixed
	if listRows < 1 {
		listRows = 1
	}
	s.listRows = listRows

	lines := s.displayLines()

	// Keep the selected row on screen, and never leave blank space above the
	// list when the page shrank after a rebuild.
	selectedIndex := -1
	for i, line := range lines {
		if line.kind == settingsLineRow && (settingsTarget{group: line.group, row: line.row}) == s.sel {
			selectedIndex = i
			break
		}
	}
	if selectedIndex < 0 && len(lines) > 0 {
		for i, line := range lines {
			if line.kind == settingsLineRow {
				selectedIndex = i
				s.sel = settingsTarget{group: line.group, row: line.row}
				s.seen[s.sel.group] = s.sel.row
				break
			}
		}
	}
	if selectedIndex >= 0 {
		if selectedIndex < s.scroll {
			s.scroll = selectedIndex
		}
		if selectedIndex >= s.scroll+listRows {
			s.scroll = selectedIndex - listRows + 1
		}
	}
	if maxScroll := maxInt(0, len(lines)-listRows); s.scroll > maxScroll {
		s.scroll = maxScroll
	}
	if s.scroll < 0 {
		s.scroll = 0
	}

	out := make([]string, 0, contentRows)

	titleRight := ""
	if !s.detail {
		if total := s.totalRows(); total > 0 {
			titleRight = fmt.Sprintf("%d settings", total)
		}
	}
	out = append(out, padBetween(st.overlayHead.Render(s.page.Title), st.overlayHint.Render(titleRight), textWidth))

	if grouped {
		parts := make([]string, 0, len(s.tabs))
		for i, tab := range s.tabs {
			if i == s.activeGroup() {
				parts = append(parts, st.settingsTabOn.Render(tab.Label))
				continue
			}
			parts = append(parts, st.settingsTabOff.Render(tab.Label))
		}
		out = append(out, truncateLine(strings.Join(parts, "   "), textWidth))
	}

	out = append(out, st.settingsRule.Render(strings.Repeat("─", textWidth)))

	if len(lines) == 0 {
		message := "no settings on this page"
		if s.filterActive() {
			message = "no settings match \"" + s.filter + "\""
		}
		for i := 0; i < listRows; i++ {
			if i == 0 {
				out = append(out, st.overlayHint.Render(truncateLine(message, textWidth)))
				continue
			}
			out = append(out, "")
		}
	} else {
		for i := 0; i < listRows; i++ {
			index := s.scroll + i
			if index >= len(lines) {
				out = append(out, "")
				continue
			}
			line := lines[index]
			switch line.kind {
			case settingsLineGap:
				out = append(out, "")
			case settingsLineSection:
				out = append(out, st.settingsSection.Render(truncateLine("  "+s.tabs[line.group].Label, textWidth)))
			case settingsLineRow:
				selected := settingsTarget{group: line.group, row: line.row} == s.sel
				out = append(out, s.renderRow(st, line, selected, textWidth))
			}
		}
	}

	help := s.pageHelp()
	out = append(out, st.overlayHint.Render(truncateLine(help, textWidth)))

	switch {
	case s.err != "":
		out = append(out, st.errorText.Render(truncateLine(oneLine(s.err), textWidth)))
	case s.notice != "":
		out = append(out, st.notice.Render(truncateLine(oneLine(s.notice), textWidth)))
	}

	out = append(out, st.settingsRule.Render(strings.Repeat("─", textWidth)))
	out = append(out, s.filterLine(st, textWidth))
	out = append(out, st.overlayHint.Render(truncateLine(s.hints(), textWidth)))

	if len(out) > contentRows {
		out = out[:contentRows]
	}
	for len(out) < contentRows {
		out = append(out, "")
	}

	boxHeight := bodyHeight - 2
	if boxHeight < 3 {
		boxHeight = 3
	}
	return st.overlayBox.Copy().Width(boxWidth).Height(boxHeight).Render(strings.Join(out, "\n"))
}

func (s *settingsState) totalRows() int {
	total := 0
	for _, tab := range s.tabs {
		total += len(tab.Rows)
	}
	return total
}

// pageHelp is the selected row's description, then its group's note.
func (s *settingsState) pageHelp() string {
	if row := s.currentRow(); row != nil && row.Help != "" {
		return oneLine(row.Help)
	}
	if note := s.currentGroup().Note; note != "" {
		return oneLine(note)
	}
	return ""
}

// filterLine is the query row: a prompt, the query or its placeholder, and the
// match count once a query is active.
func (s *settingsState) filterLine(st styles, width int) string {
	count := ""
	if s.filterActive() {
		count = fmt.Sprintf("%d / %d", len(s.targets()), s.totalRows())
	}
	body := st.pickerItem.Render(s.filter) + st.editorCursor.Render(" ")
	if s.filter == "" {
		body = st.editorCursor.Render(" ") + st.editorPlaceholder.Render("type to filter settings")
	}
	return padBetween(st.settingsPrompt.Render("/")+" "+body, st.overlayHint.Render(count), width)
}

// hints describes only the keys that do something right now.
func (s *settingsState) hints() string {
	if s.editing {
		return "enter save · esc cancel"
	}
	switch {
	case s.filterActive():
		return "enter jump to the setting · esc clear · ↑/↓ move"
	case s.page.Mode == pageCategories && len(s.tabs) > 1:
		return "enter change · tab category · esc close · ctrl+r reload"
	case s.detail && s.back != nil:
		return "enter change · esc back · ctrl+r reload"
	default:
		return "enter change · esc close · ctrl+r reload"
	}
}

func (s *settingsState) renderRow(st styles, line settingsLine, selected bool, width int) string {
	tab := s.tabs[line.group]
	row := tab.Rows[line.row]

	labelWidth := minInt(32, maxInt(14, width/2))
	valueWidth := width - labelWidth
	if valueWidth < 8 {
		labelWidth = maxInt(8, width-8)
		valueWidth = width - labelWidth
	}

	plainValue, chevron := rowValue(row)
	suffix := 0
	if chevron {
		suffix = 3 // two spaces and the chevron
	}
	plainValue = truncateLine(plainValue, maxInt(0, valueWidth-suffix))

	if selected && s.editing && row.Kind == settingsText {
		label := st.pickerSel.Render(truncateLine("❯ "+row.Label, labelWidth))
		s.input.Width = maxInt(8, valueWidth)
		return truncateLine(label+padPlain("", labelWidth-lipglossWidth(label))+s.input.View(), width)
	}

	if selected {
		left := padPlain(truncateLine("❯ "+row.Label, labelWidth), labelWidth)
		value := plainValue
		if chevron {
			value += "  ›"
		}
		value = strings.Repeat(" ", maxInt(0, valueWidth-lipglossWidth(value))) + value
		return st.settingsSel.Render(padPlain(left+value, width))
	}

	labelStyle := st.pickerItem
	if row.Kind == settingsInfo {
		labelStyle = st.muted
	}
	label := labelStyle.Render(truncateLine("  "+row.Label, labelWidth))
	gap := labelWidth - lipglossWidth(label)
	if gap < 0 {
		gap = 0
	}
	value := styledValue(st, row, plainValue, chevron)
	valueGap := valueWidth - lipglossWidth(value)
	if valueGap < 0 {
		valueGap = 0
	}
	return label + strings.Repeat(" ", gap) + strings.Repeat(" ", valueGap) + value
}

// handleSettingsKey routes keys while a settings page is open.
func (m *Model) handleSettingsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	s := m.settingsPanel
	if s == nil {
		m.closeOverlay()
		return m, nil
	}
	key := msg.String()

	if s.editing {
		switch key {
		case "enter":
			row := s.currentRow()
			value := s.input.Value()
			s.editing = false
			s.input.Blur()
			if row != nil && row.Apply != nil {
				if err := row.Apply(value); err != nil {
					s.err = err.Error()
				} else {
					s.notice = "saved"
				}
			}
			return m, nil
		case "esc":
			s.editing = false
			s.input.Blur()
			s.err = ""
			return m, nil
		case "ctrl+c":
			return m, tea.Quit
		}
		var cmd tea.Cmd
		s.input, cmd = s.input.Update(msg)
		return m, cmd
	}

	switch key {
	case "esc":
		if s.filterActive() {
			s.clearFilter()
			return m, nil
		}
		if s.detail && s.back != nil {
			return m, s.back(m)
		}
		m.closeOverlay()
		return m, nil
	case "ctrl+c":
		return m, tea.Quit
	case "up", "ctrl+p":
		s.move(-1)
	case "down", "ctrl+n":
		s.move(1)
	case "pgup":
		s.move(-maxInt(1, s.listRows))
	case "pgdown":
		s.move(maxInt(1, s.listRows))
	case "home":
		s.moveFirst()
	case "end":
		s.moveLast()
	case "left", "shift+tab":
		s.switchGroup(-1)
	case "right", "tab":
		s.switchGroup(1)
	case "enter":
		if s.filterActive() {
			s.jumpToSelection()
			return m, nil
		}
		return m.activateSettingsRow()
	case "ctrl+r":
		m.reloadConfig()
		s.rebuild(m)
		s.notice = "reloaded from disk"
	case "backspace":
		s.backspaceFilter()
	case "ctrl+w":
		s.deleteFilterWord()
	case "ctrl+u":
		s.setFilter("")
	default:
		// Printable input belongs to the filter; every other key is a control
		// key the panel either handled above or ignores.
		if msg.Type == tea.KeyRunes && !msg.Alt {
			s.appendFilter(string(msg.Runes))
		} else if msg.Type == tea.KeySpace {
			s.appendFilter(" ")
		}
	}
	return m, nil
}

func (m *Model) activateSettingsRow() (tea.Model, tea.Cmd) {
	s := m.settingsPanel
	row := s.currentRow()
	if row == nil {
		return m, nil
	}
	s.err = ""
	s.notice = ""

	switch row.Kind {
	case settingsToggle:
		if row.SetBool == nil || row.Bool == nil {
			return m, nil
		}
		if err := row.SetBool(!row.Bool()); err != nil {
			s.err = err.Error()
		}
		return m, nil
	case settingsText:
		if row.Apply == nil {
			return m, nil
		}
		s.editing = true
		value := ""
		if row.EditValue != nil {
			value = row.EditValue()
		} else if row.Current != nil {
			value = row.Current()
			if value == "—" {
				value = ""
			}
		}
		s.input.SetValue(value)
		s.input.CursorEnd()
		s.input.Focus()
		return m, nil
	case settingsChoice:
		if len(row.Choices) == 0 || row.Apply == nil {
			return m, nil
		}
		m.pendingSettingsRow = row
		current := ""
		if row.Current != nil {
			current = row.Current()
		}
		items := make([]pickerItem, 0, len(row.Choices))
		for _, choice := range row.Choices {
			label := choice.Label
			if label == "" {
				label = choice.Value
			}
			if choice.Value == current {
				label += "  ·"
			}
			items = append(items, pickerItem{Value: choice.Value, Label: label, Detail: choice.Detail})
		}
		m.openOverlay(newPickerOverlay("settings-choice", row.Label, items))
		return m, nil
	case settingsAction:
		if row.Run != nil {
			return m, row.Run(m, s)
		}
	}
	return m, nil
}

func (m *Model) applySettingChoice(value string) tea.Cmd {
	row := m.pendingSettingsRow
	m.pendingSettingsRow = nil
	if row == nil {
		return nil
	}
	if err := row.Apply(value); err != nil {
		if m.settingsPanel != nil {
			m.settingsPanel.err = err.Error()
		}
	} else if m.settingsPanel != nil {
		m.settingsPanel.notice = "saved"
	}
	m.openSettingsOverlay()
	return nil
}

// editGlobalInstructions opens the multi-line editor over the settings panel.
func (m *Model) editGlobalInstructions(s *settingsState) tea.Cmd {
	text, err := config.ReadInstructions(m.paths)
	if err != nil {
		s.err = "read AGENTS.md: " + err.Error()
		return nil
	}
	request := &rpc.ExtensionUIRequestEvent{
		Title:   "Global instructions",
		Method:  "editor",
		Prefill: text,
		Message: m.paths.Agents() + "\nSaved text applies to new pi runs; use reload to apply now.",
	}
	editor := newEditorOverlay(request)
	editor.action = "settings-agents"
	m.openOverlay(editor)
	return nil
}

// generalSettingsTab is the Settings home's first category. It absorbs the
// appearance preferences a terminal can honour: theme, submit key, thinking
// blocks, and tool-output expansion.
func (m *Model) generalSettingsTab() settingsTab {
	tab := settingsTab{ID: "general", Label: "General", Note: "Shared settings are written to pi's files immediately."}

	if m.prefs != nil {
		themeChoices := make([]pickerItem, 0, len(themeOptions))
		for _, option := range themeOptions {
			detail := option.Scheme
			if detail == "" {
				detail = "follows the terminal"
			}
			themeChoices = append(themeChoices, pickerItem{Value: option.ID, Label: option.Label, Detail: detail})
		}
		tab.Rows = append(tab.Rows,
			settingsRow{
				ID:    "theme",
				Label: "Theme",
				Help:  "Paint the transcript and chrome with pie's palette. Applies immediately.",
				Kind:  settingsChoice,
				Current: func() string {
					return ThemeLabel(m.prefs.Theme())
				},
				Choices: themeChoices,
				Apply: func(value string) error {
					if err := m.prefs.SetTheme(value); err != nil {
						return err
					}
					m.applyTheme(value)
					return nil
				},
			},
			settingsRow{
				ID:    "enter-sends",
				Label: "Enter sends",
				Help:  "When off, enter inserts a newline and alt+enter sends.",
				Kind:  settingsToggle,
				Bool:  func() bool { return m.enterToSend },
				SetBool: func(on bool) error {
					if err := m.prefs.SetEnterToSend(on); err != nil {
						return err
					}
					m.enterToSend = on
					return nil
				},
			},
			settingsRow{
				ID:    "show-thinking",
				Label: "Thinking blocks",
				Help:  "Show a short reasoning preview in the transcript (also ctrl+t).",
				Kind:  settingsToggle,
				Bool:  m.prefs.ShowThinking,
				SetBool: func(on bool) error {
					if err := m.prefs.SetShowThinking(on); err != nil {
						return err
					}
					m.showThinking = on
					m.applyThinkingVisibility()
					return nil
				},
			},
			settingsRow{
				ID:    "expand-tools",
				Label: "Expand output",
				Help:  "Show full thinking, tool output, and diffs; when off, previews stay folded (also ctrl+o).",
				Kind:  settingsToggle,
				Bool:  m.prefs.ExpandTools,
				SetBool: func(on bool) error {
					if err := m.prefs.SetExpandTools(on); err != nil {
						return err
					}
					m.expanded = on
					m.applyExpansion()
					return nil
				},
			},
		)
	}

	if m.settings == nil {
		reason := "settings.json could not be read"
		if m.configErr != nil {
			reason += ": " + m.configErr.Error()
		}
		tab.Rows = append(tab.Rows, settingsRow{ID: "settings-error", Label: "settings.json", Kind: settingsInfo, Current: func() string { return reason }})
	} else {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "cache-notices",
			Label: "Cache-miss notices",
			Help:  "Show pi's notices for cache misses, warming, compaction, and provider recovery.",
			Kind:  settingsToggle,
			Bool: func() bool {
				on, _ := m.settings.ShowCacheMissNotices()
				return on
			},
			SetBool: m.settings.SetShowCacheMissNotices,
		})
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "session-dir",
			Label: "Session directory",
			Help:  "Where pi stores session files. Blank uses the agent directory. Restart pie to apply.",
			Kind:  settingsText,
			Current: func() string {
				dir, ok, err := m.settings.SessionDir()
				if err != nil || !ok {
					return "(default)"
				}
				return dir
			},
			EditValue: func() string {
				dir, ok, err := m.settings.SessionDir()
				if err != nil || !ok {
					return ""
				}
				return dir
			},
			Apply: m.settings.SetSessionDir,
		})
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "agent-dir",
			Label:   "Agent directory",
			Kind:    settingsInfo,
			Current: func() string { return m.paths.Dir },
		})
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "settings-path",
			Label:   "Settings file",
			Kind:    settingsInfo,
			Current: func() string { return m.paths.Settings() },
		})
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "bridge",
			Label: "Bridge extension",
			Help:  "Loaded from the pie state directory; enables hot tool switching and reload.",
			Kind:  settingsInfo,
			Current: func() string {
				if m.bridgeReady {
					return "ready"
				}
				return "unavailable"
			},
		})
	}

	if m.prefs != nil {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "goal-enabled",
			Label: "Goal controls",
			Help:  "Requires the goal package: " + goalInstallHint + ". Install it, restart pie, then enable this.",
			Kind:  settingsToggle,
			Bool:  func() bool { return m.goalEnabled },
			SetBool: func(on bool) error {
				if on && !m.goalAvailable {
					return fmt.Errorf("the goal package is not installed; run: %s and restart", goalInstallHint)
				}
				if err := m.prefs.SetGoalEnabled(on); err != nil {
					return err
				}
				m.goalEnabled = on
				return nil
			},
		})
	}

	tab.Rows = append(tab.Rows, settingsRow{
		ID:    "reload-pi",
		Label: "Reload pi",
		Help:  "Rereads settings.json, AGENTS.md, and instructions through the bridge without restarting the session.",
		Kind:  settingsAction,
		Run: func(m *Model, s *settingsState) tea.Cmd {
			return m.reloadPi()
		},
	})
	return tab
}

func (m *Model) instructionsSettingsTab() settingsTab {
	tab := settingsTab{
		ID:    "instructions",
		Label: "Instructions",
		Note:  "The global AGENTS.md applies to every project.",
	}
	size := "missing"
	if text, err := config.ReadInstructions(m.paths); err == nil {
		if strings.TrimSpace(text) == "" {
			size = "empty"
		} else {
			size = fmt.Sprintf("%d characters", len([]rune(text)))
		}
	} else {
		size = "unreadable: " + err.Error()
	}
	tab.Rows = append(tab.Rows,
		settingsRow{
			ID:    "edit-agents",
			Label: "Edit AGENTS.md",
			Help:  "Opens the multi-line editor. ctrl+s saves; esc returns here.",
			Kind:  settingsAction,
			Run:   func(m *Model, s *settingsState) tea.Cmd { return m.editGlobalInstructions(s) },
		},
		settingsRow{
			ID:      "agents-path",
			Label:   "File",
			Kind:    settingsInfo,
			Current: func() string { return m.paths.Agents() },
		},
		settingsRow{
			ID:      "agents-size",
			Label:   "Size",
			Kind:    settingsInfo,
			Current: func() string { return size },
		},
	)
	return tab
}

// applyTheme rebuilds the style set and pushes it into the cached renderers.
func (m *Model) applyTheme(id string) {
	m.styles = newStyles(themeFor(id))
	m.transcript.SetStyles(m.styles)
	m.composer.SetStyles(m.styles)
	m.layout()
}
