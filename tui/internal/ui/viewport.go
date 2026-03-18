package ui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/glamour/ansi"
	"github.com/charmbracelet/lipgloss"
	xansi "github.com/charmbracelet/x/ansi"
)

// blockKind classifies one entry of the transcript.
type blockKind int

const (
	blockUser blockKind = iota
	blockAssistant
	blockThinking
	blockTool
	blockDiff
	blockNotice
	blockError
)

// blockStatus is the lifecycle of a tool or notice block.
type blockStatus int

const (
	statusPending blockStatus = iota
	statusRunning
	statusOK
	statusError
)

// block is one rendered unit of the conversation.
//
// Assistant blocks keep a per-markdown-segment render cache so streaming only
// re-renders the unstable tail.
type block struct {
	kind    blockKind
	callID  string
	text    string
	title   string
	summary string     // tool argument preview, plain text
	meta    string     // tool stats: duration, diff counts
	body    string     // tool output or error text
	diff    []diffLine // file mutation rows, already syntax-coloured
	command []string   // shell command rows, already syntax-coloured
	status  blockStatus

	collapsed bool
	streaming bool
	revision  int

	cache struct {
		revision int
		width    int
		value    string
		valid    bool
	}
	stable struct {
		width int
		src   []string
		out   []string
	}
}

func newBlock(kind blockKind, text string) *block {
	return &block{kind: kind, text: text, revision: 1}
}

func (b *block) setText(text string) {
	if b.text == text {
		return
	}
	b.text = text
	b.revision++
}

func (b *block) invalidate() { b.revision++ }

// transcript owns the scrollback: a list of blocks rendered into a viewport.
type transcript struct {
	vp           viewport.Model
	blocks       []*block
	styles       styles
	md           markdownRenderer
	width        int
	height       int
	content      []string // rendered lines with tabs expanded
	sel          textSelection
	resumeFollow bool
	stickBottom  bool
	dirty        bool
}

func newTranscript(st styles) *transcript {
	vp := viewport.New(0, 0)
	vp.MouseWheelEnabled = true
	vp.MouseWheelDelta = 3

	return &transcript{
		vp:          vp,
		styles:      st,
		md:          markdownRenderer{style: st.markdownStyle()},
		stickBottom: true,
		dirty:       true,
	}
}

// SetSize resizes the scrollback area.
func (t *transcript) SetSize(width, height int) {
	if width < 1 {
		width = 1
	}
	if height < 1 {
		height = 1
	}
	if t.width == width && t.height == height {
		return
	}
	t.width, t.height = width, height
	t.vp.Width, t.vp.Height = width, height
	t.ClearSelection()
	t.dirty = true
}

// Add appends a block and schedules a re-render.
func (t *transcript) Add(b *block) {
	t.blocks = append(t.blocks, b)
	t.dirty = true
}

// Clear drops the whole scrollback.
func (t *transcript) Clear() {
	t.blocks = nil
	t.content = nil
	t.sel = textSelection{}
	t.resumeFollow = false
	t.stickBottom = true
	t.dirty = true
	t.vp.SetContent("")
	t.vp.GotoBottom()
}

// Blocks exposes the current blocks without copying.
func (t *transcript) Blocks() []*block { return t.blocks }

// MarkDirty schedules a re-render on the next View.
func (t *transcript) MarkDirty() { t.dirty = true }

// SetStyles swaps the palette and invalidates rendered caches.
func (t *transcript) SetStyles(st styles) {
	t.styles = st
	t.md = markdownRenderer{style: st.markdownStyle()}
	for _, b := range t.blocks {
		b.cache.valid = false
		b.stable.width = 0
		b.invalidate()
	}
	t.dirty = true
}

// LastAssistant returns the most recent assistant block, if any.
func (t *transcript) LastAssistant() *block {
	for i := len(t.blocks) - 1; i >= 0; i-- {
		if t.blocks[i].kind == blockAssistant {
			return t.blocks[i]
		}
	}
	return nil
}

