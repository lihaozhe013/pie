package ui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// tabWidth is the tab stop used when transcript content is normalized for
// cell-accurate selection. Rendered lines are cached as spaces so the
// viewport and the selection layer agree on every column.
const tabWidth = 8

// textPoint identifies one cell in the rendered transcript. line indexes the
// full rendered content, not the visible slice, so scrolling does not move a
// selection.
type textPoint struct {
	line int
	col  int
}

// textSelection is the mouse selection state of the transcript.
type textSelection struct {
	active   bool
	dragging bool
	moved    bool
	anchor   textPoint
	cursor   textPoint
}

// normalized returns the selection endpoints in reading order.
func (s textSelection) normalized() (textPoint, textPoint) {
	if s.anchor.line > s.cursor.line ||
		(s.anchor.line == s.cursor.line && s.anchor.col > s.cursor.col) {
		return s.cursor, s.anchor
	}
	return s.anchor, s.cursor
}

// HasSelection reports whether a non-empty selection is visible.
func (t *transcript) HasSelection() bool { return t.sel.active }

// IsDragging reports whether the left mouse button is selecting.
func (t *transcript) IsDragging() bool { return t.sel.dragging }

// BeginSelection starts a selection at a viewport-relative cell.
func (t *transcript) BeginSelection(x, y int) {
	if t.width < 1 || t.height < 1 {
		return
	}
	if t.dirty {
		t.rebuild()
	}
	if len(t.content) == 0 {
		return
	}
	if !t.sel.active {
		t.resumeFollow = t.stickBottom
	}
	t.stickBottom = false
	// The transcript wraps to the viewport width, so horizontal scrolling is
	// never needed and would desynchronize the selection view.
	t.vp.SetXOffset(0)
	point := t.pointAt(x, y)
	t.sel = textSelection{
		active:   true,
		dragging: true,
		anchor:   point,
		cursor:   point,
	}
}

// DragSelection extends the active selection to a viewport-relative cell. A
// drag outside the transcript scrolls one line per event and pins the cursor
// to the nearest visible row.
func (t *transcript) DragSelection(x, y int) {
	if !t.sel.dragging {
		return
	}
	if y < 0 {
		t.vp.ScrollUp(1)
		y = 0
	} else if y >= t.height {
		t.vp.ScrollDown(1)
		y = t.height - 1
	}
	point := t.pointAt(x, y)
	if point != t.sel.anchor {
		t.sel.moved = true
	}
	t.sel.cursor = point
}

// EndSelection finishes a drag. It returns the selected text only when the
// pointer actually moved; a plain click clears the selection.
func (t *transcript) EndSelection() string {
	if !t.sel.dragging {
		return ""
	}
	if t.dirty {
		t.rebuild()
	}
	t.sel.dragging = false
	if !t.sel.moved {
		t.ClearSelection()
		return ""
	}
	return t.SelectionText()
}

// ClearSelection removes the highlight and restores bottom following when the
// selection had interrupted it.
func (t *transcript) ClearSelection() {
	if !t.sel.active && !t.sel.dragging {
		return
	}
	t.sel = textSelection{}
	if t.resumeFollow {
		t.stickBottom = true
		t.vp.GotoBottom()
	}
	t.resumeFollow = false
}

// SelectionText returns the selected cells as plain text. ANSI styling is
// stripped, trailing spaces are removed per line, and blank lines inside the
// selection are preserved.
func (t *transcript) SelectionText() string {
	if !t.sel.active || len(t.content) == 0 {
		return ""
	}
	start, end := t.sel.normalized()
	if start.line >= len(t.content) {
		return ""
	}
	if end.line >= len(t.content) {
		end.line = len(t.content) - 1
		end.col = ansi.StringWidth(t.content[end.line])
	}

	lines := make([]string, 0, end.line-start.line+1)
	for i := start.line; i <= end.line; i++ {
		line := t.content[i]
		width := ansi.StringWidth(line)
		from, to := 0, width
		if i == start.line {
			from = clampInt(start.col, 0, width)
		}
		if i == end.line {
			to = clampInt(end.col, 0, width)
		}
		lines = append(lines, strings.TrimRight(plainCells(line, from, to), " \t"))
	}
	// A selection that ends at the start of a line includes the newline but
	// not the empty final line.
	if end.line > start.line && end.col == 0 && len(lines) > 0 {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "\n")
}

// pointAt maps a viewport-relative cell to the rendered content.
func (t *transcript) pointAt(x, y int) textPoint {
	if len(t.content) == 0 {
		return textPoint{}
	}
	y = clampInt(y, 0, t.height-1)
	line := clampInt(t.vp.YOffset+y, 0, len(t.content)-1)
	width := ansi.StringWidth(t.content[line])
	return textPoint{line: line, col: clampInt(x, 0, width)}
}

