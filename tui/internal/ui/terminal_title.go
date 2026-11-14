package ui

import (
	"io"
	"os"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/term"

	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

const maxTerminalTitleLength = 80

// sanitizeTerminalTitle removes control characters, collapses whitespace, and
// limits the length of title text so terminal OSC escape sequences remain safe
// and well-formed.
func sanitizeTerminalTitle(title string) string {
	var b strings.Builder
	b.Grow(len(title))
	for _, r := range title {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f) {
			b.WriteByte(' ')
		} else {
			b.WriteRune(r)
		}
	}
	fields := strings.Fields(b.String())
	if len(fields) == 0 {
		return ""
	}
	joined := strings.Join(fields, " ")
	runes := []rune(joined)
	if len(runes) > maxTerminalTitleLength {
		return strings.TrimSpace(string(runes[:maxTerminalTitleLength-1])) + "…"
	}
	return joined
}

// truncateTitlePrompt collapses whitespace and caps prompt text to 60 runes,
// matching the first-message label used by session scanning.
func truncateTitlePrompt(text string) string {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return ""
	}
	joined := strings.Join(fields, " ")
	runes := []rune(joined)
	if len(runes) <= 60 {
		return string(runes)
	}
	return strings.TrimSpace(string(runes[:59])) + "…"
}

// firstUserPromptFromMessages extracts and truncates the first user prompt from
// history messages, or returns an empty string when none is found.
func firstUserPromptFromMessages(messages []rpc.Message) string {
	for _, msg := range messages {
		if msg.Role == "user" {
			text := strings.TrimSpace(msg.Text())
			if text != "" {
				return truncateTitlePrompt(text)
			}
		}
	}
	return ""
}

// defaultSetTitleCommand returns the default title updater used by the model
// when Options.SetTitle is omitted (e.g. in tests). It writes OSC 0 sequences
// to os.Stderr to avoid contention with Bubble Tea's renderer.
func defaultSetTitleCommand() func(string) tea.Cmd {
	return TerminalTitleCommand(os.Stderr)
}

// TerminalTitleCommand returns a title updater that emits an OSC 0 escape
// sequence (setting both icon/tab name and window title) to out. If out has an
// underlying file descriptor that is not a terminal, title updates are skipped.
func TerminalTitleCommand(out io.Writer) func(string) tea.Cmd {
	if f, ok := out.(interface{ Fd() uintptr }); ok {
		if !term.IsTerminal(f.Fd()) {
			return func(string) tea.Cmd {
				return func() tea.Msg { return nil }
			}
		}
	}
	return func(title string) tea.Cmd {
		return func() tea.Msg {
			sanitized := sanitizeTerminalTitle(title)
			if sanitized == "" || out == nil {
				return nil
			}
			_, _ = io.WriteString(out, ansi.SetIconNameWindowTitle(sanitized))
			return nil
		}
	}
}

// resolvedTerminalTitle determines the active title for the terminal tab/window.
// It prioritizes explicit extension titles, followed by the session name
// (manual or AI-generated), followed by the first user prompt summary, falling
// back to "<directory> - pie" or "pie" for brand-new empty sessions.
func (m *Model) resolvedTerminalTitle() string {
	if m.extensionTitle != "" {
		return m.extensionTitle
	}
	if m.state.SessionName != "" {
		return m.state.SessionName
	}
	if m.firstUserPrompt != "" {
		return m.firstUserPrompt
	}
	if m.opts.CWD != "" {
		base := filepath.Base(filepath.Clean(m.opts.CWD))
		if base != "" && base != "." && base != "/" && base != `\` {
			return base + " - pie"
		}
	}
	return "pie"
}

// syncTerminalTitle compares the current resolved title with the last title
// emitted to the terminal, and issues a command to update the terminal tab/window
// title if it has changed.
func (m *Model) syncTerminalTitle() tea.Cmd {
	title := m.resolvedTerminalTitle()
	if title == m.lastTerminalTitle {
		return nil
	}
	m.lastTerminalTitle = title
	if m.setTitleFn == nil {
		return nil
	}
	return m.setTitleFn(title)
}