// Tool returns the tool block with the given call ID.
func (t *transcript) Tool(callID string) *block {
	for i := len(t.blocks) - 1; i >= 0; i-- {
		if t.blocks[i].callID == callID {
			return t.blocks[i]
		}
	}
	return nil
}

// Update forwards scroll input to the viewport and tracks bottom stickiness.
func (t *transcript) Update(msg tea.Msg) tea.Cmd {
	var cmd tea.Cmd
	if t.sel.active {
		// Scrolling must not re-enable bottom following while the user is
		// looking at a highlighted selection.
		t.vp, cmd = t.vp.Update(msg)
		return cmd
	}
	wasSticky := t.stickBottom
	t.vp, cmd = t.vp.Update(msg)
	if wasSticky && t.vp.AtBottom() {
		t.stickBottom = true
	} else {
		t.stickBottom = t.vp.AtBottom()
	}
	return cmd
}

// View renders the visible slice of the scrollback.
func (t *transcript) View() string {
	if t.dirty {
		t.rebuild()
	}
	if t.sel.active {
		return t.viewSelection()
	}
	return t.vp.View()
}

// AtBottom reports whether the viewport is scrolled to the newest content.
func (t *transcript) AtBottom() bool { return t.vp.AtBottom() }

// ScrollToBottom pins the viewport to the newest content.
func (t *transcript) ScrollToBottom() {
	t.ClearSelection()
	t.stickBottom = true
	t.vp.GotoBottom()
}

func (t *transcript) rebuild() {
	if t.width <= 0 || t.height <= 0 {
		return
	}
	parts := make([]string, 0, len(t.blocks))
	for _, b := range t.blocks {
		if out := t.render(b); out != "" {
			parts = append(parts, out)
		}
	}
	joined := strings.Join(parts, "\n\n")
	if joined == "" {
		t.content = nil
	} else {
		t.content = normalizeContent(joined)
	}
	t.vp.SetContent(strings.Join(t.content, "\n"))
	t.clampSelection()
	if t.stickBottom {
		t.vp.GotoBottom()
	}
	t.dirty = false
}

func (t *transcript) render(b *block) string {
	width := t.width
	if width < 8 {
		width = 8
	}

	if !b.streaming && b.cache.valid && b.cache.revision == b.revision && b.cache.width == width {
		return b.cache.value
	}

	var out string
	switch b.kind {
	case blockUser:
		out = t.renderUser(b, width)
	case blockAssistant:
		out = t.renderAssistant(b, width)
	case blockThinking:
		out = t.renderThinking(b, width)
	case blockTool:
		out = t.renderTool(b, width)
	case blockDiff:
		out = t.renderDiffBlock(b, width)
	case blockNotice:
		out = renderNotice(b.text, width, t.styles.notice)
	case blockError:
		out = renderNotice(b.text, width, t.styles.errorText)
	}

	// Only finished blocks are cached: a streaming block re-renders every tick,
	// and caching its intermediate output would let a stale segmented render
	// win over the whole-document render when the stream ends.
	if !b.streaming {
		b.cache.value = out
		b.cache.revision = b.revision
		b.cache.width = width
		b.cache.valid = true
	}
	return out
}

func (t *transcript) renderUser(b *block, width int) string {
	prefix := t.styles.userPrefix.Render("› ")
	body := b.text
	if strings.TrimSpace(body) == "" {
		body = "(empty message)"
	}
	// Indent continuation lines under the prefix without reflowing the user's
	// own line breaks.
	lines := strings.Split(body, "\n")
	var out strings.Builder
	for i, line := range lines {
		if i == 0 {
			out.WriteString(prefix)
		} else {
			out.WriteString("  ")
		}
		out.WriteString(t.styles.userText.Width(width - 2).Render(line))
		out.WriteString("\n")
	}
	return strings.TrimRight(out.String(), "\n")
}

