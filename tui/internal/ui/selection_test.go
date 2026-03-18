package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

func testTranscript(lines ...string) *transcript {
	return testTranscriptSized(20, maxInt(1, len(lines)), lines...)
}

func testTranscriptSized(width, height int, lines ...string) *transcript {
	tr := newTranscript(newStyles(defaultTheme()))
	tr.SetSize(width, height)
	tr.content = lines
	tr.vp.SetContent(strings.Join(lines, "\n"))
	tr.dirty = false
	return tr
}

func TestSelectionTextSingleLine(t *testing.T) {
	tr := testTranscript("hello world")
	tr.BeginSelection(0, 0)
	tr.DragSelection(5, 0)
	if got := tr.EndSelection(); got != "hello" {
		t.Fatalf("selection = %q, want %q", got, "hello")
	}
}

func TestSelectionTextMultiLine(t *testing.T) {
	tr := testTranscript("alpha", "", "beta")
	tr.BeginSelection(2, 0)
	tr.DragSelection(2, 2)
	if got := tr.EndSelection(); got != "pha\n\nbe" {
		t.Fatalf("selection = %q, want %q", got, "pha\n\nbe")
	}
}

func TestSelectionEndingAtColumnZeroDropsFinalLine(t *testing.T) {
	tr := testTranscript("alpha", "beta")
	tr.BeginSelection(2, 0)
	tr.DragSelection(0, 1)
	if got := tr.EndSelection(); got != "pha" {
		t.Fatalf("selection = %q, want %q", got, "pha")
	}
}

func TestSelectionTrimsTrailingSpaces(t *testing.T) {
	tr := testTranscript("alpha   ")
	tr.BeginSelection(0, 0)
	tr.DragSelection(8, 0)
	if got := tr.EndSelection(); got != "alpha" {
		t.Fatalf("selection = %q, want %q", got, "alpha")
	}
}

func TestSelectionWideCharacters(t *testing.T) {
	tr := testTranscript("你好")
	tr.BeginSelection(0, 0)
	tr.DragSelection(2, 0)
	if got := tr.EndSelection(); got != "你" {
		t.Fatalf("selection = %q, want %q", got, "你")
	}
}

func TestSelectionClickWithoutDragClears(t *testing.T) {
	tr := testTranscript("hello")
	tr.BeginSelection(1, 0)
	if got := tr.EndSelection(); got != "" {
		t.Fatalf("selection = %q, want empty", got)
	}
	if tr.HasSelection() {
		t.Fatal("a click should not leave a selection")
	}
}

func TestSelectionUsesViewportOffset(t *testing.T) {
	tr := testTranscriptSized(20, 2, "line0", "line1", "line2", "line3")
	tr.vp.SetYOffset(1)
	tr.BeginSelection(0, 0)
	tr.DragSelection(0, 1)
	if got := tr.EndSelection(); got != "line1\nline2" {
		t.Fatalf("selection = %q, want %q", got, "line1\nline2")
	}
}

func TestDragOutsideScrolls(t *testing.T) {
	tr := testTranscriptSized(20, 2, "line0", "line1", "line2", "line3")
	tr.vp.SetYOffset(2)
	tr.BeginSelection(0, 0)
	tr.DragSelection(0, -1)
	if tr.vp.YOffset != 1 {
		t.Fatalf("YOffset = %d, want 1", tr.vp.YOffset)
	}
	if got := tr.EndSelection(); got != "line1\nline2" {
		t.Fatalf("selection = %q, want %q", got, "line1\nline2")
	}
}

func TestClearSelectionRestoresFollowing(t *testing.T) {
	tr := testTranscript("hello")
	tr.stickBottom = true
	tr.vp.GotoBottom()
	tr.BeginSelection(0, 0)
	if tr.stickBottom {
		t.Fatal("selection should freeze bottom following")
	}
	tr.ClearSelection()
	if !tr.stickBottom {
		t.Fatal("clearing the selection should restore bottom following")
	}
}

func TestViewSelectionHighlightsWithoutLosingStyles(t *testing.T) {
	tr := testTranscript("\x1b[31mred\x1b[0m blue")
	tr.BeginSelection(0, 0)
	tr.DragSelection(3, 0)
	view := tr.View()
	if !strings.Contains(view, "\x1b[7m") {
		t.Fatal("view has no reverse-video highlight")
	}
	if !strings.Contains(view, "\x1b[31m") {
		t.Fatal("view lost the original color")
	}
	if got := strings.TrimRight(ansi.Strip(view), " "); got != "red blue" {
		t.Fatalf("view text = %q, want %q", got, "red blue")
	}
}

func TestHighlightCellsPreservesSGR(t *testing.T) {
	got := highlightCells("\x1b[31mred\x1b[0m blue", 0, 3)
	if !strings.Contains(got, "\x1b[7m") || !strings.Contains(got, "\x1b[31m") {
		t.Fatalf("highlight = %q", got)
	}
	if text := ansi.Strip(got); text != "red blue" {
		t.Fatalf("text = %q, want %q", text, "red blue")
	}
}

func TestPlainCells(t *testing.T) {
	cases := []struct {
		name     string
		line     string
		from, to int
		want     string
	}{
		{name: "styled", line: "\x1b[31mred\x1b[0m blue", from: 0, to: 3, want: "red"},
		{name: "middle", line: "hello", from: 1, to: 4, want: "ell"},
		{name: "wide", line: "你好", from: 0, to: 2, want: "你"},
		{name: "wide boundary", line: "你好", from: 1, to: 3, want: "你好"},
		{name: "empty", line: "hello", from: 3, to: 3, want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := plainCells(tc.line, tc.from, tc.to); got != tc.want {
				t.Fatalf("plainCells = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNormalizeContentExpandsTabs(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{in: "a\tb", want: "a       b"},
		{in: "你\tb", want: "你      b"},
		{in: "\x1b[31m\tb", want: "\x1b[31m        b"},
	}
	for _, tc := range cases {
		lines := normalizeContent(tc.in)
		if len(lines) != 1 || lines[0] != tc.want {
			t.Fatalf("normalizeContent(%q) = %q, want %q", tc.in, lines, tc.want)
		}
	}
}

func TestHandleMouseSelectsAndCopies(t *testing.T) {
	tr := testTranscript("hello")
	var copied string
	m := &Model{
		transcript: tr,
		body:       1,
		copyFn: func(text string) tea.Cmd {
			copied = text
			return nil
		},
	}
	press := tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonLeft, X: 0, Y: 1}
	motion := tea.MouseMsg{Action: tea.MouseActionMotion, Button: tea.MouseButtonLeft, X: 5, Y: 1}
	release := tea.MouseMsg{Action: tea.MouseActionRelease, Button: tea.MouseButtonLeft, X: 5, Y: 1}
	m.handleMouse(press)
	m.handleMouse(motion)
	m.handleMouse(release)
	if copied != "hello" {
		t.Fatalf("copied = %q, want %q", copied, "hello")
	}
	if !tr.HasSelection() {
		t.Fatal("selection should stay highlighted after copying")
	}
}
