package ui

import "testing"

func TestTrimRenderedDropsDocumentEdge(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"heading tail behind a reset", "# Title   \n\x1b[0m", "# Title   "},
		{"list lead", "\x1b[38;5;252m   \x1b[0m\n• item", "• item"},
		{"code lead", "\x1b[38;5;252m \x1b[0m\n x := 1", " x := 1"},
		{"inner blank kept", "a\n   \nb", "a\n   \nb"},
	}
	for _, tc := range cases {
		if got := trimRendered(tc.in); got != tc.want {
			t.Errorf("%s: trimRendered(%q) = %q, want %q", tc.name, tc.in, got, tc.want)
		}
	}
}

func TestSplitMarkdownKeepsContainersTogether(t *testing.T) {
	list := splitMarkdown("1. one\n\n2. two\n\ntext")
	if len(list.stable) != 1 || list.stable[0] != "1. one\n\n2. two" {
		t.Fatalf("stable = %#v, want the loose list as one segment", list.stable)
	}
	if list.tail != "text" {
		t.Fatalf("tail = %q, want %q", list.tail, "text")
	}

	quote := splitMarkdown("> a\n>\n> b\n\ntext")
	if len(quote.stable) != 1 || quote.stable[0] != "> a\n>\n> b" {
		t.Fatalf("stable = %#v, want the quote as one segment", quote.stable)
	}
}

func TestSplitMarkdownSplitsBeforeAList(t *testing.T) {
	split := splitMarkdown("para\n\n- a\n- b")
	if len(split.stable) != 1 || split.stable[0] != "para" {
		t.Fatalf("stable = %#v, want the paragraph alone", split.stable)
	}
	if split.tail != "- a\n- b" {
		t.Fatalf("tail = %q, want the list", split.tail)
	}
}

func TestSplitMarkdownKeepsIndentedContinuation(t *testing.T) {
	split := splitMarkdown("- a\n\n  continued\n\n- b\n\ntext")
	if len(split.stable) != 1 || split.stable[0] != "- a\n\n  continued\n\n- b" {
		t.Fatalf("stable = %#v, want the item and its continuation together", split.stable)
	}
}