func (t *transcript) renderAssistant(b *block, width int) string {
	text := strings.TrimSuffix(b.text, "\n")
	if strings.TrimSpace(text) == "" {
		return ""
	}

	// A finished message is rendered as a single document, so lists, loose
	// lists, and quotes keep their structure and the blocks are spaced the way
	// glamour spaces a whole document. Streaming keeps the segment cache below
	// so only the growing tail is re-rendered.
	if !b.streaming {
		// The segment cache only serves streaming; the finished block is cached
		// as a whole by the transcript.
		b.stable.src = nil
		b.stable.out = nil
		return t.md.render(text, width)
	}

	split := splitMarkdown(text)
	stable := &b.stable
	if stable.width != width {
		stable.width = width
		stable.src = nil
		stable.out = nil
	}
	if len(stable.src) > len(split.stable) {
		stable.src = stable.src[:len(split.stable)]
		stable.out = stable.out[:len(split.stable)]
	}
	for i, segment := range split.stable {
		if i < len(stable.src) && stable.src[i] == segment {
			continue
		}
		rendered := t.md.render(segment, width)
		if i < len(stable.src) {
			stable.src[i] = segment
			stable.out[i] = rendered
		} else {
			stable.src = append(stable.src, segment)
			stable.out = append(stable.out, rendered)
		}
	}

	parts := make([]string, 0, len(stable.out)+1)
	parts = append(parts, stable.out...)
	if split.tail != "" {
		tail := split.tail
		if split.fenceOpen {
			// Close the open fence so the tail renders as code instead of
			// flickering between paragraph and block styling.
			tail += "\n" + strings.Repeat(string(split.fenceChar), split.fenceLen)
		}
		parts = append(parts, t.md.render(tail, width))
	}

	return strings.Join(parts, "\n\n")
}

func (t *transcript) renderThinking(b *block, width int) string {
	head := t.styles.thinkingHead.Render("○ thinking")
	dots := b.meta
	if dots != "" {
		head = t.styles.thinkingHead.Render("○ thinking · " + dots)
	}
	if b.collapsed || strings.TrimSpace(b.text) == "" {
		return head
	}
	body := t.styles.thinkingBody.Width(width - 2).Render(strings.TrimRight(b.text, "\n"))
	return head + "\n" + indentLines(body, "  ")
}

// Auto-preview thresholds keep the transcript scannable the way mature CLI
// agents do: short command output and small diffs stay visible like a
// terminal session while longer bodies fold to their one-line summary.
// Ctrl+o reveals everything; expandedBodyCap bounds what that renders.
const (
	autoToolPreviewLines = 8
	autoDiffPreviewLines = 16
	expandedBodyCap      = 200
)

// bodyLines counts the rendered lines of a block body.
func bodyLines(body string) int {
	body = strings.TrimRight(body, "\n")
	if body == "" {
		return 0
	}
	return strings.Count(body, "\n") + 1
}

// autoCollapsed reports whether a block's rendered rows exceed its default
// preview size.
func autoCollapsed(kind blockKind, rows int) bool {
	if kind == blockDiff {
		return rows > autoDiffPreviewLines
	}
	return rows > autoToolPreviewLines
}

