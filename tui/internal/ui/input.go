package ui

import (
	"sort"
	"strings"
	"unicode"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/mattn/go-runewidth"
)

// composerMaxRows caps the number of rows the composer shows before the rest
// of the buffer scrolls. It matches the cap of most chat composers: enough for
// a paragraph, not so much that the transcript disappears.
const composerMaxRows = 8

const composerPlaceholder = "Ask pi anything…  (ctrl+p for commands · /help)"

// composerRow is one visual row of the buffer after soft wrapping. Rows are
// contiguous slices of the buffer: end is the index of the wrapping point, a
// newline, or the buffer length.
type composerRow struct {
	start int
	end   int
}

// composerSelection tracks a mouse selection over buffer rune indices. The
// anchor is where the drag started and cursor is the moving end.
type composerSelection struct {
	active   bool
	dragging bool
	moved    bool
	anchor   int
	cursor   int
}

func (s composerSelection) normalized() (int, int) {
	if s.anchor > s.cursor {
		return s.cursor, s.anchor
	}
	return s.anchor, s.cursor
}

// composer is the multi-line prompt editor. It is a small, self-contained
// editor instead of a wrapped textarea widget so the cursor, the soft wrapping,
// the scroll offset and the box height always agree.
//
// Enter submits, so newline insertion is bound to explicit chords. Vertical
// movement follows visual rows (wrapped lines included) and keeps a sticky
// column, the way full-screen editors behave.
type composer struct {
	styles styles

	value  []rune
	cursor int // rune index of the caret, 0..len(value)

	width   int // content columns inside the editor box, scrollbar included
	maxRows int // configured upper bound, lowered on very short terminals
	visible int // rows currently reserved by the box
	rows    []composerRow
	scroll  int // index of the first visible row
	goalCol int // sticky column for vertical movement, -1 when unset

	sel composerSelection

	history []string
	histAt  int
	draft   string
}

func newComposer(st styles) *composer {
	c := &composer{
		styles:  st,
		width:   80,
		maxRows: composerMaxRows,
		visible: 1,
		goalCol: -1,
		histAt:  -1,
	}
	c.rewrap()
	return c
}

// SetWidth sets the content width of the editor box. One column is reserved
// for the scrollbar so the buffer does not rewrap when it appears.
func (c *composer) SetWidth(width int) {
	if width < 10 {
		width = 10
	}
	if c.width == width {
		return
	}
	c.width = width
	c.rewrap()
}

// SetMaxRows lowers the visible row cap so the composer fits a short terminal.
// The configured cap is always the upper bound, so growing the terminal again
// restores it.
func (c *composer) SetMaxRows(rows int) {
	rows = minInt(rows, composerMaxRows)
	if rows < 1 {
		rows = 1
	}
	if c.maxRows == rows {
		return
	}
	c.maxRows = rows
	c.updateViewport()
}

// SetStyles swaps the palette used by the editor.
func (c *composer) SetStyles(st styles) {
	c.styles = st
}

func (c *composer) Value() string { return string(c.value) }
func (c *composer) Height() int   { return c.visible }
func (c *composer) Empty() bool   { return strings.TrimSpace(string(c.value)) == "" }

func (c *composer) Reset() {
	c.value = nil
	c.cursor = 0
	c.scroll = 0
	c.goalCol = -1
	c.sel = composerSelection{}
	c.histAt = -1
	c.draft = ""
	c.rewrap()
}

// Clear empties the editor and keeps the draft recallable with the up arrow,
// so a stray ctrl+c cannot destroy a long prompt.
func (c *composer) Clear() {
	if strings.TrimSpace(string(c.value)) != "" {
		c.PushHistory(string(c.value))
	}
	c.Reset()
}

// SetText replaces the content and moves the cursor to the end.
func (c *composer) SetText(value string) {
	c.value = []rune(normalizeComposerText(value))
	c.cursor = len(c.value)
	c.goalCol = -1
	c.sel = composerSelection{}
	c.rewrap()
}

func (c *composer) InsertNewline() {
	c.insert("\n")
}

