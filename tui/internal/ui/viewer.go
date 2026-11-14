package ui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// viewerState is the read-only page that shows one long text, such as the
// system prompt pi publishes over the bridge. It holds the source text for
// copying and the lines wrapped for the width they were wrapped at, so neither
// scrolling nor a repaint re-wraps the text.
type viewerState struct {
	text   string
	lines  []string
	width  int
	rows   int
	scroll int
}

// newViewerOverlay builds the read-only page for text. It is a page like
// Settings rather than a dialog: the text is the whole point, so it takes the
// transcript area and only gives up its border columns.
func newViewerOverlay(title, text string) *overlay {
	return &overlay{
		kind:   overlayViewer,
		action: "viewer",
		title:  title,
		viewer: viewerState{text: text},
	}
}

// wrap caches the text wrapped to width. A line that already fits is kept as
// it is, so a prompt of mostly short lines costs one width check per line
// instead of a full wrap.
func (v *viewerState) wrap(width int) {
	if width < 1 {
		width = 1
	}
	if v.width == width && v.lines != nil {
		return
	}
	v.width = width
	v.lines = make([]string, 0, strings.Count(v.text, "\n")+1)
	for _, line := range strings.Split(v.text, "\n") {
		line = strings.TrimSuffix(line, "\r")
		if strings.Contains(line, "\t") {
			// A tab outside the wrap would keep its terminal width and push the
			// row past the page, so expand it before measuring.
			line = strings.ReplaceAll(line, "\t", "    ")
		}
		if lipglossWidth(line) <= width {
			v.lines = append(v.lines, line)
			continue
		}
		v.lines = append(v.lines, strings.Split(wrapPlain(line, width), "\n")...)
	}
	v.clamp()
}

// clamp keeps the first visible row inside the text: the page cannot scroll
// past its last screenful, and a resize cannot leave it below the end.
func (v *viewerState) clamp() {
	maxScroll := len(v.lines) - v.rows
	if maxScroll < 0 {
		maxScroll = 0
	}
	switch {
	case v.scroll < 0:
		v.scroll = 0
	case v.scroll > maxScroll:
		v.scroll = maxScroll
	}
}

func (v *viewerState) scrollBy(delta int) {
	v.scroll += delta
	v.clamp()
}

// pageRows is one screenful minus a line, so paging keeps one row of context
// and the reader can see where the previous page ended.
func (v *viewerState) pageRows() int {
	if v.rows <= 2 {
		return 1
	}
	return v.rows - 1
}

// handleViewerKey routes keys on the read-only page. Nothing is editable there,
// so every printable key is free for pager-style navigation.
func (m *Model) handleViewerKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	o := m.overlay
	v := &o.viewer
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "esc", "q":
		m.closeOverlay()
	case "up", "k", "ctrl+p":
		v.scrollBy(-1)
	case "down", "j", "ctrl+n":
		v.scrollBy(1)
	case "pgup", "b":
		v.scrollBy(-v.pageRows())
	case "pgdown", " ", "f":
		v.scrollBy(v.pageRows())
	case "home", "g":
		v.scrollBy(-len(v.lines))
	case "end", "G":
		v.scrollBy(len(v.lines))
	case "y":
		return m, m.copySelection(v.text)
	}
	return m, nil
}

// renderViewer draws the page: a head with the visible row range, the text
// rows, and one hint line.
func (o *overlay) renderViewer(st styles) string {
	textWidth := maxInt(20, o.width-4)
	contentRows := maxInt(4, o.height-4)
	// Three fixed rows: head, rule, and hint.
	o.viewer.rows = maxInt(1, contentRows-3)
	o.viewer.wrap(textWidth)
	o.viewer.clamp()

	last := o.viewer.scroll + o.viewer.rows
	if last > len(o.viewer.lines) {
		last = len(o.viewer.lines)
	}
	position := "empty"
	if len(o.viewer.lines) > 0 {
		position = fmt.Sprintf("%d-%d of %d", o.viewer.scroll+1, last, len(o.viewer.lines))
	}

	out := make([]string, 0, contentRows)
	out = append(out, padBetween(st.overlayHead.Render(o.title), st.overlayHint.Render(position), textWidth))
	out = append(out, st.settingsRule.Render(strings.Repeat("\u2500", textWidth)))
	for i := 0; i < o.viewer.rows; i++ {
		index := o.viewer.scroll + i
		if index >= len(o.viewer.lines) {
			out = append(out, "")
			continue
		}
		// The wrap cache already broke every line to the content width, so a
		// row needs no further truncation.
		out = append(out, o.viewer.lines[index])
	}
	hint := "y copy \u00b7 esc close"
	if len(o.viewer.lines) > o.viewer.rows {
		// Keep the scroll keys on a narrow page: the full hint is the first
		// thing to drop, esc and copy are not.
		hint = "\u2191/\u2193 scroll \u00b7 g/G ends \u00b7 " + hint
		full := "\u2191/\u2193 scroll \u00b7 pgup/pgdown page \u00b7 g/G ends \u00b7 y copy \u00b7 esc close"
		if lipglossWidth(full) <= textWidth {
			hint = full
		}
	}
	out = append(out, st.overlayHint.Render(truncateLine(hint, textWidth)))

	boxHeight := o.height - 2
	if boxHeight < 3 {
		boxHeight = 3
	}
	return st.overlayBox.Copy().Width(o.width).Height(boxHeight).Render(strings.Join(out, "\n"))
}