// clampSelection keeps the selection valid after content or viewport changes.
func (t *transcript) clampSelection() {
	if !t.sel.active {
		return
	}
	if len(t.content) == 0 {
		t.ClearSelection()
		return
	}
	clampPoint := func(point *textPoint) {
		point.line = clampInt(point.line, 0, len(t.content)-1)
		width := ansi.StringWidth(t.content[point.line])
		point.col = clampInt(point.col, 0, width)
	}
	clampPoint(&t.sel.anchor)
	clampPoint(&t.sel.cursor)
}

// viewSelection renders the visible transcript lines with the selection
// highlighted. Only the viewport slice is touched, so selection does not
// rebuild or restyle the whole scrollback.
func (t *transcript) viewSelection() string {
	if t.width < 1 || t.height < 1 {
		return ""
	}
	start, end := t.sel.normalized()
	style := lipgloss.NewStyle().Width(t.width).MaxWidth(t.width)
	lines := make([]string, 0, t.height)
	for row := 0; row < t.height; row++ {
		index := t.vp.YOffset + row
		line := ""
		if index >= 0 && index < len(t.content) {
			line = t.content[index]
		}
		if index >= start.line && index <= end.line {
			width := ansi.StringWidth(line)
			from, to := 0, width
			if index == start.line {
				from = clampInt(start.col, 0, width)
			}
			if index == end.line {
				to = clampInt(end.col, 0, width)
			}
			if to > from {
				line = highlightCells(line, from, to)
			}
		}
		lines = append(lines, style.Render(line))
	}
	return strings.Join(lines, "\n")
}

// highlightCells wraps the cell range [from,to) in reverse video while
// preserving the existing SGR styling. Graphemes that straddle a boundary are
// included whole.
func highlightCells(s string, from, to int) string {
	if to <= from {
		return s
	}
	var out strings.Builder
	selected := false
	walkCells(s, func(seq string, width, col int, escape bool) bool {
		if width == 0 {
			out.WriteString(seq)
			// A reset inside the selection would also clear reverse video.
			if selected && isSGR(seq) {
				out.WriteString("\x1b[7m")
			}
			return true
		}
		inRange := col < to && col+width > from
		switch {
		case inRange && !selected:
			out.WriteString("\x1b[7m")
			out.WriteString(seq)
			selected = true
		case inRange:
			out.WriteString(seq)
		case selected:
			out.WriteString("\x1b[27m")
			out.WriteString(seq)
			selected = false
		default:
			out.WriteString(seq)
		}
		return true
	})
	if selected {
		out.WriteString("\x1b[27m")
	}
	return out.String()
}

// plainCells returns the text of the cell range [from,to) without ANSI
// sequences. Graphemes that straddle a boundary are included whole.
func plainCells(s string, from, to int) string {
	if to <= from {
		return ""
	}
	var out strings.Builder
	walkCells(s, func(seq string, width, col int, escape bool) bool {
		if width == 0 {
			return true
		}
		if col+width <= from {
			return true
		}
		if col >= to {
			return false
		}
		out.WriteString(seq)
		return true
	})
	return out.String()
}

// walkCells visits every escape sequence and grapheme of a rendered line.
// width is zero for escape sequences and the number of terminal cells for
// printable graphemes; col is the starting cell.
func walkCells(s string, fn func(seq string, width, col int, escape bool) bool) {
	var state byte
	col := 0
	for len(s) > 0 {
		seq, width, n, newState := ansi.DecodeSequence(s, state, nil)
		if n <= 0 {
			return
		}
		if !fn(seq, width, col, width == 0 && strings.HasPrefix(seq, "\x1b")) {
			return
		}
		if width > 0 {
			col += width
		}
		s = s[n:]
		state = newState
	}
}

func isSGR(seq string) bool {
	return len(seq) >= 3 && strings.HasPrefix(seq, "\x1b[") && strings.HasSuffix(seq, "m")
}

// normalizeContent expands tabs so selection columns match what the terminal
// displays. It is a no-op for lines without tabs.
func normalizeContent(s string) []string {
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		if strings.ContainsRune(line, '\t') {
			lines[i] = expandTabs(line)
		}
	}
	return lines
}

// expandTabs replaces tabs with spaces at tabWidth stops while leaving ANSI
// sequences and wide characters untouched.
func expandTabs(s string) string {
	var out strings.Builder
	var state byte
	col := 0
	for len(s) > 0 {
		seq, width, n, newState := ansi.DecodeSequence(s, state, nil)
		if n <= 0 {
			out.WriteString(s)
			break
		}
		if seq == "\t" {
			spaces := tabWidth - col%tabWidth
			out.WriteString(strings.Repeat(" ", spaces))
			col += spaces
		} else {
			out.WriteString(seq)
			if width > 0 {
				col += width
			}
		}
		s = s[n:]
		state = newState
	}
	return out.String()
}