// TakeNewlineEscape replaces a trailing backslash with a newline. It gives
// terminals that cannot report shift+enter a portable newline chord, which is
// also what Codex and Claude Code accept.
func (c *composer) TakeNewlineEscape() bool {
	if c.cursor != len(c.value) || len(c.value) == 0 {
		return false
	}
	if c.value[len(c.value)-1] != '\\' {
		return false
	}
	c.splice(len(c.value)-1, len(c.value))
	c.insert("\n")
	return true
}

// Update applies one input message to the buffer.
func (c *composer) Update(msg tea.Msg) tea.Cmd {
	key, ok := msg.(tea.KeyMsg)
	if !ok {
		return nil
	}
	// Any keystroke ends a display-only selection and puts the caret back
	// under the text cursor.
	c.ClearSelection()

	switch key.Type {
	case tea.KeyRunes:
		if key.Alt {
			// Alt chords are shortcuts, never text.
			switch string(key.Runes) {
			case "f", "F":
				c.moveWord(1)
			case "b", "B":
				c.moveWord(-1)
			case "d", "D":
				c.deleteWordForward()
			}
			return nil
		}
		c.insert(string(key.Runes))

	case tea.KeySpace:
		if key.Alt {
			return nil
		}
		c.insert(" ")

	case tea.KeyEnter, tea.KeyCtrlJ:
		c.InsertNewline()

	case tea.KeyBackspace, tea.KeyCtrlH:
		if key.Alt {
			c.deleteWordBackward()
		} else {
			c.deleteBackward()
		}

	case tea.KeyDelete, tea.KeyCtrlD:
		if key.Alt {
			c.deleteWordForward()
		} else {
			c.deleteForward()
		}

	case tea.KeyLeft, tea.KeyCtrlB:
		c.moveCursor(-1)

	case tea.KeyRight, tea.KeyCtrlF:
		c.moveCursor(1)

	case tea.KeyCtrlLeft:
		c.moveWord(-1)

	case tea.KeyCtrlRight:
		c.moveWord(1)

	case tea.KeyCtrlW:
		c.deleteWordBackward()

	case tea.KeyUp:
		c.MoveUp()

	case tea.KeyDown:
		c.MoveDown()

	case tea.KeyHome, tea.KeyCtrlA:
		c.moveLineStart()

	case tea.KeyEnd, tea.KeyCtrlE:
		c.moveLineEnd()

	case tea.KeyCtrlHome:
		c.jumpTo(0)

	case tea.KeyCtrlEnd:
		c.jumpTo(len(c.value))
	}
	return nil
}

// MoveUp moves the caret one visual row up, preserving the sticky column.
// It reports false when the caret already sits on the first row, which lets
// the caller fall back to prompt history.
func (c *composer) MoveUp() bool {
	row := c.cursorRow()
	if row == 0 {
		return false
	}
	col := c.goalCol
	if col < 0 {
		col = c.cursorColumn()
	}
	c.cursor = c.cursorAtColumn(row-1, col)
	c.goalCol = col
	c.updateViewport()
	return true
}

// MoveDown mirrors MoveUp.
func (c *composer) MoveDown() bool {
	row := c.cursorRow()
	if row >= len(c.rows)-1 {
		return false
	}
	col := c.goalCol
	if col < 0 {
		col = c.cursorColumn()
	}
	c.cursor = c.cursorAtColumn(row+1, col)
	c.goalCol = col
	c.updateViewport()
	return true
}

// HasSelection reports whether a non-empty range is highlighted.
func (c *composer) HasSelection() bool {
	_, _, ok := c.selectionRange()
	return ok
}

// IsDragging reports whether the left mouse button is selecting.
func (c *composer) IsDragging() bool { return c.sel.dragging }

// BeginSelection parks the caret at a viewport-relative cell and starts a
// selection there. A plain click is the mouse equivalent of placing the caret.
func (c *composer) BeginSelection(row, col int) {
	index := c.indexAtViewportCell(row, col)
	c.cursor = index
	c.goalCol = -1
	c.sel = composerSelection{active: true, dragging: true, anchor: index, cursor: index}
	c.updateViewport()
}

// DragSelection extends the selection to a viewport-relative cell. A drag
// outside the visible rows scrolls the editor one row per event.
func (c *composer) DragSelection(row, col int) {
	if !c.sel.dragging {
		return
	}
	if row < 0 {
		if c.scroll > 0 {
			c.scroll--
		}
		row = 0
	} else if row >= c.visible {
		if c.scroll+c.visible < len(c.rows) {
			c.scroll++
		}
		row = c.visible - 1
	}
	index := c.indexAtViewportCell(row, col)
	if index != c.sel.anchor {
		c.sel.moved = true
	}
	c.sel.cursor = index
	c.cursor = index
}

