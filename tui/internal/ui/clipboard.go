package ui

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	osc52 "github.com/aymanbagabas/go-osc52/v2"
	tea "github.com/charmbracelet/bubbletea"
)

// osc52Limit bounds the escape sequence sent to the terminal. Larger
// selections still reach the platform clipboard through a native command.
const osc52Limit = 100_000

// clipboardTimeout bounds one native clipboard command.
const clipboardTimeout = 2 * time.Second

// clipboardReadTimeout bounds one native clipboard read. A reader such as
// PowerShell has to start before it can read, so reads get a longer budget
// than writes.
const clipboardReadTimeout = 5 * time.Second

var errSelectionTooLarge = errors.New("selection too large for terminal clipboard")

// copiedMsg reports the outcome of a clipboard write.
type copiedMsg struct {
	chars int
	lines int
	err   error
}

// pastedMsg reports the outcome of a clipboard read.
type pastedMsg struct {
	text  string
	chars int
	lines int
	err   error
}

// defaultCopyCommand returns the copy command used by the UI: OSC52 for
// terminals (including SSH sessions) plus a platform clipboard command for
// terminals without OSC52 support.
func defaultCopyCommand() func(string) tea.Cmd {
	return copyCommand(os.Stderr)
}

// copyCommand builds a copy command writing OSC52 to out.
func copyCommand(out io.Writer) func(string) tea.Cmd {
	return func(text string) tea.Cmd {
		return func() tea.Msg {
			chars := utf8.RuneCountInString(text)
			lines := 1
			if chars > 0 {
				lines += strings.Count(text, "\n")
			}
			oscErr := writeOSC52(out, text)
			nativeErr := copyNative(text)
			if oscErr != nil && nativeErr != nil {
				if errors.Is(oscErr, errSelectionTooLarge) {
					return copiedMsg{chars: chars, lines: lines, err: oscErr}
				}
				return copiedMsg{chars: chars, lines: lines, err: nativeErr}
			}
			return copiedMsg{chars: chars, lines: lines}
		}
	}
}

// copySelection sends selected text through the configured clipboard writer.
func (m *Model) copySelection(text string) tea.Cmd {
	if text == "" || m.copyFn == nil {
		return nil
	}
	return m.copyFn(text)
}

// writeOSC52 writes an OSC52 clipboard sequence. GNU screen needs a DCS
// wrapper; tmux handles plain OSC52 with set-clipboard on.
func writeOSC52(out io.Writer, text string) error {
	if text == "" {
		return nil
	}
	if len(text) > osc52Limit {
		return errSelectionTooLarge
	}
	if out == nil {
		return errors.New("no terminal output")
	}
	_, err := io.WriteString(out, osc52Sequence(text, os.Getenv("STY") != ""))
	return err
}

// osc52Sequence builds the escape sequence. GNU screen needs a DCS wrapper.
func osc52Sequence(text string, screen bool) string {
	seq := osc52.New(text)
	if screen {
		seq = seq.Screen()
	}
	return seq.String()
}

type clipboardCommand struct {
	name string
	args []string
}

// nativeClipboardCommands lists clipboard tools in preference order. Missing
// tools are skipped by copyNative.
func nativeClipboardCommands() []clipboardCommand {
	switch runtime.GOOS {
	case "darwin":
		return []clipboardCommand{{name: "pbcopy"}}
	case "windows":
		return []clipboardCommand{{name: "clip"}}
	}

	var commands []clipboardCommand
	switch {
	case os.Getenv("TERMUX_VERSION") != "":
		commands = append(commands, clipboardCommand{name: "termux-clipboard-set"})
	case os.Getenv("WAYLAND_DISPLAY") != "" || os.Getenv("XDG_SESSION_TYPE") == "wayland":
		commands = append(commands, clipboardCommand{name: "wl-copy"})
	}
	commands = append(commands,
		clipboardCommand{name: "xclip", args: []string{"-selection", "clipboard", "-in"}},
		clipboardCommand{name: "xsel", args: []string{"--clipboard", "--input"}},
	)
	if os.Getenv("WSL_DISTRO_NAME") != "" || os.Getenv("WSL_INTEROP") != "" {
		commands = append(commands, clipboardCommand{name: "clip.exe"})
	}
	return commands
}

// copyNative runs the first available platform clipboard command.
func copyNative(text string) error {
	var lastErr error
	for _, candidate := range nativeClipboardCommands() {
		path, err := exec.LookPath(candidate.name)
		if err != nil {
			lastErr = err
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), clipboardTimeout)
		cmd := exec.CommandContext(ctx, path, candidate.args...)
		cmd.Stdin = strings.NewReader(text)
		err = cmd.Run()
		cancel()
		if err == nil {
			return nil
		}
		lastErr = fmt.Errorf("%s: %w", candidate.name, err)
	}
	if lastErr == nil {
		lastErr = errors.New("no clipboard command found")
	}
	return lastErr
}

// clipboardReader is one native clipboard read command. Base64 output marks a
// reader that encodes its text in the shell, which keeps non-ASCII content
// intact regardless of the platform console code page.
type clipboardReader struct {
	name         string
	args         []string
	base64Output bool
}

