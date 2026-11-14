package ui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
	"github.com/lihaozhe013/pie/tui/internal/session"
)

type forkMessagesMsg struct {
	messages []forkMessage
	err      error
}

type forkMessage struct {
	EntryID string
	Text    string
}

type forkResultMsg struct {
	text      string
	reverted  bool
	cancelled bool
	messages  []rpc.Message
	state     *rpc.State
	err       error
}

// revertTargetMsg is the user message /revert would go back to.
type revertTargetMsg struct {
	entryID string
	text    string
	found   bool
	err     error
}

type cloneResultMsg struct {
	cancelled bool
	messages  []rpc.Message
	state     *rpc.State
	err       error
}

type treeResultMsg struct {
	tree session.Tree
	err  error
}

func (m *Model) listForkMessages() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.GetForkMessages())
		if err != nil {
			return forkMessagesMsg{err: err}
		}
		var payload struct {
			Messages []forkMessage `json:"messages"`
		}
		if err := response.DecodeData(&payload); err != nil {
			return forkMessagesMsg{err: err}
		}
		return forkMessagesMsg{messages: payload.Messages}
	}
}

func (m *Model) applyForkMessages(msg forkMessagesMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.addError("fork: " + msg.err.Error())
		return m, nil
	}
	if len(msg.messages) == 0 {
		m.setToast("no user messages to fork from")
		return m, nil
	}
	items := make([]pickerItem, 0, len(msg.messages))
	for _, message := range msg.messages {
		label := strings.Join(strings.Fields(message.Text), " ")
		if len([]rune(label)) > 80 {
			label = string([]rune(label)[:80]) + "…"
		}
		items = append(items, pickerItem{Value: message.EntryID, Label: label, Detail: "fork here"})
	}
	m.openOverlay(newPickerOverlay("fork", "Fork from a message", items))
	return m, nil
}

func (m *Model) forkSession(entryID string) tea.Cmd {
	return m.forkSessionFor(entryID, false)
}

// revertSession forks the active session at entryID: the prompt returns to the
// editor and the trimmed conversation opens as a new session.
func (m *Model) revertSession(entryID string) tea.Cmd {
	return m.forkSessionFor(entryID, true)
}

func (m *Model) forkSessionFor(entryID string, reverted bool) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.Fork(entryID))
		if err != nil {
			return forkResultMsg{err: err, reverted: reverted}
		}
		var payload struct {
			Text      string `json:"text"`
			Cancelled bool   `json:"cancelled"`
		}
		_ = response.DecodeData(&payload)
		msg := forkResultMsg{text: payload.Text, cancelled: payload.Cancelled, reverted: reverted}
		if payload.Cancelled {
			return msg
		}
		history, err := client.DoOK(ctx, rpc.GetMessages())
		if err != nil {
			msg.err = err
			return msg
		}
		historyPayload, _ := rpc.DecodeTyped[rpc.MessagesPayload](history)
		msg.messages = historyPayload.Messages
		if stateResponse, stateErr := client.DoOK(ctx, rpc.GetState()); stateErr == nil {
			if state, decodeErr := rpc.DecodeTyped[rpc.State](stateResponse); decodeErr == nil {
				msg.state = &state
			}
		}
		return msg
	}
}

// startRevert resolves the last prompt of the active branch and asks for
// confirmation. pi's RPC has no in-session tree navigation, so the revert is a
// fork from that message: the current session stays in history.
func (m *Model) startRevert() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.GetForkMessages())
		if err != nil {
			return revertTargetMsg{err: err}
		}
		var payload struct {
			Messages []forkMessage `json:"messages"`
		}
		if err := response.DecodeData(&payload); err != nil {
			return revertTargetMsg{err: err}
		}
		if len(payload.Messages) == 0 {
			return revertTargetMsg{}
		}
		target := payload.Messages[len(payload.Messages)-1]
		// get_fork_messages walks the whole file, so a session the Web UI
		// navigated backwards can end with prompts on an abandoned branch.
		// The newest prompt the active leaf reaches is the revert target.
		if treeResponse, treeErr := client.DoOK(ctx, rpc.GetTree()); treeErr == nil {
			if tree, parseErr := session.ParseTree(treeResponse.Data); parseErr == nil {
				active := activeEntryIDs(tree)
				for i := len(payload.Messages) - 1; i >= 0; i-- {
					if active[payload.Messages[i].EntryID] {
						target = payload.Messages[i]
						break
					}
				}
			}
		}
		return revertTargetMsg{entryID: target.EntryID, text: target.Text, found: true}
	}
}