// EndSelection finishes a drag. It returns the selected text only when the
// pointer actually moved; a plain click leaves the caret where it landed.
func (c *composer) EndSelection() string {
	if !c.sel.dragging {
		return ""
	}
	c.sel.dragging = false
	if !c.sel.moved || c.sel.anchor == c.sel.cursor {
		c.ClearSelection()
		return ""
	}
	return c.SelectedText()
}

// ClearSelection removes the highlight without moving the caret.
func (c *composer) ClearSelection() { c.sel = composerSelection{} }

// SelectedText returns the highlighted range as plain text.
func (c *composer) SelectedText() string {
	start, end, ok := c.selectionRange()
	if !ok {
		return ""
	}
	return string(c.value[start:end])
}

// selectionRange returns the highlighted rune range in reading order.
func (c *composer) selectionRange() (int, int, bool) {
	if !c.sel.active || c.sel.anchor == c.sel.cursor {
		return 0, 0, false
	}
	start, end := c.sel.normalized()
	start = clampInt(start, 0, len(c.value))
	end = clampInt(end, 0, len(c.value))
	if start >= end {
		return 0, 0, false
	}
	return start, end, true
}

// indexAtViewportCell maps a visible editor cell to the nearest rune index.
// Clicking past the end of a row parks the caret at that row's end.
func (c *composer) indexAtViewportCell(row, col int) int {
	if len(c.rows) == 0 {
		return 0
	}
	row = clampInt(row, 0, maxInt(0, c.visible-1))
	index := c.scroll + row
	if index >= len(c.rows) {
		index = len(c.rows) - 1
	}
	bound := c.rows[index]
	col = clampInt(col, 0, c.textWidth())

	at := bound.start
	width := 0
	for at < bound.end {
		step := runeWidth(c.value[at])
		if col < width+step {
			return at
		}
		width += step
		at++
	}
	return bound.end
}

// PushHistory records a submitted prompt.
func (c *composer) PushHistory(value string) {
	if strings.TrimSpace(value) == "" {
		return
	}
	if len(c.history) == 0 || c.history[len(c.history)-1] != value {
		c.history = append(c.history, value)
	}
	if len(c.history) > 100 {
		c.history = c.history[len(c.history)-100:]
	}
	c.histAt = -1
	c.draft = ""
}

// HistoryPrev replaces the editor with the previous submitted prompt.
func (c *composer) HistoryPrev() bool {
	if len(c.history) == 0 {
		return false
	}
	if c.histAt == -1 {
		c.draft = string(c.value)
		c.histAt = len(c.history) - 1
	} else if c.histAt > 0 {
		c.histAt--
	} else {
		return false
	}
	c.SetText(c.history[c.histAt])
	return true
}

// HistoryNext walks forward through submitted prompts.
func (c *composer) HistoryNext() bool {
	if c.histAt == -1 {
		return false
	}
	if c.histAt < len(c.history)-1 {
		c.histAt++
		c.SetText(c.history[c.histAt])
		return true
	}
	c.histAt = -1
	c.SetText(c.draft)
	return true
}

// View renders exactly Height() rows of the buffer, each padded to the box's
// content width and followed by a scrollbar cell when the buffer overflows.
func (c *composer) View() string {
	width := c.textWidth()

	var out strings.Builder
	if len(c.value) == 0 {
		out.WriteString(c.placeholderLine(width))
		out.WriteString(c.scrollbarCell(0))
		return out.String()
	}

	cursorRow := c.cursorRow()
	for i := 0; i < c.visible; i++ {
		if i > 0 {
			out.WriteByte('\n')
		}
		row := c.scroll + i
		if row >= len(c.rows) {
			out.WriteString(strings.Repeat(" ", width))
		} else {
			out.WriteString(c.renderRow(row, row == cursorRow, width))
		}
		out.WriteString(c.scrollbarCell(row))
	}
	return out.String()
}

