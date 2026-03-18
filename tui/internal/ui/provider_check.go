package ui

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// providerCheckMsg reports `pi auth check --provider <id> --json`.
type providerCheckMsg struct {
	provider string
	status   string
	kind     string
	reason   string
	err      error
}

// checkProvider asks pi whether a provider can authenticate. It runs outside
// the RPC child so a hung credential probe never blocks the session.
func (m *Model) checkProvider(provider string) tea.Cmd {
	bin := m.opts.PiBin
	if bin == "" {
		bin = "pi"
	}
	cwd := m.opts.CWD
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, bin, "auth", "check", "--provider", provider, "--json")
		if cwd != "" {
			command.Dir = cwd
		}
		out, err := command.Output()
		if err != nil {
			exitErr, ok := err.(*exec.ExitError)
			if !ok {
				return providerCheckMsg{provider: provider, err: err}
			}
			// `auth check` exits non-zero for not-ready providers but still
			// prints JSON, so parse the output first.
			if len(exitErr.Stderr) == 0 && len(out) == 0 {
				return providerCheckMsg{provider: provider, err: err}
			}
		}
		var payload struct {
			Status   string `json:"status"`
			AuthType string `json:"authType"`
			Reason   string `json:"reason"`
		}
		if jsonErr := json.Unmarshal(out, &payload); jsonErr != nil {
			detail := strings.TrimSpace(string(out))
			if detail == "" {
				detail = err.Error()
			}
			return providerCheckMsg{provider: provider, err: jsonErr, reason: detail}
		}
		return providerCheckMsg{provider: provider, status: payload.Status, kind: payload.AuthType, reason: payload.Reason}
	}
}

// providerCheckSummary is the toast text for one check result.
func providerCheckSummary(msg providerCheckMsg) string {
	if msg.err != nil {
		if msg.reason != "" {
			return msg.provider + ": " + msg.reason
		}
		return msg.provider + ": " + msg.err.Error()
	}
	if msg.status == "ready" {
		if msg.kind != "" {
			return msg.provider + ": ready (" + msg.kind + ")"
		}
		return msg.provider + ": ready"
	}
	reason := msg.reason
	if reason == "" {
		reason = msg.status
	}
	return msg.provider + ": not ready (" + reason + ")"
}