func (m *Model) applyRevertTarget(msg revertTargetMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.addError("revert: " + msg.err.Error())
		return m, nil
	}
	if !msg.found {
		m.setToast("nothing to revert")
		return m, nil
	}
	preview := truncateLine(strings.Join(strings.Fields(msg.text), " "), 160)
	body := "\"" + preview + "\"\n\n" +
		"This forks a new session from that message and puts it back in the editor. " +
		"The current session stays in history."
	m.openOverlay(newConfirmMessageOverlay("revert", "Revert to the last prompt", body, msg.entryID))
	return m, nil
}

// activeEntryIDs returns every entry the current leaf reaches through its
// parent chain.
func activeEntryIDs(tree session.Tree) map[string]bool {
	parents := make(map[string]string)
	var walk func(nodes []session.TreeNode)
	walk = func(nodes []session.TreeNode) {
		for _, node := range nodes {
			parents[node.ID] = node.ParentID
			walk(node.Children)
		}
	}
	walk(tree.Roots)
	active := make(map[string]bool)
	for id := tree.LeafID; id != ""; id = parents[id] {
		if active[id] {
			break
		}
		active[id] = true
	}
	return active
}

func (m *Model) applyForkResult(msg forkResultMsg) (tea.Model, tea.Cmd) {
	label := "fork"
	if msg.reverted {
		label = "revert"
	}
	if msg.err != nil {
		m.addError(label + ": " + msg.err.Error())
		return m, nil
	}
	if msg.cancelled {
		m.setToast(label + " cancelled")
		return m, nil
	}
	m.sessionEpoch.Add(1)
	if msg.state != nil {
		m.state = *msg.state
	} else {
		m.state.SessionName = ""
		m.state.SessionFile = ""
		m.state.SessionID = ""
	}
	m.extensionTitle = ""
	m.plan = session.Plan{}
	m.hasPlan = false
	m.firstUserPrompt = firstUserPromptFromMessages(msg.messages)
	m.loadHistory(msg.messages)
	if msg.reverted {
		// A revert replaces the editor, so the draft that was there moves into
		// the history ring instead of being lost.
		if draft := strings.TrimSpace(m.composer.Value()); draft != "" {
			m.composer.PushHistory(draft)
		}
	}
	m.composer.SetText(msg.text)
	m.completion.Refresh(m.composer.Value())
	m.transcript.ScrollToBottom()
	m.logEntries = nil
	m.autoTitlePending = m.state.SessionName == ""
	m.autoTitleAttempts = 0
	m.resetSessionNameWatch()
	m.invalidateTitle()
	if msg.reverted {
		m.addNotice("reverted to the last prompt in a new session")
		m.setToast("reverted; the prompt is back in the editor")
	} else {
		m.addNotice("forked to a new session")
		m.setToast("forked; the message is back in the editor")
	}
	m.layout()
	commands := []tea.Cmd{m.refreshState(), m.refreshStats(), m.loadEntries(), m.syncTerminalTitle()}
	if auto := m.autoTitleFromHistory(msg.messages); auto != nil {
		commands = append(commands, auto)
	}
	return m, tea.Batch(commands...)
}