// renderRow draws one visual row, the caret on its cell when this row owns
// the cursor, and the mouse selection when it overlaps the row. The caret is
// hidden while a selection is visible so the highlight reads as one block.
func (c *composer) renderRow(index int, cursorHere bool, width int) string {
	row := c.rows[index]
	text := c.value[row.start:row.end]
	used := composerWidth(text)

	selStart, selEnd, selected := c.selectionRange()
	rowSelected := selected && selStart < row.end && selEnd > row.start

	cursorAt := -1
	if cursorHere && !selected {
		offset := c.cursor - row.start
		if offset < 0 {
			offset = 0
		}
		if offset > len(text) {
			offset = len(text)
		}
		// A caret past the last rune needs its own cell. When the row already
		// fills the content width there is no room for it, so park it on the
		// last rune instead of spilling a column into the box border.
		if offset == len(text) && used >= width && len(text) > 0 {
			offset = len(text) - 1
		}
		cursorAt = offset
	}

	const (
		cellPlain = iota
		cellSelected
		cellCursor
	)
	styleAt := func(at int) int {
		if at == cursorAt {
			return cellCursor
		}
		if rowSelected && row.start+at >= selStart && row.start+at < selEnd {
			return cellSelected
		}
		return cellPlain
	}

	var out strings.Builder
	for at := 0; at < len(text); {
		kind := styleAt(at)
		next := at + 1
		for next < len(text) && styleAt(next) == kind {
			next++
		}
		segment := string(text[at:next])
		switch kind {
		case cellCursor:
			out.WriteString(c.styles.editorCursor.Render(segment))
		case cellSelected:
			out.WriteString(c.styles.editorSelection.Render(segment))
		default:
			out.WriteString(c.styles.editorText.Render(segment))
		}
		at = next
	}

	extra := 0
	if cursorAt == len(text) {
		out.WriteString(c.styles.editorCursor.Render(" "))
		extra = 1
	}
	// A newline has no cell of its own. Highlight one trailing cell when the
	// selection includes it so multi-line selections read as continuous.
	if selected && selStart <= row.end && selEnd > row.end && row.end < len(c.value) && c.value[row.end] == '\n' && used+extra < width {
		out.WriteString(c.styles.editorSelection.Render(" "))
		extra++
	}

	pad := width - used - extra
	if pad < 0 {
		pad = 0
	}
	out.WriteString(strings.Repeat(" ", pad))
	return out.String()
}

// placeholderLine shows the hint with the caret parked in front of it.
func (c *composer) placeholderLine(width int) string {
	text := truncateLine(composerPlaceholder, maxInt(0, width-2))
	return c.styles.editorCursor.Render(" ") + " " + c.styles.editorPlaceholder.Render(text)
}

// scrollbarCell renders the one-column track beside the buffer. Rows outside
// the visible area map onto the thumb proportionally.
func (c *composer) scrollbarCell(row int) string {
	if len(c.rows) <= c.visible {
		return " "
	}

	thumb := maxInt(1, c.visible*c.visible/len(c.rows))
	travel := len(c.rows) - c.visible
	start := 0
	if travel > 0 && c.visible > thumb {
		start = c.scroll * (c.visible - thumb) / travel
	}

	index := row - c.scroll
	if index >= start && index < start+thumb {
		return c.styles.scrollThumb.Render("█")
	}
	return c.styles.scrollRail.Render("│")
}

// textWidth is the number of columns available for buffer text.
func (c *composer) textWidth() int {
	width := c.width - 1
	if width < 1 {
		width = 1
	}
	return width
}

// rewrap recomputes the visual rows after a buffer or width change and keeps
// the caret inside the viewport.
func (c *composer) rewrap() {
	c.rows = wrapComposerRows(c.value, c.textWidth())
	c.updateViewport()
}

// updateViewport sizes the visible area and scrolls it so the caret stays in
// view.
func (c *composer) updateViewport() {
	c.visible = minInt(len(c.rows), c.maxRows)
	if c.visible < 1 {
		c.visible = 1
	}

	row := c.cursorRow()
	if row < c.scroll {
		c.scroll = row
	}
	if row >= c.scroll+c.visible {
		c.scroll = row - c.visible + 1
	}
	if limit := len(c.rows) - c.visible; c.scroll > limit {
		c.scroll = limit
	}
	if c.scroll < 0 {
		c.scroll = 0
	}
}