func clampInt(value, low, high int) int {
	if high < low {
		return low
	}
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

// composerTop is the terminal row of the composer's top rule. It mirrors the
// frame composition in View and layout.
func (m *Model) composerTop() int {
	top := 1 + m.body + 1 + m.activityRows()
	if m.completion.visible && m.overlay == nil {
		top += minInt(len(m.completion.filtered), 6) + 2
	}
	return top
}

// composerColumn maps a terminal column to a text column inside the editor.
// The editor pads one column on each side; clicks in the padding and on the
// scrollbar clamp to the nearest text cell.
func (m *Model) composerColumn(x int) int {
	col := x - m.frameIndent() - 1
	return clampInt(col, 0, m.composer.textWidth())
}

// composerCell reports whether a terminal cell is on the editor's text rows.
func (m *Model) composerCell(x, y int) (int, bool) {
	if m.composer == nil || !m.ready {
		return 0, false
	}
	top := m.composerTop() + 1 // first row inside the top rule
	if y < top || y >= top+m.composer.Height() {
		return 0, false
	}
	left := m.frameIndent()
	if x < left || x >= left+m.frameWidth() {
		return 0, false
	}
	return y - top, true
}

// handleComposerMouse routes clicks and drags over the prompt editor. A plain
// click places the caret; a drag selects text and copies it on release.
func (m *Model) handleComposerMouse(msg tea.MouseMsg) (tea.Model, tea.Cmd, bool) {
	if m.composer == nil {
		return m, nil, false
	}
	switch msg.Action {
	case tea.MouseActionPress:
		if msg.Button != tea.MouseButtonLeft {
			return m, nil, false
		}
		row, ok := m.composerCell(msg.X, msg.Y)
		if !ok {
			return m, nil, false
		}
		if m.transcript != nil {
			m.transcript.ClearSelection()
		}
		m.composer.BeginSelection(row, m.composerColumn(msg.X))
		return m, nil, true

	case tea.MouseActionMotion:
		if !m.composer.IsDragging() {
			return m, nil, false
		}
		row := msg.Y - (m.composerTop() + 1)
		m.composer.DragSelection(row, m.composerColumn(msg.X))
		return m, nil, true

	case tea.MouseActionRelease:
		if !m.composer.IsDragging() {
			return m, nil, false
		}
		text := m.composer.EndSelection()
		if text == "" {
			return m, nil, true
		}
		return m, m.copySelection(text), true
	}
	return m, nil, false
}

// handleMouse routes mouse events between transcript selection and the
// viewport's wheel scrolling.
func (m *Model) handleMouse(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	switch msg.Button {
	case tea.MouseButtonWheelUp, tea.MouseButtonWheelDown,
		tea.MouseButtonWheelLeft, tea.MouseButtonWheelRight:
		if m.transcript.HasSelection() {
			// Horizontal scrolling is disabled while a selection is visible;
			// the selection renderer assumes the content starts at column 0.
			if msg.Shift || msg.Button == tea.MouseButtonWheelLeft || msg.Button == tea.MouseButtonWheelRight {
				return m, nil
			}
		}
		return m, m.transcript.Update(msg)
	}

	if m.overlay != nil {
		return m, nil
	}

	// Modified drags are left to the terminal so Shift+drag can use the
	// terminal's native selection even while mouse capture is on.
	if msg.Shift || msg.Alt {
		if msg.Action != tea.MouseActionRelease {
			return m, nil
		}
	}

	if model, cmd, handled := m.handleComposerMouse(msg); handled {
		return model, cmd
	}

	// The frame is inset by a blank gutter on each side, so terminal columns
	// are shifted by the indent before they reach the transcript.
	localX := msg.X - m.frameIndent()
	localY := msg.Y - 1 // the header occupies the first row
	switch msg.Action {
	case tea.MouseActionPress:
		if msg.Button != tea.MouseButtonLeft {
			return m, nil
		}
		if m.composer != nil {
			m.composer.ClearSelection()
		}
		if localY < 0 || localY >= m.body {
			m.transcript.ClearSelection()
			return m, nil
		}
		m.transcript.BeginSelection(localX, localY)
		return m, nil

	case tea.MouseActionMotion:
		if !m.transcript.IsDragging() {
			return m, nil
		}
		m.transcript.DragSelection(localX, localY)
		return m, nil

	case tea.MouseActionRelease:
		if !m.transcript.IsDragging() {
			return m, nil
		}
		text := m.transcript.EndSelection()
		if text == "" {
			return m, nil
		}
		return m, m.copySelection(text)
	}

	return m, nil
}

// toggleMouse flips terminal mouse capture. With capture off the terminal
// handles drag-to-select and copy natively, but the wheel no longer reaches
// the transcript.
func (m *Model) toggleMouse() tea.Cmd {
	m.mouseOn = !m.mouseOn
	if m.mouseOn {
		m.setToast("mouse capture on · drag to select · shift+drag for terminal selection")
		return func() tea.Msg { return tea.EnableMouseCellMotion() }
	}
	m.transcript.ClearSelection()
	if m.composer != nil {
		m.composer.ClearSelection()
	}
	m.setToast("mouse capture off · terminal selection · pgup/pgdn to scroll")
	return func() tea.Msg { return tea.DisableMouse() }
}