func (t *transcript) renderTool(b *block, width int) string {
	marker := "~"
	color := t.styles.toolLine
	switch b.status {
	case statusOK:
		marker = "●"
	case statusError:
		marker = "!"
		color = t.styles.errorText
	case statusPending:
		marker = "○"
	}
	if b.status == statusRunning {
		marker = "~"
	}

	head := color.Render(marker) + " " + t.styles.toolName.Render(b.title)
	if b.summary != "" {
		head += " " + t.styles.toolMeta.Render(b.summary)
	}
	if b.meta != "" {
		head += " " + t.styles.toolMeta.Render(b.meta)
	}
	if b.status == statusError {
		head += " " + t.styles.errorText.Render("failed")
	}

	var sections []string
	if len(b.command) > 0 {
		sections = append(sections, t.renderShellCommand(b.command, width))
	}
	if strings.TrimSpace(b.body) != "" {
		lines := strings.Split(strings.TrimRight(b.body, "\n"), "\n")
		if b.collapsed {
			sections = append(sections, t.styles.faint.Render(fmt.Sprintf("… +%d lines (ctrl+o)", len(lines))))
		} else {
			hidden := 0
			if len(lines) > expandedBodyCap {
				hidden = len(lines) - expandedBodyCap
				lines = lines[:expandedBodyCap]
			}
			sections = append(sections, t.styles.toolMeta.Width(width-2).Render(strings.Join(lines, "\n")))
			if hidden > 0 {
				sections = append(sections, t.styles.faint.Render(fmt.Sprintf("… +%d more lines", hidden)))
			}
		}
	}
	if len(sections) == 0 {
		return head
	}
	return head + "\n" + indentLines(strings.Join(sections, "\n"), "  ")
}

// shellCommandLineCap keeps a heredoc or a long script from taking over the
// transcript. The command is the tool card's first section, not its output, so
// it does not follow the output's expand/collapse state.
const shellCommandLineCap = 24

// renderShellCommand draws a shell tool's command above its output: a "$"
// prompt on the first row, a gutter on continuations, and the command's own
// syntax colours. Long rows wrap at the transcript width.
func (t *transcript) renderShellCommand(command []string, width int) string {
	lines := command
	hidden := 0
	if len(lines) > shellCommandLineCap {
		hidden = len(lines) - shellCommandLineCap
		lines = lines[:shellCommandLineCap]
	}
	limit := maxInt(width-4, 1) // block indent and prompt gutter
	var out []string
	for i, line := range lines {
		for j, row := range strings.Split(wrapANSI(expandTabs(line), limit), "\n") {
			lead := "  "
			if i == 0 && j == 0 {
				lead = t.styles.accent.Render("$")
				if row != "" {
					lead += " "
				}
			}
			out = append(out, lead+row)
		}
	}
	if hidden > 0 {
		out = append(out, t.styles.faint.Render(fmt.Sprintf("… +%d lines", hidden)))
	}
	return strings.Join(out, "\n")
}

func (t *transcript) renderDiffBlock(b *block, width int) string {
	marker := t.styles.toolName.Render("●")
	if b.status == statusError {
		marker = t.styles.errorText.Render("!")
	}
	head := marker + " " + t.styles.toolName.Render(b.title)
	if b.meta != "" {
		head += " " + t.renderDiffMeta(b.meta)
	}

	lines := b.diff
	hidden := 0
	if !b.collapsed && len(lines) > expandedBodyCap {
		hidden = len(lines) - expandedBodyCap
		lines = lines[:expandedBodyCap]
	}
	// Two columns of indent, one marker column, one space, then the row text.
	textWidth := maxInt(width-4, 1)
	addTint := diffTint(t.styles.theme.DiffAdd, t.styles.theme.Panel, diffAddTintAlpha)
	delTint := diffTint(t.styles.theme.DiffDel, t.styles.theme.Panel, diffDelTintAlpha)
	var out strings.Builder
	out.WriteString(head)
	if b.collapsed && len(lines) > 0 {
		out.WriteString("\n  " + t.styles.faint.Render(fmt.Sprintf("… +%d lines (ctrl+o)", len(lines))))
		lines = nil
	}
	for _, line := range lines {
		marker := " "
		style := t.styles.diffMeta
		tint := ""
		switch line.kind {
		case '+':
			marker, style, tint = "+", t.styles.diffAdd, addTint
		case '-':
			marker, style, tint = "-", t.styles.diffDel, delTint
		}
		text := xansi.Truncate(expandTabs(line.text), textWidth, "")
		row := style.Render(marker) + " " + text
		if pad := textWidth - lipgloss.Width(text); pad > 0 {
			row += strings.Repeat(" ", pad)
		}
		out.WriteString("\n  ")
		out.WriteString(tintLine(row, tint))
	}
	if hidden > 0 {
		out.WriteString("\n  " + t.styles.faint.Render(fmt.Sprintf("… +%d more lines", hidden)))
	}
	for _, line := range splitLines(b.body) {
		out.WriteString("\n  " + t.styles.errorText.Render("! "+line))
	}
	return out.String()
}