func (m *Model) cloneSession() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.Clone())
		if err != nil {
			return cloneResultMsg{err: err}
		}
		var payload struct {
			Cancelled bool `json:"cancelled"`
		}
		_ = response.DecodeData(&payload)
		msg := cloneResultMsg{cancelled: payload.Cancelled}
		if payload.Cancelled {
			return msg
		}
		history, err := client.DoOK(ctx, rpc.GetMessages())
		if err != nil {
			msg.err = err
			return msg
		}
		historyPayload, _ := rpc.DecodeTyped[rpc.MessagesPayload](history)
		msg.messages = historyPayload.Messages
		if stateResponse, stateErr := client.DoOK(ctx, rpc.GetState()); stateErr == nil {
			if state, decodeErr := rpc.DecodeTyped[rpc.State](stateResponse); decodeErr == nil {
				msg.state = &state
			}
		}
		return msg
	}
}

func (m *Model) applyCloneResult(msg cloneResultMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.addError("clone: " + msg.err.Error())
		return m, nil
	}
	if msg.cancelled {
		m.setToast("clone cancelled")
		return m, nil
	}
	m.sessionEpoch.Add(1)
	if msg.state != nil {
		m.state = *msg.state
	} else {
		m.state.SessionName = ""
		m.state.SessionFile = ""
		m.state.SessionID = ""
	}
	m.extensionTitle = ""
	m.plan = session.Plan{}
	m.hasPlan = false
	m.firstUserPrompt = firstUserPromptFromMessages(msg.messages)
	m.loadHistory(msg.messages)
	m.logEntries = nil
	m.autoTitlePending = m.state.SessionName == ""
	m.autoTitleAttempts = 0
	m.resetSessionNameWatch()
	m.invalidateTitle()
	m.addNotice("cloned the current branch into a new session")
	m.setToast("cloned to a new session")
	commands := []tea.Cmd{m.refreshState(), m.refreshStats(), m.loadEntries(), m.syncTerminalTitle()}
	if auto := m.autoTitleFromHistory(msg.messages); auto != nil {
		commands = append(commands, auto)
	}
	return m, tea.Batch(commands...)
}

func (m *Model) loadTree() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.GetTree())
		if err != nil {
			return treeResultMsg{err: err}
		}
		tree, err := session.ParseTree(response.Data)
		return treeResultMsg{tree: tree, err: err}
	}
}

func (m *Model) applyTree(msg treeResultMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.addError("tree: " + msg.err.Error())
		return m, nil
	}
	m.tree = msg.tree
	nodes := countNodes(m.tree.Roots)
	if nodes == 0 {
		m.setToast("the session tree is empty")
		return m, nil
	}
	m.addNotice(treeText(m.tree))
	m.setToast(fmt.Sprintf("session tree: %d entries", nodes))
	return m, nil
}

// treeText renders the branch structure into the transcript, where the full
// width is available. The settings panel's two columns truncate deep branches
// too aggressively, and pi's RPC has no command to switch to a node anyway.
func treeText(tree session.Tree) string {
	var builder strings.Builder
	builder.WriteString(fmt.Sprintf("Session tree · %d entries · leaf %s", countNodes(tree.Roots), shortID(tree.LeafID)))
	var walk func(nodes []session.TreeNode, depth int)
	walk = func(nodes []session.TreeNode, depth int) {
		for _, node := range nodes {
			marker := "├─ "
			if node.ID == tree.LeafID {
				marker = "●─ "
			}
			builder.WriteString("\n")
			builder.WriteString(strings.Repeat("  ", depth))
			builder.WriteString(marker)
			builder.WriteString(node.Label)
			if node.ID == tree.LeafID {
				builder.WriteString("  ← current")
			}
			walk(node.Children, depth+1)
		}
	}
	walk(tree.Roots, 0)
	return builder.String()
}

func countNodes(nodes []session.TreeNode) int {
	count := 0
	for _, node := range nodes {
		count += 1 + countNodes(node.Children)
	}
	return count
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	if id == "" {
		return "?"
	}
	return id
}