// cursorRow is the visual row that owns the caret. The same index can close
// one row and open the next at a soft wrap; the later row owns it, so the
// caret is drawn at the start of the wrapped line.
func (c *composer) cursorRow() int {
	row := 0
	for i := range c.rows {
		if c.rows[i].start > c.cursor {
			break
		}
		row = i
	}
	return row
}

// cursorColumn is the caret's display column inside its visual row.
func (c *composer) cursorColumn() int {
	row := c.rows[c.cursorRow()]
	return composerWidth(c.value[row.start:c.cursor])
}

// cursorAtColumn finds the rune index nearest to col in the given row without
// crossing into a double-width rune.
func (c *composer) cursorAtColumn(row, col int) int {
	bound := c.rows[row]
	index := bound.start
	width := 0
	for index < bound.end {
		step := runeWidth(c.value[index])
		if width+step > col {
			break
		}
		width += step
		index++
	}
	// A soft-wrapped row cannot own the caret past its last rune: that index
	// belongs to the next row, which would make vertical movement stall. Step
	// back so the caret stays on the target row.
	if index > bound.start && row+1 < len(c.rows) && c.rows[row+1].start == index {
		index--
	}
	return index
}

func (c *composer) moveCursor(delta int) {
	c.jumpTo(c.cursor + delta)
}

func (c *composer) jumpTo(index int) {
	if index < 0 {
		index = 0
	}
	if index > len(c.value) {
		index = len(c.value)
	}
	c.cursor = index
	c.goalCol = -1
	c.updateViewport()
}

func (c *composer) moveLineStart() {
	start := c.cursor
	for start > 0 && c.value[start-1] != '\n' {
		start--
	}
	c.jumpTo(start)
}

func (c *composer) moveLineEnd() {
	end := c.cursor
	for end < len(c.value) && c.value[end] != '\n' {
		end++
	}
	c.jumpTo(end)
}

func (c *composer) moveWord(delta int) {
	if delta < 0 {
		c.jumpTo(c.wordStart(c.cursor))
		return
	}
	c.jumpTo(c.wordEnd(c.cursor))
}

func (c *composer) deleteBackward() {
	if c.cursor == 0 {
		return
	}
	c.splice(c.cursor-1, c.cursor)
}

func (c *composer) deleteForward() {
	if c.cursor >= len(c.value) {
		return
	}
	c.splice(c.cursor, c.cursor+1)
}

func (c *composer) deleteWordBackward() {
	start := c.wordStart(c.cursor)
	if start < c.cursor {
		c.splice(start, c.cursor)
	}
}

func (c *composer) deleteWordForward() {
	end := c.wordEnd(c.cursor)
	if end > c.cursor {
		c.splice(c.cursor, end)
	}
}

// wordStart is the beginning of the word before index, skipping punctuation
// and whitespace first.
func (c *composer) wordStart(index int) int {
	for index > 0 && !composerWordRune(c.value[index-1]) {
		index--
	}
	for index > 0 && composerWordRune(c.value[index-1]) {
		index--
	}
	return index
}

// wordEnd is the end of the word after index.
func (c *composer) wordEnd(index int) int {
	for index < len(c.value) && !composerWordRune(c.value[index]) {
		index++
	}
	for index < len(c.value) && composerWordRune(c.value[index]) {
		index++
	}
	return index
}

// insert adds text at the caret, expanding tabs and normalising line endings
// so wrapping stays exact.
func (c *composer) insert(text string) {
	text = normalizeComposerText(text)
	if text == "" {
		return
	}
	runes := []rune(text)
	next := make([]rune, 0, len(c.value)+len(runes))
	next = append(next, c.value[:c.cursor]...)
	next = append(next, runes...)
	next = append(next, c.value[c.cursor:]...)
	c.value = next
	c.cursor += len(runes)
	c.commit()
}

// splice removes value[start:end] and parks the caret at start.
func (c *composer) splice(start, end int) {
	if start < 0 {
		start = 0
	}
	if end > len(c.value) {
		end = len(c.value)
	}
	if start >= end {
		return
	}
	next := make([]rune, 0, len(c.value)-(end-start))
	next = append(next, c.value[:start]...)
	next = append(next, c.value[end:]...)
	c.value = next
	c.cursor = start
	c.commit()
}