// renderDiffMeta colors the counts in a diff summary such as "+12 -3
// (truncated)": added lines green, removed lines red, anything else dim.
func (t *transcript) renderDiffMeta(meta string) string {
	parts := strings.Fields(meta)
	for i, part := range parts {
		switch {
		case strings.HasPrefix(part, "+") && len(part) > 1:
			parts[i] = t.styles.diffAdd.Render(part)
		case strings.HasPrefix(part, "-") && len(part) > 1:
			parts[i] = t.styles.diffDel.Render(part)
		default:
			parts[i] = t.styles.diffMeta.Render(part)
		}
	}
	return strings.Join(parts, " ")
}

func renderNotice(text string, width int, style lipgloss.Style) string {
	if strings.TrimSpace(text) == "" {
		return ""
	}
	return indentLines(style.Width(width).Render(text), "")
}

func indentLines(s, prefix string) string {
	if prefix == "" {
		return s
	}
	lines := strings.Split(s, "\n")
	for i := range lines {
		if lines[i] == "" {
			continue
		}
		lines[i] = prefix + lines[i]
	}
	return strings.Join(lines, "\n")
}

// markdownRenderer caches one glamour renderer per width.
type markdownRenderer struct {
	style    ansi.StyleConfig
	width    int
	renderer *glamour.TermRenderer
	failed   bool
}

func (m *markdownRenderer) render(src string, width int) string {
	src = strings.TrimSpace(src)
	if src == "" {
		return ""
	}
	renderer := m.rendererFor(width)
	if renderer == nil {
		return wrapPlain(src, width)
	}
	out, err := renderer.Render(src)
	if err != nil {
		return wrapPlain(src, width)
	}
	return trimRendered(out)
}

// trimRendered removes the blank row glamour puts at each edge of a standalone
// document. A list, code block, or quote opens with a newline, and a heading
// ends with a newline followed by the renderer's reset, which TrimRight on
// "\n" cannot reach. Without this, joining segments with one blank line leaves
// two around every heading, list, and fence.
func trimRendered(out string) string {
	lines := strings.Split(out, "\n")
	if len(lines) > 0 && isRenderedBlank(lines[0]) {
		lines = lines[1:]
	}
	if len(lines) > 0 && isRenderedBlank(lines[len(lines)-1]) {
		lines = lines[:len(lines)-1]
	}
	return strings.TrimRight(strings.Join(lines, "\n"), "\n")
}

// isRenderedBlank reports whether a rendered row shows nothing. Glamour pads
// rows with styled spaces, so the row has to be stripped before it is checked.
func isRenderedBlank(line string) bool {
	return strings.TrimSpace(xansi.Strip(line)) == ""
}

func (m *markdownRenderer) rendererFor(width int) *glamour.TermRenderer {
	if m.failed {
		return nil
	}
	if m.renderer != nil && m.width == width {
		return m.renderer
	}
	renderer, err := glamour.NewTermRenderer(
		glamour.WithStyles(m.style),
		glamour.WithWordWrap(width),
		glamour.WithPreservedNewLines(),
	)
	if err != nil {
		m.failed = true
		return nil
	}
	m.renderer = renderer
	m.width = width
	return renderer
}

func wrapPlain(src string, width int) string {
	if width < 1 {
		return src
	}
	return lipgloss.NewStyle().Width(width).Render(src)
}

// markdownSplit separates complete markdown segments from the still-growing
// tail. Segments split on blank lines outside fenced code blocks, lists, and
// blockquotes.
type markdownSplit struct {
	stable    []string
	tail      string
	fenceOpen bool
	fenceChar byte
	fenceLen  int
}

