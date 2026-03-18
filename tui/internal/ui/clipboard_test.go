package ui

import (
	"bytes"
	"strings"
	"testing"
)

func TestOSC52Sequence(t *testing.T) {
	got := osc52Sequence("hello", false)
	want := "\x1b]52;c;aGVsbG8=\x07"
	if got != want {
		t.Fatalf("sequence = %q, want %q", got, want)
	}
}

func TestOSC52SequenceScreenWrapped(t *testing.T) {
	got := osc52Sequence("hello", true)
	if !strings.Contains(got, "\x1bP") || !strings.Contains(got, "\x1b\\") {
		t.Fatalf("screen sequence is not DCS wrapped: %q", got)
	}
	if !strings.Contains(got, "aGVsbG8=") {
		t.Fatalf("screen sequence lost the payload: %q", got)
	}
}

func TestWriteOSC52RejectsLargeSelection(t *testing.T) {
	var out bytes.Buffer
	err := writeOSC52(&out, strings.Repeat("x", osc52Limit+1))
	if err == nil {
		t.Fatal("expected an error for an oversized selection")
	}
	if out.Len() != 0 {
		t.Fatal("oversized selection should not write a partial sequence")
	}
}

func TestWriteOSC52(t *testing.T) {
	var out bytes.Buffer
	if err := writeOSC52(&out, "hello"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "aGVsbG8=") {
		t.Fatalf("output = %q", out.String())
	}
}