// commit re-lays the buffer out after an edit. The sticky column only lives
// across consecutive vertical moves, so every edit clears it.
func (c *composer) commit() {
	c.goalCol = -1
	c.rewrap()
}

// wrapComposerRows soft-wraps the buffer at the given display width. Wide
// runes count as two columns so CJK text wraps on the terminal grid.
func wrapComposerRows(value []rune, width int) []composerRow {
	if width < 1 {
		width = 1
	}

	rows := []composerRow{{}}
	col := 0
	for i, r := range value {
		if r == '\n' {
			rows[len(rows)-1].end = i
			rows = append(rows, composerRow{start: i + 1})
			col = 0
			continue
		}
		step := runeWidth(r)
		if col > 0 && col+step > width {
			rows[len(rows)-1].end = i
			rows = append(rows, composerRow{start: i})
			col = 0
		}
		col += step
	}
	rows[len(rows)-1].end = len(value)
	return rows
}

func normalizeComposerText(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = strings.ReplaceAll(text, "\t", "    ")
	// Pasted text can carry escape sequences and other control runes that
	// would corrupt the frame. Keep newlines, drop the rest.
	return strings.Map(func(r rune) rune {
		if r == '\n' {
			return r
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, text)
}

func composerWidth(value []rune) int {
	width := 0
	for _, r := range value {
		width += runeWidth(r)
	}
	return width
}

func runeWidth(r rune) int {
	width := runewidth.RuneWidth(r)
	if width < 1 {
		return 0
	}
	return width
}

// composerWordRune reports whether r belongs to a word for word-wise motion.
func composerWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_'
}

// completionItem is one slash command candidate.
type completionItem struct {
	Value   string // "/model"
	Detail  string // one-line description
	Kind    string // builtin, extension, prompt, skill
	Builtin bool
	Alias   string // canonical name when Value is an alias, e.g. "/model"
}

// completion is the slash command popup state.
type completion struct {
	items    []completionItem
	filtered []completionItem
	cursor   int
	visible  bool
}

func (c *completion) SetItems(items []completionItem) {
	c.items = items
	c.Refresh("")
}

// Refresh recomputes the visible candidates for the current input.
func (c *completion) Refresh(input string) {
	trimmed := strings.TrimSpace(input)
	if !strings.HasPrefix(trimmed, "/") || strings.ContainsAny(trimmed, " \n") {
		c.visible = false
		c.filtered = nil
		c.cursor = 0
		return
	}

	prefix := strings.ToLower(trimmed)
	c.filtered = c.filtered[:0]
	for _, item := range c.items {
		value := strings.ToLower(item.Value)
		if strings.HasPrefix(value, prefix) || strings.Contains(value, prefix) {
			c.filtered = append(c.filtered, item)
		}
	}
	sort.SliceStable(c.filtered, func(i, j int) bool {
		return completionLess(c.filtered[i], c.filtered[j], prefix)
	})
	if c.cursor >= len(c.filtered) {
		c.cursor = maxInt(0, len(c.filtered)-1)
	}
	c.visible = len(c.filtered) > 0
}

func (c *completion) Hide() { c.visible = false }

// completionLess ranks candidates: an exact name beats a prefix match, a prefix
// match beats a substring match, and canonical commands precede their aliases so
// the popup does not open on an alias.
func completionLess(a, b completionItem, prefix string) bool {
	aValue, bValue := strings.ToLower(a.Value), strings.ToLower(b.Value)
	if (aValue == prefix) != (bValue == prefix) {
		return aValue == prefix
	}
	aPrefix := strings.HasPrefix(aValue, prefix)
	bPrefix := strings.HasPrefix(bValue, prefix)
	if aPrefix != bPrefix {
		return aPrefix
	}
	if (a.Alias != "") != (b.Alias != "") {
		return a.Alias == ""
	}
	return a.Value < b.Value
}

func (c *completion) Move(delta int) {
	if len(c.filtered) == 0 {
		return
	}
	c.cursor = (c.cursor + delta + len(c.filtered)) % len(c.filtered)
}

func (c *completion) Selected() (completionItem, bool) {
	if !c.visible || len(c.filtered) == 0 {
		return completionItem{}, false
	}
	if c.cursor >= len(c.filtered) {
		c.cursor = len(c.filtered) - 1
	}
	return c.filtered[c.cursor], true
}