func splitMarkdown(src string) markdownSplit {
	lines := strings.Split(src, "\n")

	var (
		stable       []string
		start        int
		fenceCh      byte
		fenceLen     int
		inList       bool
		inBlockquote bool
	)

	for i, line := range lines {
		if ch, n, ok := fenceMarker(line); ok {
			switch {
			case fenceCh == 0:
				fenceCh, fenceLen = ch, n
			case ch == fenceCh && n >= fenceLen && strings.TrimSpace(strings.TrimLeft(line, " \t")[n:]) == "":
				fenceCh, fenceLen = 0, 0
			}
			continue
		}
		if fenceCh != 0 {
			continue
		}

		if strings.TrimSpace(line) == "" {
			// A blank line inside a list or quote belongs to that block: a loose
			// list keeps its items together, and a quote keeps its paragraphs.
			if inList || inBlockquote {
				next := nextNonBlank(lines, i+1)
				if inList && (listItemLine(next) || indentedLine(next)) {
					continue
				}
				if inBlockquote && (quoteLine(next) || indentedLine(next)) {
					continue
				}
			}
			if i > start {
				stable = append(stable, strings.Join(lines[start:i], "\n"))
			}
			start = i + 1
			inList, inBlockquote = false, false
			continue
		}

		switch {
		case quoteLine(line):
			inBlockquote, inList = true, false
		case listItemLine(line):
			inList, inBlockquote = true, false
		case (inList || inBlockquote) && indentedLine(line):
			// Continuation of the current item or quote paragraph.
		default:
			inList, inBlockquote = false, false
		}
	}

	return markdownSplit{
		stable:    stable,
		tail:      strings.TrimRight(strings.Join(lines[start:], "\n"), "\n"),
		fenceOpen: fenceCh != 0,
		fenceChar: fenceCh,
		fenceLen:  fenceLen,
	}
}

// nextNonBlank is the next line with visible text, or "" at the end.
func nextNonBlank(lines []string, from int) string {
	for i := from; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) != "" {
			return lines[i]
		}
	}
	return ""
}

// listItemLine reports a line that starts a list item, allowing up to three
// spaces of indentation and the "-", "*", "+", "1.", and "1)" markers.
func listItemLine(line string) bool {
	trimmed := strings.TrimLeft(line, " ")
	if len(line)-len(trimmed) > 3 || len(trimmed) < 2 {
		return false
	}
	switch trimmed[0] {
	case '-', '*', '+':
		return trimmed[1] == ' ' || trimmed[1] == '\t'
	}
	digits := 0
	for digits < len(trimmed) && digits < 9 && trimmed[digits] >= '0' && trimmed[digits] <= '9' {
		digits++
	}
	if digits == 0 || digits >= len(trimmed) {
		return false
	}
	if trimmed[digits] != '.' && trimmed[digits] != ')' {
		return false
	}
	rest := digits + 1
	return rest < len(trimmed) && (trimmed[rest] == ' ' || trimmed[rest] == '\t')
}

// indentedLine is a continuation of a list item or blockquote paragraph.
func indentedLine(line string) bool {
	return strings.HasPrefix(line, "\t") || strings.HasPrefix(line, "  ")
}

// quoteLine reports a blockquote line, allowing up to three leading spaces.
func quoteLine(line string) bool {
	trimmed := strings.TrimLeft(line, " ")
	return len(line)-len(trimmed) <= 3 && strings.HasPrefix(trimmed, ">")
}

// fenceMarker reports the fence delimiter of a line, if it starts one.
func fenceMarker(line string) (byte, int, bool) {
	trimmed := strings.TrimLeft(line, " \t")
	if len(trimmed) < 3 {
		return 0, 0, false
	}
	ch := trimmed[0]
	if ch != '`' && ch != '~' {
		return 0, 0, false
	}
	count := 0
	for count < len(trimmed) && trimmed[count] == ch {
		count++
	}
	if count < 3 {
		return 0, 0, false
	}
	return ch, count, true
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
