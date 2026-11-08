package ui

import (
	"path/filepath"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/session"
)

// sessionDeleteWindow is how long the first ctrl+d stays armed in a session
// picker. It matches the ctrl+c quit window, so a double press feels the same
// everywhere in the client.
const sessionDeleteWindow = 1500 * time.Millisecond

// sessionDeleteMsg reports the result of removing one session file.
type sessionDeleteMsg struct {
	path  string
	label string
	err   error
}

// deleteSelectedSession implements the double ctrl+d confirmation used by the
// resume and search pickers: the first press arms the selected row and the
// second press inside the window deletes it.
func (m *Model) deleteSelectedSession() tea.Cmd {
	o := m.overlay
	item, ok := o.selected()
	if !ok {
		return nil
	}
	if item.Value == sessionAllValue {
		m.setToast("select a session to delete")
		return nil
	}
	// pi keeps writing to its open session file; removing it would lose the
	// rest of the conversation when the client exits.
	if m.state.SessionFile != "" && sameSessionPath(item.Value, m.state.SessionFile) {
		o.disarmDelete()
		m.setToast("this session is open · switch away before deleting it")
		return nil
	}

	label := item.Label
	if label == "" {
		label = item.Value
	}
	if o.deleteArmedNow(item.Value) {
		o.disarmDelete()
		return deleteSessionFile(item.Value, label)
	}
	o.deleteArm, o.deleteArmAt = item.Value, time.Now()
	m.setToast("press ctrl+d again to delete " + truncateLine(label, 48))
	return nil
}

// deleteSessionFile removes one session in the background: unlinking a large
// file and re-parenting its forks should not stall the event loop.
func deleteSessionFile(path, label string) tea.Cmd {
	return func() tea.Msg {
		return sessionDeleteMsg{path: path, label: label, err: session.Delete(path)}
	}
}

func (m *Model) applySessionDelete(msg sessionDeleteMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.addError("delete session: " + msg.err.Error())
		return m, nil
	}
	// The picker stays open and drops the row, so deleting several sessions in
	// a row does not cost a reopen.
	if m.overlay != nil && m.overlay.sessionPicker() {
		m.overlay.dropItem(msg.path)
	}
	m.setToast("deleted " + truncateLine(msg.label, 48))
	return m, nil
}

// sameSessionPath compares two session paths after resolving symlinks, so the
// active-session guard also catches a picker path reached through another
// prefix.
func sameSessionPath(a, b string) bool {
	if a == b {
		return true
	}
	if a == "" || b == "" {
		return false
	}
	left, leftErr := filepath.EvalSymlinks(a)
	right, rightErr := filepath.EvalSymlinks(b)
	return leftErr == nil && rightErr == nil && left == right
}
