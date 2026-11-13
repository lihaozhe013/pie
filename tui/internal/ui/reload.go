package ui

import (
	"context"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

// reloadMsg reports a bridge-driven pi reload.
type reloadMsg struct {
	err    error
	silent bool
}

// reloadPi asks the bridge to reload settings, instructions, and extension
// state without restarting the child. Without the bridge a restart is needed.
func (m *Model) reloadPi() tea.Cmd {
	return m.reloadPiWithOption(false)
}

// reloadPiSilent runs reloadPi without raising a toast on success.
func (m *Model) reloadPiSilent() tea.Cmd {
	return m.reloadPiWithOption(true)
}

func (m *Model) reloadPiWithOption(silent bool) tea.Cmd {
	if m.busy {
		if !silent {
			m.setToast("wait for the current turn before reloading pi")
		}
		return nil
	}
	if !m.bridgeReady {
		if !silent {
			m.setToast("bridge extension unavailable; restart pie to reload")
		}
		return nil
	}
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, err := client.DoOK(ctx, rpc.Prompt("/pie-reload"))
		return reloadMsg{err: err, silent: silent}
	}
}