// powershellClipboardScript prints the clipboard as base64. Get-Clipboard -Raw
// preserves the original line endings; the encoding happens in PowerShell so
// the console code page cannot corrupt the text on its way back to Go. The
// [string] cast turns an empty clipboard into an empty string instead of a null
// that would make GetBytes fail.
const powershellClipboardScript = "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string](Get-Clipboard -Raw)))"

func powershellClipboardArgs() []string {
	return []string{"-NoProfile", "-NonInteractive", "-Command", powershellClipboardScript}
}

// nativeClipboardReaders lists clipboard readers in preference order. Missing
// tools are skipped by readNative.
func nativeClipboardReaders() []clipboardReader {
	switch runtime.GOOS {
	case "darwin":
		return []clipboardReader{{name: "pbpaste"}}
	case "windows":
		return []clipboardReader{
			{name: "powershell", args: powershellClipboardArgs(), base64Output: true},
			{name: "pwsh", args: powershellClipboardArgs(), base64Output: true},
		}
	}

	var readers []clipboardReader
	switch {
	case os.Getenv("TERMUX_VERSION") != "":
		readers = append(readers, clipboardReader{name: "termux-clipboard-get"})
	case os.Getenv("WAYLAND_DISPLAY") != "" || os.Getenv("XDG_SESSION_TYPE") == "wayland":
		readers = append(readers, clipboardReader{name: "wl-paste", args: []string{"--no-newline"}})
	}
	readers = append(readers,
		clipboardReader{name: "xclip", args: []string{"-selection", "clipboard", "-out"}},
		clipboardReader{name: "xsel", args: []string{"--clipboard", "--output"}},
	)
	if os.Getenv("WSL_DISTRO_NAME") != "" || os.Getenv("WSL_INTEROP") != "" {
		readers = append(readers,
			clipboardReader{name: "powershell.exe", args: powershellClipboardArgs(), base64Output: true},
			clipboardReader{name: "pwsh.exe", args: powershellClipboardArgs(), base64Output: true},
		)
	}
	return readers
}

// readNative runs the first available platform clipboard reader. An empty
// clipboard is not an error.
func readNative() (string, error) {
	var lastErr error
	found := false
	for _, reader := range nativeClipboardReaders() {
		path, err := exec.LookPath(reader.name)
		if err != nil {
			lastErr = err
			continue
		}
		found = true
		ctx, cancel := context.WithTimeout(context.Background(), clipboardReadTimeout)
		cmd := exec.CommandContext(ctx, path, reader.args...)
		output, err := cmd.Output()
		cancel()
		if err != nil {
			lastErr = fmt.Errorf("%s: %w", reader.name, err)
			continue
		}
		text := string(output)
		if reader.base64Output {
			decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(text))
			if err != nil {
				lastErr = fmt.Errorf("%s: %w", reader.name, err)
				continue
			}
			text = string(decoded)
		}
		return text, nil
	}
	if !found {
		return "", errors.New("no clipboard reader available")
	}
	return "", lastErr
}

// readClipboard reads, sanitizes, and measures the system clipboard. It runs
// off the event loop; the returned text is ready to insert at the caret.
func readClipboard() tea.Cmd {
	return func() tea.Msg {
		text, err := readNative()
		if err != nil {
			return pastedMsg{err: err}
		}
		text = sanitizePastedText(text)
		chars := utf8.RuneCountInString(text)
		lines := 0
		if chars > 0 {
			lines = strings.Count(text, "\n") + 1
		}
		return pastedMsg{text: text, chars: chars, lines: lines}
	}
}

// sanitizePastedText prepares clipboard text for the composer. Newlines stay
// literal text, so nothing in the buffer can submit a prompt. Escape sequences
// are removed first: normalizeComposerText drops the ESC byte but would leave
// the sequence body behind as visible junk.
func sanitizePastedText(text string) string {
	text = stripClipboardEscapes(text)
	text = normalizeComposerText(text)
	return strings.TrimRight(text, "\n")
}

// stripClipboardEscapes removes ANSI CSI/OSC/DCS sequences, including the
// bracketed-paste markers. Clipboard text copied out of a terminal routinely
// carries them.
func stripClipboardEscapes(text string) string {
	var out strings.Builder
	out.Grow(len(text))
	for i := 0; i < len(text); {
		if text[i] != '\x1b' {
			out.WriteByte(text[i])
			i++
			continue
		}
		i++
		if i >= len(text) {
			break
		}
		switch text[i] {
		case '[':
			// CSI: parameters and intermediates, then a final byte in
			// 0x40-0x7e.
			i++
			for i < len(text) {
				final := text[i] >= 0x40 && text[i] <= 0x7e
				i++
				if final {
					break
				}
			}
		case ']':
			// OSC: terminated by BEL or ST.
			i++
			for i < len(text) {
				if text[i] == '\a' {
					i++
					break
				}
				if text[i] == '\x1b' && i+1 < len(text) && text[i+1] == '\\' {
					i += 2
					break
				}
				i++
			}
		case 'P', '^', '_':
			// DCS, PM, APC: terminated by ST.
			i++
			for i < len(text) {
				if text[i] == '\x1b' && i+1 < len(text) && text[i+1] == '\\' {
					i += 2
					break
				}
				i++
			}
		default:
			// Two-byte escape sequence.
			i++
		}
	}
	return out.String()
}
