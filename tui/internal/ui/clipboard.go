package ui

import (
	"context"
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

var errSelectionTooLarge = errors.New("selection too large for terminal clipboard")

// copiedMsg reports the outcome of a clipboard write.
type copiedMsg struct {
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
