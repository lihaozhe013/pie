package ui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

func TestTintLineReappliesBackground(t *testing.T) {
	const background = "\x1b[48;5;22m"
	row := "\x1b[31mred\x1b[0m plain"
	got := tintLine(row, background)
	if !strings.HasPrefix(got, background) {
		t.Fatalf("tint = %q, want the background first", got)
	}
	if !strings.HasSuffix(got, "\x1b[0m") {
		t.Fatalf("tint = %q, want a closing reset", got)
	}
	if strings.Contains(got, "\x1b[0m plain") {
		t.Fatalf("tint = %q, background lost after the token reset", got)
	}
	if text := ansi.Strip(got); text != "red plain" {
		t.Fatalf("text = %q, want %q", text, "red plain")
	}
}

func TestTintLineWithoutBackgroundKeepsRow(t *testing.T) {
	row := "\x1b[31mred\x1b[0m"
	if got := tintLine(row, ""); got != row {
		t.Fatalf("tint = %q, want the row unchanged", got)
	}
}

func TestBlendHex(t *testing.T) {
	got, ok := blendHex("#7ee787", "#1c1d24", 0.12)
	if !ok {
		t.Fatal("blendHex rejected hex colours")
	}
	if want := "#283530"; got != want {
		t.Fatalf("blend = %q, want %q", got, want)
	}
	if _, ok := blendHex("green", "#1c1d24", 0.12); ok {
		t.Fatal("blendHex accepted a non-hex colour")
	}
}

func TestPaintDiffLinesPicksSide(t *testing.T) {
	pair := diffPair{Old: "keep\nold", New: "keep\nnew"}
	lines := computeDiff(pair.Old, pair.New, 2)
	paintDiffLines(lines, []string{"<keep>", "<old>"}, []string{"<keep>", "<new>"})
	want := []string{"<keep>", "<old>", "<new>"}
	if len(lines) != len(want) {
		t.Fatalf("lines = %d, want %d", len(lines), len(want))
	}
	for i, line := range lines {
		if line.text != want[i] {
			t.Fatalf("line %d = %q, want %q", i, line.text, want[i])
		}
	}
}

func TestStyledDiffLinesCapsAcrossPairs(t *testing.T) {
	pairs := []diffPair{{New: "a\nb\nc\nd"}, {New: "e\nf"}}
	lines, truncated := styledDiffLines(pairs, nil, 3)
	if !truncated {
		t.Fatal("styledDiffLines did not report the cap")
	}
	if len(lines) != 3 {
		t.Fatalf("lines = %d, want 3", len(lines))
	}
}
