package ui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/config"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
	"github.com/lihaozhe013/pie/tui/internal/session"
	"github.com/lihaozhe013/pie/tui/internal/title"
)

// settingsTabID resolves a slash argument to a Settings category or a domain
// page. Domain names redirect to their page so /settings models keeps working.
func settingsTabID(name string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "general":
		return "general", true
	case "instructions", "agents", "prompt":
		return "instructions", true
	case "appearance", "theme":
		return "general", true
	case "tools", "tool", "presets", "preset":
		return "tools", true
	case "models", "model":
		return pageModels, true
	case "providers", "provider":
		return pageProviders, true
	case "skills", "skill":
		return pageSkills, true
	case "plugins", "plugin", "packages":
		return pagePlugins, true
	case "mcp":
		return pageMCP, true
	}
	return "", false
}

func (m *Model) handleEvent(event rpc.Event) (tea.Model, tea.Cmd) {
	switch ev := event.(type) {
	case *rpc.AgentStartEvent:
		m.busy = true
		m.stream = streamState{}
		m.activity.begin()
		m.layout()
		// Keep the event pump alive: only one cmd may read the channel at a time.
		return m, tea.Batch(m.waitEvent(), m.scheduleTick())

	case *rpc.AgentSettledEvent:
		m.busy = false
		m.activity.reset()
		m.layout()
		m.finishStream()
		m.transcript.MarkDirty()
		// The run is over, so a prompt echo that never arrived cannot match a
		// later delivery. The text stays until the prompt response clears it so
		// a late response can still name a new session.
		m.pendingPrompt = nil
		m.pendingPromptLabel = false
		commands := []tea.Cmd{m.waitEvent(), m.refreshStats()}
		if m.state.SessionName != "" {
			m.autoTitlePending = false
			m.autoTitleAttempts = 0
		} else if !m.titleRunning {
			// A new session deserves a title even when its first turn was a
			// slash command, was aborted, or the immediate request failed.
			m.autoTitlePending = false
			if cmd := m.startAutoTitle(nil); cmd != nil {
				commands = append(commands, cmd)
			}
		}
		return m, tea.Batch(commands...)

	case *rpc.MessageStartEvent:
		// Assistant content arrives through updates. User messages are echoed
		// when pi delivers queued steering or follow-ups; their blocks are
		// added on message_end, after the text is authoritative.
		if ev.Message.Role == "assistant" {
			m.beginAssistantMessage()
			m.activity.beginMessage()
		}
		return m, m.waitEvent()

	case *rpc.MessageUpdateEvent:
		m.applyStreamUpdate(ev)
		return m, m.waitEvent()

	case *rpc.MessageEndEvent:
		m.applyMessageEnd(ev.Message)
		commands := []tea.Cmd{m.waitEvent()}
		if ev.Message.Role == "assistant" && m.statsInFlight == 0 {
			// The reply carries the usage that defines the next context size.
			commands = append(commands, m.refreshStats())
		}
		return m, tea.Batch(commands...)

	case *rpc.ToolExecutionStartEvent:
		m.startTool(ev)
		return m, m.waitEvent()

	case *rpc.ToolExecutionUpdateEvent:
		m.updateTool(ev)
		return m, m.waitEvent()

	case *rpc.ToolExecutionEndEvent:
		m.endTool(ev)
		return m, m.waitEvent()

	case *rpc.QueueUpdateEvent:
		m.queue = *ev
		m.layout()
		return m, m.waitEvent()

	case *rpc.ThinkingLevelChangedEvent:
		m.state.ThinkingLevel = ev.Level
		return m, m.waitEvent()

	case *rpc.SessionInfoChangedEvent:
		m.noteSessionName(ev.Name)
		// A name set by the user or another client invalidates an in-flight
		// title, which must not overwrite it.
		m.autoTitlePending = false
		m.autoTitleAttempts = 0
		m.sessionEpoch.Add(1)
		return m, m.waitEvent()

	case *rpc.EntryAppendedEvent:
		var entry session.LogEntry
		if err := json.Unmarshal(ev.Entry, &entry); err == nil {
			m.logEntries = append(m.logEntries, entry)
			m.selection, m.hasSelection = session.ReadToolSelection(m.logEntries)
			m.currentMode = session.ReadWorkMode(m.logEntries)
			if isGoalLogEntry(entry) {
				m.goal, m.hasGoal = session.ReadGoal(m.logEntries)
				if m.overlay != nil && m.overlay.action == "goal" {
					m.openGoalPanel()
				}
			}
		}
		return m, m.waitEvent()

	case *rpc.CompactionStartEvent:
		m.addNotice(fmt.Sprintf("compacting context (%s)…", ev.Reason))
		if !m.activity.compacting {
			m.activity.compacting = true
			m.activity.ensureStarted()
			m.layout()
		}
		return m, tea.Batch(m.waitEvent(), m.scheduleTick())

	case *rpc.CompactionEndEvent:
		switch {
		case ev.ErrorMessage != "":
			m.addError("compaction failed: " + ev.ErrorMessage)
		case ev.Aborted:
			m.addNotice("compaction aborted")
		case ev.Result != nil:
			m.addNotice(fmt.Sprintf("context compacted: %s → ~%s tokens",
				formatTokens(ev.Result.TokensBefore), formatTokens(ev.Result.EstimatedTokensAfter)))
		}
		m.activity.compacting = false
		if !m.busy {
			m.activity.reset()
		}
		m.layout()
		commands := []tea.Cmd{m.waitEvent()}
		if ev.Result != nil {
			commands = append(commands, m.refreshStats())
		}
		return m, tea.Batch(commands...)

	case *rpc.AutoRetryStartEvent:
		m.addNotice(fmt.Sprintf("retry %d/%d in %dms: %s",
			ev.Attempt, ev.MaxAttempts, ev.DelayMs, ev.ErrorMessage))
		m.activity.retry = fmt.Sprintf("Retrying %d/%d…", ev.Attempt, ev.MaxAttempts)
		return m, tea.Batch(m.waitEvent(), m.scheduleTick())

	case *rpc.AutoRetryEndEvent:
		if !ev.Success && ev.FinalError != "" {
			m.addError("retries exhausted: " + ev.FinalError)
		}
		m.activity.retry = ""
		m.layout()
		return m, m.waitEvent()

	case *rpc.SummarizationRetryScheduledEvent:
		m.addNotice(fmt.Sprintf("summarization retry %d/%d in %dms", ev.Attempt, ev.MaxAttempts, ev.DelayMs))
		m.activity.retry = fmt.Sprintf("Retrying summary %d/%d…", ev.Attempt, ev.MaxAttempts)
		m.layout()
		return m, tea.Batch(m.waitEvent(), m.scheduleTick())

	case *rpc.SummarizationRetryFinishedEvent:
		m.activity.retry = ""
		m.layout()
		return m, m.waitEvent()

	case *rpc.BashExecutionUpdateEvent:
		return m, m.waitEvent()

	case *rpc.ExtensionErrorEvent:
		m.addError(fmt.Sprintf("extension error (%s): %s", ev.Event, ev.Error))
		return m, m.waitEvent()

	case *rpc.ExtensionUIRequestEvent:
		return m.handleExtensionUI(ev)

	case *rpc.Response:
		if !ev.Success && ev.Error != "" {
			m.addError(ev.Error)
		}
		return m, m.waitEvent()

	default:
		return m, m.waitEvent()
	}
}

// beginAssistantMessage starts fresh per-message stream state. Each
// assistant message owns its own transcript blocks: without this the next
// message's text would update a block created before the previous message's
// tool calls, putting the finished reply above them.
func (m *Model) beginAssistantMessage() {
	if m.stream.assistant != nil {
		m.stream.assistant.streaming = false
	}
	if m.stream.thinking != nil {
		m.stream.thinking.streaming = false
	}
	m.stream.assistant = nil
	m.stream.thinking = nil
	m.stream.acc.Reset()
}

// applyStreamUpdate folds a delta into the live assistant block.
func (m *Model) applyStreamUpdate(update *rpc.MessageUpdateEvent) {
	kind := update.Assistant.Type
	m.stream.acc.Apply(update.Assistant)
	m.activity.applyDelta(update.Assistant)

	switch {
	case strings.HasPrefix(kind, "thinking_"):
		m.activity.phase = activityThinking
		m.activity.draftTool = ""
		m.activity.ensureStarted()
		if m.stream.thinking == nil {
			m.stream.thinking = newBlock(blockThinking, "")
			m.stream.thinking.streaming = true
			m.stream.thinking.collapsed = !m.showThinking
			m.transcript.Add(m.stream.thinking)
		}
		m.stream.thinking.setText(m.stream.acc.Thinking())
		m.stream.dirty = true

	case strings.HasPrefix(kind, "text_"):
		m.activity.phase = activityStreaming
		m.activity.draftTool = ""
		m.activity.ensureStarted()
		if m.stream.assistant == nil {
			m.stream.assistant = newBlock(blockAssistant, "")
			m.stream.assistant.streaming = true
			m.transcript.Add(m.stream.assistant)
		}
		m.stream.assistant.setText(m.stream.acc.Text())
		m.stream.dirty = true

	case strings.HasPrefix(kind, "toolcall_"):
		// Tool blocks are created by tool_execution_start, but naming the call
		// being written keeps the bar alive while its arguments stream.
		m.activity.phase = activityPreparingTool
		m.activity.ensureStarted()
		if update.Assistant.ToolName != "" {
			m.activity.draftTool = update.Assistant.ToolName
		}
		if call := update.Assistant.ToolCall; call != nil && call.Name != "" {
			m.activity.draftTool = call.Name
		}
	}
}

// applyMessageEnd replaces streamed content with the authoritative message.
func (m *Model) applyMessageEnd(message rpc.Message) {
	switch message.Role {
	case "assistant":
		text := message.Text()
		// The model is silent again: name the wait until the next block or the
		// run's end, unless tools still hold the row. The streaming blocks are
		// the GUI's per-message store — they do not outlive their message.
		if m.activity.phase != activityRunningTools {
			m.activity.phase = activityWaiting
		}
		m.activity.draftTool = ""
		m.activity.stream = nil
		if text != "" {
			if m.stream.assistant == nil {
				m.stream.assistant = newBlock(blockAssistant, text)
				m.transcript.Add(m.stream.assistant)
			}
			m.stream.assistant.setText(text)
			m.stream.assistant.streaming = false
		} else if m.stream.assistant != nil && strings.TrimSpace(m.stream.assistant.text) == "" {
			m.removeBlock(m.stream.assistant)
			m.stream.assistant = nil
		}
		if m.stream.assistant != nil {
			m.stream.assistant.streaming = false
		}
		if m.stream.thinking != nil {
			if thinking := m.stream.acc.Thinking(); thinking != "" {
				m.stream.thinking.setText(thinking)
			}
			m.stream.thinking.streaming = false
		}
		if thinking := messageThinking(message); thinking != "" && m.stream.thinking == nil {
			block := newBlock(blockThinking, thinking)
			block.collapsed = !m.showThinking
			m.transcript.Add(block)
		}
		// Stream state is per message: drop it so the next assistant message
		// appends fresh blocks after this message's tool calls. message_start
		// does the same; doing it here too covers backends that skip it.
		m.beginAssistantMessage()
		m.transcript.MarkDirty()

	case "toolResult":
		m.applyToolResult(message)

	case "user":
		text := strings.TrimSpace(message.Text())
		if text == "" {
			return
		}
		// pi echoes the prompt that opened the run and every delivered steering
		// or follow-up message as a user message. The opening prompt is already
		// on screen optimistically, so consume its echo instead of drawing it
		// twice; a delivered queued message has no block yet and joins here.
		if optimistic := m.pendingPrompt; optimistic != nil {
			blocks := m.transcript.Blocks()
			if len(blocks) > 0 && blocks[len(blocks)-1] == optimistic {
				m.pendingPrompt = nil
				if !m.pendingPromptLabel && strings.TrimSpace(optimistic.text) != text {
					// pi may expand a prompt template or skill before emitting
					// the message; adopt the authoritative text. An image label
					// is local presentation and keeps its own text.
					optimistic.setText(text)
					m.transcript.MarkDirty()
				}
				m.pendingPromptLabel = false
				return
			}
		}
		m.transcript.Add(newBlock(blockUser, text))
		m.followOutput()
	}
}

// clearPendingPrompt forgets the optimistic prompt state. A caller that takes
// the block back from the transcript does that first.
func (m *Model) clearPendingPrompt() {
	m.pendingPrompt = nil
	m.pendingPromptText = ""
	m.pendingPromptLabel = false
}

func (m *Model) finishStream() {
	if m.stream.assistant != nil {
		m.stream.assistant.streaming = false
	}
	if m.stream.thinking != nil {
		m.stream.thinking.streaming = false
	}
	m.stream.dirty = false
	m.stream = streamState{}
}

func (m *Model) removeBlock(target *block) {
	blocks := m.transcript.Blocks()
	for i, existing := range blocks {
		if existing == target {
			m.transcript.blocks = append(blocks[:i], blocks[i+1:]...)
			m.transcript.MarkDirty()
			return
		}
	}
}

// startTool renders a tool call. File mutations get a diff block instead of a
// raw argument dump.
func (m *Model) startTool(event *rpc.ToolExecutionStartEvent) {
	args := rpc.DecodeArgs(event.Args)
	input := strings.TrimSpace(string(event.Args))
	if input == "" && args != nil {
		input = string(mustJSON(args))
	}
	m.activity.addTool(event.ToolCallID, event.ToolName, args, input)

	if block, ok := newDiffBlock(event.ToolCallID, event.ToolName, args); ok {
		m.syncBlockExpansion(block)
		m.transcript.Add(block)
		m.followOutput()
		return
	}

	block := newToolBlock(event.ToolCallID, event.ToolName, args)
	block.status = statusRunning
	m.syncBlockExpansion(block)
	block.streaming = true
	m.transcript.Add(block)
	m.followOutput()
}

// newDiffBlock builds the diff card of a file mutation. Its rows are capped and
// syntax-coloured once here, so streaming and scrolling never tokenize again.
func newDiffBlock(callID, name string, args map[string]any) (*block, bool) {
	path, pairs, ok := toolDiff(name, args)
	if !ok {
		return nil, false
	}
	lines, truncated := styledDiffLines(pairs, toolCodeLexer(name, args), expandedBodyCap)
	added, removed := diffStats(pairs)
	block := newBlock(blockDiff, "")
	block.callID = callID
	block.title = strings.TrimSpace(name + " " + path)
	block.meta = fmt.Sprintf("+%d -%d", added, removed)
	if truncated {
		block.meta += " (truncated)"
	}
	block.diff = lines
	return block, true
}

// newToolBlock builds the compact card of a tool that does not mutate files. A
// shell call carries its highlighted command above the output instead of a
// one-line summary, so a multi-line command keeps its shape.
func newToolBlock(callID, name string, args map[string]any) *block {
	block := newBlock(blockTool, "")
	block.callID = callID
	block.title = name
	if isShellToolName(strings.ToLower(strings.TrimSpace(name))) {
		block.command = toolCommandLines(name, args)
	}
	if len(block.command) == 0 {
		block.summary = toolSummary(name, args)
	}
	return block
}

func (m *Model) updateTool(event *rpc.ToolExecutionUpdateEvent) {
	block := m.transcript.Tool(event.ToolCallID)
	if block == nil {
		return
	}
	if preview := toolResultText(event.PartialResult); preview != "" && block.kind != blockDiff {
		block.body = preview
		m.syncBlockExpansion(block)
		block.invalidate()
	}
}

func (m *Model) endTool(event *rpc.ToolExecutionEndEvent) {
	m.activity.removeTool(event.ToolCallID)
	block := m.transcript.Tool(event.ToolCallID)
	if block == nil {
		return
	}

	if event.IsError {
		block.status = statusError
	}
	if block.kind != blockDiff {
		if event.IsError {
			block.status = statusError
		} else {
			block.status = statusOK
		}
		if body := toolResultText(event.Result); body != "" {
			block.body = body
		}
	}
	if event.DurationMs != nil {
		block.meta = strings.TrimSpace(block.meta + " " + formatDuration(time.Duration(*event.DurationMs*float64(time.Millisecond))))
	}
	if event.IsError && block.kind == blockDiff {
		block.status = statusError
		if body := toolResultText(event.Result); body != "" {
			block.body = body
		}
	}
	block.streaming = false
	m.syncBlockExpansion(block)
	block.invalidate()
	m.transcript.MarkDirty()
}

func (m *Model) applyToolResult(message rpc.Message) {
	block := m.transcript.Tool(message.ToolCallID)
	if block == nil {
		return
	}
	// A diff card keeps its rows; a result only replaces them when the tool
	// failed, where the error text explains the failure below the diff.
	if body := toolResultText(mustJSON(message)); body != "" && (block.kind != blockDiff || message.IsError) {
		block.body = body
	}
	if message.IsError {
		block.status = statusError
	} else if block.status == statusRunning {
		block.status = statusOK
	}
	m.syncBlockExpansion(block)
	block.invalidate()
	m.transcript.MarkDirty()
}

// loadHistory replays messages returned by get_messages into the transcript.
func (m *Model) loadHistory(messages []rpc.Message) {
	m.transcript.Clear()
	// The startup card opens the scrollback. It is the first entry of the
	// conversation, so a resumed session keeps its history in view while the
	// card stays available by scrolling up.
	m.transcript.Add(m.welcomeBlock())
	for _, message := range messages {
		switch message.Role {
		case "user":
			text := strings.TrimSpace(message.Text())
			if text == "" {
				continue
			}
			m.transcript.Add(newBlock(blockUser, text))
		case "assistant":
			if thinking := messageThinking(message); thinking != "" {
				block := newBlock(blockThinking, thinking)
				block.collapsed = !m.showThinking
				m.transcript.Add(block)
			}
			if text := message.Text(); strings.TrimSpace(text) != "" {
				m.transcript.Add(newBlock(blockAssistant, text))
			}
			for _, call := range message.Tools() {
				args := rpc.DecodeArgs(call.Arguments)
				if block, ok := newDiffBlock(call.ID, call.Name, args); ok {
					m.syncBlockExpansion(block)
					m.transcript.Add(block)
					continue
				}
				block := newToolBlock(call.ID, call.Name, args)
				block.status = statusPending
				m.syncBlockExpansion(block)
				m.transcript.Add(block)
			}
		case "toolResult":
			block := m.transcript.Tool(message.ToolCallID)
			if block == nil {
				continue
			}
			if body := toolResultText(mustJSON(message)); body != "" && (block.kind != blockDiff || message.IsError) {
				block.body = body
			}
			if message.IsError {
				block.status = statusError
			} else if block.kind != blockDiff {
				block.status = statusOK
			}
			m.syncBlockExpansion(block)
		}
	}
	m.transcript.ScrollToBottom()
}

// handleKey routes one key press.
func (m *Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// A key press ends the mouse selection, including a drag whose release
	// event was lost outside the terminal window.
	if m.transcript != nil && m.transcript.HasSelection() {
		m.transcript.ClearSelection()
	}
	if m.composer != nil && m.composer.HasSelection() {
		m.composer.ClearSelection()
	}

	if m.overlay != nil {
		return m.handleOverlayKey(msg)
	}
	if m.ask != nil {
		return m.handleAskKey(msg)
	}

	key := msg.String()

	// The palette stays reachable whatever the composer holds, so it wins over
	// the completion popup's navigation keys.
	if key == "ctrl+p" {
		return m, m.openPalette()
	}

	// Completion keys win over the editor so the popup behaves predictably.
	if m.completion.visible {
		switch key {
		case "up":
			m.completion.Move(-1)
			return m, nil
		case "down", "ctrl+n":
			m.completion.Move(1)
			return m, nil
		case "tab":
			if item, ok := m.completion.Selected(); ok {
				m.acceptCompletion(item)
			}
			return m, nil
		case "enter":
			if item, ok := m.completion.Selected(); ok {
				m.composer.SetText(item.Value)
				m.completion.Hide()
				m.layout()
				return m, m.submit()
			}
		}
	}

	switch key {
	case "ctrl+c":
		// ctrl+c belongs to the editor: it clears the draft and never
		// interrupts, so a mistyped follow-up can be discarded while the
		// running turn keeps going. Interrupting is esc's job.
		if !m.composer.Empty() {
			m.composer.Clear()
			m.completion.Hide()
			m.layout()
			m.ctrlCAt = time.Time{}
			m.setToast("input cleared · press up to restore")
			return m, nil
		}
		if m.busy {
			// An empty prompt only has the quit chord left, and old ctrl+c
			// habits must not end the client while pi is still working.
			m.ctrlCAt = time.Time{}
			m.setToast("esc interrupts the running turn")
			return m, nil
		}
		// On an empty prompt two presses quit. A clear disarms the window, so
		// typing after a clear cannot quit by accident.
		if time.Since(m.ctrlCAt) < 1500*time.Millisecond {
			return m, tea.Quit
		}
		m.ctrlCAt = time.Now()
		m.setToast("press ctrl+c again to quit")
		return m, nil

	case "ctrl+d":
		if m.composer.Empty() && !m.busy {
			return m, tea.Quit
		}

	case "esc":
		if m.busy {
			return m, m.abort()
		}
		if m.completion.visible {
			m.completion.Hide()
			m.layout()
		}
		return m, nil

	case "enter":
		if !m.enterToSend {
			m.composer.InsertNewline()
			m.completion.Refresh(m.composer.Value())
			m.layout()
			return m, nil
		}
		// A trailing backslash continues the prompt, the way Codex and Claude
		// Code accept a newline in terminals without shift+enter.
		if m.composer.TakeNewlineEscape() {
			m.completion.Refresh(m.composer.Value())
			m.layout()
			return m, nil
		}
		return m, m.submit()

	case "alt+enter":
		if !m.enterToSend {
			return m, m.submit()
		}

	case "alt+s", "ctrl+s":
		if m.busy {
			return m, m.submitSteer()
		}
		if !m.composer.Empty() {
			m.setToast("steer is only available while a turn is running")
		}
		return m, nil

	case "shift+tab":
		return m, m.togglePlan()

	case "shift+up":
		return m, m.stepThinking(1)

	case "shift+down":
		return m, m.stepThinking(-1)

	case "shift+left":
		return m, m.cyclePreset(-1)

	case "shift+right":
		return m, m.cyclePreset(1)

	case "ctrl+k":
		return m, m.openModelPicker()

	case "ctrl+g":
		return m, m.openPresetPicker()

	case "ctrl+t":
		m.showThinking = !m.showThinking
		if m.prefs != nil {
			_ = m.prefs.SetShowThinking(m.showThinking)
		}
		m.applyThinkingVisibility()
		m.setToast(fmt.Sprintf("thinking blocks %s", onOff(m.showThinking)))
		return m, nil

	case "ctrl+o":
		m.expanded = !m.expanded
		if m.prefs != nil {
			_ = m.prefs.SetExpandTools(m.expanded)
		}
		m.applyExpansion()
		m.setToast(fmt.Sprintf("tool output %s", onOff(m.expanded)))
		return m, nil

	case "ctrl+l":
		m.transcript.Clear()
		return m, nil

	case "pgup", "pgdown", "ctrl+u":
		return m, m.transcript.Update(msg)
	}

	// The arrows walk the prompt first and only fall back to history once the
	// caret reaches the first or last visual row.
	switch key {
	case "up":
		if m.composer.MoveUp() {
			return m, nil
		}
		if m.composer.HistoryPrev() {
			m.completion.Refresh(m.composer.Value())
			m.layout()
		}
		return m, nil
	case "down":
		if m.composer.MoveDown() {
			return m, nil
		}
		if m.composer.HistoryNext() {
			m.completion.Refresh(m.composer.Value())
			m.layout()
		}
		return m, nil
	}

	beforeHeight := m.composer.Height()
	beforeVisible := m.completion.visible
	beforeCount := len(m.completion.filtered)

	cmd := m.composer.Update(msg)
	m.completion.Refresh(m.composer.Value())

	// The popup changes the reserved body height, so the frame must be
	// re-laid-out whenever it appears, disappears, or resizes.
	if m.composer.Height() != beforeHeight ||
		m.completion.visible != beforeVisible ||
		len(m.completion.filtered) != beforeCount {
		m.layout()
	}
	return m, cmd
}

func (m *Model) acceptCompletion(item completionItem) {
	m.composer.SetText(item.Value + " ")
	m.completion.Hide()
	m.layout()
}

func (m *Model) applyThinkingVisibility() {
	for _, block := range m.transcript.Blocks() {
		if block.kind == blockThinking {
			block.collapsed = !m.showThinking
			block.invalidate()
		}
	}
	m.transcript.MarkDirty()
}

// syncBlockExpansion re-evaluates a tool or diff block's default collapsed
// state after its body changes. Short bodies stay visible like a terminal
// session; long ones fold to their summary and preview rows. A running tool
// keeps its bounded live tail in the collapsed default instead of streaming
// its whole log, and folds or expands with everything else once it finishes.
func (m *Model) syncBlockExpansion(b *block) {
	if b.kind != blockTool && b.kind != blockDiff {
		return
	}
	if b.streaming && b.kind == blockTool {
		b.collapsed = !m.expanded
		return
	}
	rows := bodyLines(b.body)
	if b.kind == blockDiff {
		rows += len(b.diff)
	}
	b.collapsed = !m.expanded && autoCollapsed(b.kind, rows)
}

func (m *Model) applyExpansion() {
	for _, block := range m.transcript.Blocks() {
		if block.kind == blockTool || block.kind == blockDiff {
			m.syncBlockExpansion(block)
			block.invalidate()
		}
	}
	m.transcript.MarkDirty()
}

// submit sends the composer contents.
func (m *Model) submit() tea.Cmd {
	text := strings.TrimSpace(m.composer.Value())
	if text == "" || m.disconnected || m.fatal != "" {
		return nil
	}

	m.composer.PushHistory(text)
	m.composer.Reset()
	m.completion.Hide()
	m.layout()

	return m.dispatchCommand(text)
}

// dispatchCommand routes a prompt or slash command. The composer owns history
// and resetting, so callers that did not edit it (the palette) can reuse the
// same routing and keep the draft.
func (m *Model) dispatchCommand(text string) tea.Cmd {
	if text == "" || m.disconnected || m.fatal != "" {
		return nil
	}

	if strings.HasPrefix(text, "/") {
		if cmd, handled := m.runSlash(text); handled {
			return cmd
		}
	}

	if m.state.SessionName == "" {
		if m.autoTitleAttempts >= maxAutoTitleAttempts {
			m.autoTitleAttempts = 0
		}
		m.autoTitlePending = true
	}
	// A running turn stages this prompt in pi's queue. The queued panel above
	// the composer owns it until pi delivers it; adding a transcript block now
	// would make it look like the follow-up already joined the conversation.
	if !m.busy {
		userBlock := newBlock(blockUser, text)
		m.transcript.Add(userBlock)
		m.pendingPrompt = userBlock
		m.pendingPromptLabel = false
		m.pendingPromptText = text
		m.followOutput()
	}
	return m.sendPrompt(text)
}

func (m *Model) sendPrompt(text string) tea.Cmd {
	client := m.client
	queued := m.busy
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
		defer cancel()

		command := rpc.Prompt(text)
		if queued {
			command = rpc.FollowUp(text)
		}
		response, err := client.DoOK(ctx, command)
		return responseMsg{action: "prompt", queued: queued, resp: response, err: err}
	}
}

// submitSteer sends the composer contents as a steering message for the running turn.
func (m *Model) submitSteer() tea.Cmd {
	text := strings.TrimSpace(m.composer.Value())
	if text == "" || m.disconnected || m.fatal != "" {
		return nil
	}

	m.composer.PushHistory(text)
	m.composer.Reset()
	m.completion.Hide()
	m.layout()

	if strings.HasPrefix(text, "/") {
		if cmd, handled := m.runSlash(text); handled {
			return cmd
		}
	}

	return m.sendSteer(text)
}

func (m *Model) sendSteer(text string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
		defer cancel()

		command := rpc.Steer(text)
		response, err := client.DoOK(ctx, command)
		return responseMsg{action: "steer", resp: response, err: err}
	}
}

// abort clears queued messages, restores them to the editor, then aborts.
func (m *Model) abort() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		msg := abortMsg{}
		if response, err := client.DoOK(ctx, rpc.ClearQueue()); err == nil {
			var payload struct {
				Steering []string `json:"steering"`
				FollowUp []string `json:"followUp"`
			}
			_ = response.DecodeData(&payload)
			msg.restored = append(payload.Steering, payload.FollowUp...)
		} else {
			msg.err = err
		}
		if _, err := client.DoOK(ctx, rpc.Abort()); err != nil && msg.err == nil {
			msg.err = err
		}
		return msg
	}
}

// runSlash executes a client-side command. It reports false when the text is a
// pi command (extension, prompt template, skill) that must be forwarded.
//
// Canonical names always resolve locally. An alias yields to pi when pi
// advertised the same name, so personal commands keep working.
func (m *Model) runSlash(text string) (tea.Cmd, bool) {
	fields := strings.Fields(text)
	name := fields[0]
	argument := strings.TrimSpace(strings.TrimPrefix(text, name))

	// The goal package owns every argument form, but the bare command opens
	// the terminal's status panel so the objective and controls are reachable.
	if name == "/goal" {
		if argument == "" || !m.goalAvailable {
			return m.openGoalPanel(), true
		}
		return nil, false
	}

	// A future pi may expose sign-in over RPC. When it does, its own command
	// wins: this client's version only bridges the gap until then.
	if (name == "/login" || name == "/logout") && m.piOwns(name) {
		return nil, false
	}

	// A page command must not shadow a pi command with the same name, such as
	// an extension's own /mcp handler. The page stays reachable as /settings
	// <name> in that case.
	if isPageCommand(name) && m.piOwns(name) {
		return nil, false
	}

	target, known := builtinIndex[name]
	if !known || (target.alias && m.piOwns(name)) {
		return nil, false
	}

	switch target.name {
	case "/quit":
		return tea.Quit, true
	case "/clear":
		m.transcript.Clear()
		return nil, true
	case "/mouse":
		return m.toggleMouse(), true
	case "/help":
		title := "Key bindings"
		if m.opts.Version != "" {
			title = "pie " + m.opts.Version
		}
		m.openOverlay(newPickerOverlay("help", title, m.helpItems()))
		return nil, true
	case "/model":
		if argument != "" {
			return m.setModelByLabel(argument), true
		}
		return m.openModelPicker(), true
	case "/models":
		return m.openPage(pageModels), true
	case "/providers":
		return m.openPage(pageProviders), true
	case "/skills":
		return m.openPage(pageSkills), true
	case "/mcp":
		return m.openPage(pageMCP), true
	case "/plugins":
		return m.openPage(pagePlugins), true
	case "/login":
		return m.openLoginPicker(argument), true
	case "/logout":
		return m.openLogoutPicker(), true
	case "/think":
		if argument != "" {
			level := strings.ToLower(argument)
			if !config.IsThinkingLevel(level) {
				m.setToast("unknown thinking level: " + argument)
				return nil, true
			}
			return m.setThinking(level), true
		}
		return m.cycleThinking(), true
	case "/new":
		if m.busy {
			m.setToast("stop the current turn before starting a new session")
			return nil, true
		}
		return m.newSession(), true
	case "/resume":
		if m.busy {
			m.setToast("stop the current turn before resuming another session")
			return nil, true
		}
		return m.listSessions(), true
	case "/compact":
		return m.compact(argument), true
	case "/export":
		return m.exportSession(), true
	case "/stats":
		return m.openStats(), true
	case "/name":
		if argument != "" {
			return m.setSessionName(argument), true
		}
		request := &rpc.ExtensionUIRequestEvent{Title: "Session name", Method: "input", Placeholder: "my-feature-work"}
		overlay := newInputOverlay(request)
		overlay.action = "session-name"
		m.openOverlay(overlay)
		return nil, true
	case "/fork":
		if m.busy {
			m.setToast("stop the current turn before forking")
			return nil, true
		}
		return m.listForkMessages(), true
	case "/clone":
		if m.busy {
			m.setToast("stop the current turn before cloning")
			return nil, true
		}
		return m.cloneSession(), true
	case "/tree":
		return m.loadTree(), true
	case "/search":
		if argument != "" {
			return m.searchSessions(argument), true
		}
		request := &rpc.ExtensionUIRequestEvent{Title: "Search sessions", Method: "input", Placeholder: "jsonc parser"}
		overlay := newInputOverlay(request)
		overlay.action = "session-search"
		m.openOverlay(overlay)
		return nil, true
	case "/context":
		return m.openContext(), true
	case "/image":
		return m.sendImage(argument), true
	case "/paste":
		return readClipboard(), true
	case "/cwd":
		if argument != "" {
			return m.switchProject(argument), true
		}
		return m.openProjectPicker(), true
	case "/title":
		if argument != "" {
			return m.setSessionName(argument), true
		}
		return m.generateTitle(), true
	case "/settings":
		if argument != "" {
			tabID, ok := settingsTabID(argument)
			if !ok {
				m.setToast("unknown settings tab: " + argument)
				return nil, true
			}
			return m.openSettingsAt(tabID), true
		}
		return m.openSettings(), true
	case "/preset":
		if argument != "" {
			selection, ok := m.resolvePresetArg(argument)
			if !ok {
				m.setToast("unknown preset: " + argument)
				return nil, true
			}
			return m.applyPreset(selection), true
		}
		return m.openPresetPicker(), true
	default:
		return nil, false
	}
}

func (m *Model) helpItems() []pickerItem {
	bindings := [][2]string{
		{"enter", "send prompt (stages a follow-up above the prompt while running)"},
		{"alt+enter / ctrl+j", "insert a newline"},
		{"alt+s", "steer the running turn"},
		{"esc", "interrupt the running turn (queues are restored to the editor)"},
		{"ctrl+c", "clear the prompt (up restores it); on an empty prompt, twice to quit"},
		{"ctrl+d", "in the resume list, twice to delete the selected session"},
		{"ctrl+k", "pick a model"},
		{"ctrl+g", "pick a tool preset"},
		{"shift+left / shift+right", "cycle tool presets"},
		{"ctrl+p", "open the command palette"},
		{"shift+up / shift+down", "raise or lower the reasoning level"},
		{"shift+tab", "toggle plan mode and restore the previous preset"},
		{"ctrl+t", "toggle thinking blocks"},
		{"ctrl+o", "expand tool output and diffs"},
		{"ctrl+l", "clear the scrollback"},
		{"up / down", "prompt history"},
		{"pgup / pgdn / ctrl+u", "scroll the transcript"},
		{"click", "place the caret in the prompt"},
		{"drag / release", "select prompt or transcript text and copy it"},
		{"shift+drag", "use the terminal's native selection"},
	}
	items := make([]pickerItem, 0, len(bindings))
	for _, binding := range bindings {
		items = append(items, pickerItem{Value: binding[0], Label: binding[0], Detail: binding[1]})
	}
	for _, command := range builtinCommandTable {
		detail := command.Detail
		if len(command.Aliases) > 0 {
			detail += "  (aliases: " + strings.Join(command.Aliases, ", ") + ")"
		}
		items = append(items, pickerItem{Value: command.Name, Label: command.Name, Detail: detail})
	}
	return items
}

// Command constructors.

// refreshStats asks pi for the session counters and context usage. It must be
// called from Update: it reserves a request id so an older reply can never
// overwrite a newer one. A failed read is reported through statsMsg and keeps
// the last good values on screen.
func (m *Model) refreshStats() tea.Cmd {
	client := m.client
	m.statsRequest++
	request := m.statsRequest
	m.statsInFlight = request
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.GetSessionStats())
		if err != nil {
			return statsMsg{request: request, err: err}
		}
		stats, err := rpc.DecodeTyped[rpc.SessionStats](response)
		if err != nil {
			return statsMsg{request: request, err: err}
		}
		return statsMsg{request: request, stats: stats}
	}
}

// invalidateStats drops replies from a session the user already left.
func (m *Model) invalidateStats() {
	m.statsApplied = m.statsRequest
	m.statsInFlight = 0
}

func (m *Model) cycleThinking() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.CycleThinkingLevel())
		return responseMsg{action: "thinking", resp: response, err: err}
	}
}

// stepThinking raises or lowers the reasoning level by one supported step.
// The handshake lists the levels the current model accepts; the configured
// list is a fallback when pi reported none.
func (m *Model) stepThinking(delta int) tea.Cmd {
	if m.state.Model != nil && !m.state.Model.Reasoning {
		m.setToast("this model does not support thinking levels")
		return nil
	}
	levels := m.levels
	if len(levels) == 0 {
		levels = config.ThinkingLevels
	}
	index := -1
	for i, level := range levels {
		if level == m.state.ThinkingLevel {
			index = i
			break
		}
	}
	if index < 0 && delta < 0 {
		index = len(levels)
	}
	next := index + delta
	if next < 0 || next >= len(levels) {
		current := m.state.ThinkingLevel
		if current == "" {
			current = "none"
		}
		m.setToast("thinking: " + current + " · limit")
		return nil
	}
	return m.setThinking(levels[next])
}

func (m *Model) setThinking(level string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.SetThinkingLevel(level))
		return responseMsg{action: "thinking", level: level, resp: response, err: err}
	}
}

func (m *Model) openModelPicker() tea.Cmd {
	if len(m.models) == 0 {
		m.setToast("no models reported by pi")
		return nil
	}
	items := make([]pickerItem, 0, len(m.models))
	for _, model := range m.models {
		if !m.modelEnabled(model) {
			continue
		}
		detail := model.Name
		if model.ContextWindow > 0 {
			detail += fmt.Sprintf(" · %s ctx", formatTokens(model.ContextWindow))
		}
		if m.state.Model != nil && m.state.Model.ID == model.ID && m.state.Model.Provider == model.Provider {
			detail += " · current"
		}
		items = append(items, pickerItem{Value: model.Label(), Label: model.Label(), Detail: detail})
	}
	if len(items) == 0 {
		m.setToast("every model is disabled; enable one in settings")
		return nil
	}
	m.openOverlay(newPickerOverlay("model", "Switch model", items))
	return nil
}

// modelEnabled applies enabledModels to the session model picker. A missing
// catalog keeps every model selectable rather than hiding all of them.
func (m *Model) modelEnabled(model rpc.ModelInfo) bool {
	if m.enabledModels == nil {
		return true
	}
	on, known := m.enabledModels[model.Provider+"/"+model.ID]
	if !known {
		// A model pi reports that the file catalog does not know (an extension
		// provider, or a fresh catalog) stays selectable.
		return true
	}
	return on
}

// savedThinkingLevel returns the configured startup level for a model.
func (m *Model) savedThinkingLevel(provider, id string) string {
	if m.settings == nil {
		return ""
	}
	levels, err := m.settings.ModelThinkingLevels()
	if err != nil {
		return ""
	}
	return levels[provider+"/"+id]
}

// rememberModelSelection writes the chosen model to pi's startup defaults, as
// pi's own model picker does, so the next launch starts on it. A resumed
// session still restores the model recorded in its own log.
func (m *Model) rememberModelSelection(model rpc.ModelInfo) {
	if m.settings == nil || model.Provider == "" || model.ID == "" {
		return
	}
	provider, _ := m.settings.DefaultProvider()
	current, _ := m.settings.DefaultModel()
	if provider == model.Provider && current == model.ID {
		return
	}
	err := m.settings.Update(func(root *config.Value) error {
		root.SetString("defaultProvider", model.Provider)
		root.SetString("defaultModel", model.ID)
		return nil
	})
	if err != nil {
		m.addError("remember model: " + err.Error())
	}
}

// rememberThinkingLevel writes the level as the current model's startup
// default. pi applies modelThinkingLevels to a new session on that model and
// when it switches back to it.
func (m *Model) rememberThinkingLevel(level string) {
	if m.settings == nil || m.state.Model == nil || !m.state.Model.Reasoning || !config.IsThinkingLevel(level) {
		return
	}
	if m.savedThinkingLevel(m.state.Model.Provider, m.state.Model.ID) == level {
		return
	}
	if err := m.settings.SetModelThinkingLevel(m.state.Model.Label(), level); err != nil {
		m.addError("remember thinking level: " + err.Error())
	}
}

func (m *Model) setModelByLabel(label string) tea.Cmd {
	for _, model := range m.models {
		if model.Label() == label || model.ID == label {
			client := m.client
			level := m.savedThinkingLevel(model.Provider, model.ID)
			return func() tea.Msg {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				response, err := client.DoOK(ctx, rpc.SetModel(model.Provider, model.ID))
				if err != nil {
					return responseMsg{action: "model", resp: response, err: err}
				}
				if level != "" {
					_, _ = client.DoOK(ctx, rpc.SetThinkingLevel(level))
				}
				var levels []string
				if available, err := client.DoOK(ctx, rpc.GetAvailableThinkingLevels()); err == nil {
					payload, _ := rpc.DecodeTyped[rpc.ThinkingLevelsPayload](available)
					levels = payload.Levels
				}
				return responseMsg{action: "model", levels: levels, resp: response}
			}
		}
	}
	m.setToast("unknown model: " + label)
	return nil
}

func (m *Model) newSession() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.NewSession())
		return responseMsg{action: "new_session", resp: response, err: err}
	}
}

func (m *Model) listSessions() tea.Cmd {
	dir, cwd := m.opts.SessionDir, m.opts.CWD
	return func() tea.Msg {
		resolved, err := session.Dir(dir)
		if err != nil {
			return sessionListMsg{err: err}
		}
		var entries []session.Entry
		if m.sessionsAll {
			entries, err = session.List(resolved, 30)
		} else {
			entries, err = session.ListForCWD(resolved, cwd, 30)
		}
		return sessionListMsg{entries: entries, err: err}
	}
}

func (m *Model) switchSession(path string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if _, err := client.DoOK(ctx, rpc.SwitchSession(path)); err != nil {
			return responseMsg{action: "switch_session", err: err}
		}
		response, err := client.DoOK(ctx, rpc.GetMessages())
		if err != nil {
			return historyMsg{err: err}
		}
		payload, _ := rpc.DecodeTyped[rpc.MessagesPayload](response)
		msg := historyMsg{messages: payload.Messages}
		if stateResponse, stateErr := client.DoOK(ctx, rpc.GetState()); stateErr == nil {
			if state, decodeErr := rpc.DecodeTyped[rpc.State](stateResponse); decodeErr == nil {
				msg.state = &state
			}
		}
		return msg
	}
}

func (m *Model) compact(instructions string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.Compact(instructions))
		return responseMsg{action: "compact", resp: response, err: err}
	}
}

func (m *Model) exportSession() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.ExportHTML(""))
		return responseMsg{action: "export", resp: response, err: err}
	}
}

// generateTitle asks a one-shot model call to name the session from the
// transcript, matching the web UI's auto-name action.
func (m *Model) generateTitle() tea.Cmd {
	if m.titleRunning {
		m.setToast("title generation already running")
		return nil
	}
	requestID := m.beginTitleRequest()
	return m.generateTitleCommandWithMessages(nil, false, requestID)
}

// beginTitleRequest reserves the single title slot and returns its id. The
// request id lets a late result from an older request leave the slot alone.
func (m *Model) beginTitleRequest() uint64 {
	m.titleSeq++
	m.titleRequest = m.titleSeq
	m.titleRunning = true
	return m.titleRequest
}

// invalidateTitle drops the current title request. A late result is ignored
// because its request id no longer matches.
func (m *Model) invalidateTitle() {
	m.titleRunning = false
	m.titleRequest = 0
}

// hasTitleHistory reports whether a session has enough conversational text to
// name. Tool-only history is not useful to the title model.
func (m *Model) hasTitleHistory(messages []rpc.Message) bool {
	return title.Transcript(messages) != ""
}

// autoTitleFromHistory starts a best-effort title request for a resumed or
// attached unnamed session.
func (m *Model) autoTitleFromHistory(messages []rpc.Message) tea.Cmd {
	return m.startAutoTitle(messages)
}

// startAutoTitle starts one automatic title request. It returns nil when the
// session is named, a request is already running, the attempt budget is spent,
// or a supplied history has nothing to name.
func (m *Model) startAutoTitle(messages []rpc.Message) tea.Cmd {
	if m.state.SessionName != "" || m.nameWatchValid || m.titleRunning || m.autoTitleAttempts >= maxAutoTitleAttempts {
		return nil
	}
	if messages != nil && !m.hasTitleHistory(messages) {
		return nil
	}
	m.autoTitleAttempts++
	m.autoTitlePending = true
	requestID := m.beginTitleRequest()
	return m.generateTitleCommandWithMessages(messages, true, requestID)
}

// noteSessionName records a title learned from pi, this client, or the session
// file. It also updates an open resume picker so the row stops showing the
// first prompt as soon as a title exists.
func (m *Model) noteSessionName(name string) {
	m.nameWatchSeq++
	m.nameWatchName = name
	m.nameWatchValid = true
	m.nameWatchPath = m.state.SessionFile
	m.state.SessionName = name
	if name == "" {
		return
	}
	m.autoTitlePending = false
	m.autoTitleAttempts = 0
	if o := m.overlay; o != nil && o.action == "session" {
		changed := false
		for i := range o.items {
			if o.items[i].Value == m.state.SessionFile {
				o.items[i].Label = name
				changed = true
			}
		}
		if changed {
			o.refilter()
		}
	}
}

// resetSessionNameWatch makes the next heartbeat seed the name watcher from
// the current session file instead of carrying offsets across sessions.
func (m *Model) resetSessionNameWatch() {
	m.nameWatchSeq++
	m.nameWatchPath = ""
	m.nameWatchOffset = 0
	m.nameWatchPartial = nil
	m.nameWatchName = ""
	m.nameWatchValid = false
	m.namePollPending = false
	m.namePollAt = time.Time{}
}

// pollSessionName reads appended session records and reports a session_info
// written by another client, such as the Web UI. Reading only new bytes keeps
// long sessions cheap to watch.
func (m *Model) pollSessionName() tea.Cmd {
	path := m.state.SessionFile
	if path == "" || m.namePollPending || time.Since(m.namePollAt) < externalNamePollInterval {
		return nil
	}
	m.namePollPending = true
	m.namePollAt = time.Now()
	sessionID := m.state.SessionID
	first := m.nameWatchPath != path
	offset := m.nameWatchOffset
	partial := append([]byte(nil), m.nameWatchPartial...)
	if first {
		offset = 0
		partial = nil
	}
	m.namePollID++
	pollID := m.namePollID
	watchSeq := m.nameWatchSeq

	return func() tea.Msg {
		if first {
			// Seed from the newest record in the whole file, not just a tail
			// window: a clear or a title can sit megabytes from the end.
			name, found, size, err := session.LatestName(path)
			if err != nil {
				return sessionNameMsg{sessionID: sessionID, pollID: pollID, watchSeq: watchSeq, path: path, err: err}
			}
			return sessionNameMsg{
				sessionID: sessionID,
				pollID:    pollID,
				watchSeq:  watchSeq,
				path:      path,
				name:      name,
				found:     found,
				offset:    size,
			}
		}

		file, err := os.Open(path)
		if err != nil {
			return sessionNameMsg{sessionID: sessionID, pollID: pollID, watchSeq: watchSeq, path: path, err: err}
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return sessionNameMsg{sessionID: sessionID, pollID: pollID, watchSeq: watchSeq, path: path, err: err}
		}
		size := info.Size()
		start := offset
		if size < start {
			start = 0
			partial = nil
		}
		if size <= start {
			return sessionNameMsg{sessionID: sessionID, pollID: pollID, watchSeq: watchSeq, path: path, offset: size, partial: partial}
		}
		if size-start > maxSessionNameRead {
			// A suspended client can wake up megabytes behind. Scan for the
			// newest title instead of allocating the whole gap, and resume
			// incrementally from the size that scan covered.
			name, found, scanned, err := session.LatestName(path)
			if err != nil {
				return sessionNameMsg{sessionID: sessionID, pollID: pollID, watchSeq: watchSeq, path: path, err: err}
			}
			return sessionNameMsg{
				sessionID: sessionID,
				pollID:    pollID,
				watchSeq:  watchSeq,
				path:      path,
				name:      name,
				found:     found,
				offset:    scanned,
			}
		}

		buf := make([]byte, size-start)
		if _, err := file.ReadAt(buf, start); err != nil {
			return sessionNameMsg{sessionID: sessionID, pollID: pollID, watchSeq: watchSeq, path: path, err: err}
		}
		name, found, rest := session.ParseNameChunk(append(partial, buf...))
		if len(rest) > session.NamePartialLimit {
			// Only a pathological single line grows this far; a session_info
			// record is short, so dropping it cannot lose a title.
			rest = nil
		}
		return sessionNameMsg{
			sessionID: sessionID,
			pollID:    pollID,
			watchSeq:  watchSeq,
			path:      path,
			name:      name,
			found:     found,
			offset:    size,
			partial:   rest,
		}
	}
}

func (m *Model) generateTitleCommandWithMessages(messages []rpc.Message, silent bool, requestID uint64) tea.Cmd {
	client := m.client
	bin := m.opts.PiBin
	model := m.state.Model
	sessionID := m.state.SessionID
	sessionFile := m.state.SessionFile
	epoch := m.sessionEpoch.Load()
	level := "off"
	modelRef := ""
	if model != nil {
		modelRef = model.Provider + "/" + model.ID
		if entry := m.catalog.Model(modelRef); entry != nil {
			level = title.ResolveThinkingLevel(entry)
		}
	}

	result := func(msg titleMsg) tea.Msg {
		msg.sessionID = sessionID
		msg.requestID = requestID
		return msg
	}

	return func() tea.Msg {
		if client == nil {
			return result(titleMsg{err: errors.New("not connected"), silent: silent})
		}
		if messages == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			response, err := client.DoOK(ctx, rpc.GetMessages())
			cancel()
			if err != nil {
				return result(titleMsg{err: err, silent: silent})
			}
			payload, err := rpc.DecodeTyped[rpc.MessagesPayload](response)
			if err != nil {
				return result(titleMsg{err: err, silent: silent})
			}
			messages = payload.Messages
		}
		transcript := title.Transcript(messages)
		if transcript == "" {
			return result(titleMsg{err: errors.New("nothing to title yet"), silent: silent})
		}

		genCtx, cancel := context.WithTimeout(context.Background(), title.Timeout)
		defer cancel()
		name, err := title.Generate(genCtx, title.Options{PiBin: bin, Model: modelRef, Thinking: level}, transcript)
		if err != nil {
			return result(titleMsg{err: err, silent: silent})
		}
		if m.sessionEpoch.Load() != epoch {
			return result(titleMsg{err: errors.New("session changed or renamed while generating title"), silent: silent})
		}
		if silent {
			// Another client may have named the session while the model was
			// working. Its title wins; do not append a second session_info.
			if sessionFile != "" {
				if existing, found, _, readErr := session.LatestName(sessionFile); readErr == nil && found {
					// A regular title means another client won; an empty
					// session_info is a deliberate clear and must not be
					// resurrected by a stale in-memory name.
					return result(titleMsg{title: existing, silent: true})
				}
			}
			stateCtx, stateCancel := context.WithTimeout(context.Background(), 5*time.Second)
			stateResponse, stateErr := client.DoOK(stateCtx, rpc.GetState())
			stateCancel()
			if stateErr == nil {
				if state, decodeErr := rpc.DecodeTyped[rpc.State](stateResponse); decodeErr == nil {
					if state.SessionID != "" && state.SessionID != sessionID {
						return result(titleMsg{err: errors.New("session changed while generating title"), silent: true})
					}
					if state.SessionName != "" {
						return result(titleMsg{title: state.SessionName, silent: true})
					}
				}
			}
		}
		if m.sessionEpoch.Load() != epoch {
			return result(titleMsg{err: errors.New("session changed or renamed while generating title"), silent: silent})
		}

		setCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		setResponse, err := client.DoOK(setCtx, rpc.SetSessionName(name))
		return result(titleMsg{title: name, resp: setResponse, err: err, silent: silent})
	}
}

func (m *Model) setSessionName(name string) tea.Cmd {
	m.sessionEpoch.Add(1)
	m.invalidateTitle()
	m.autoTitlePending = false
	m.autoTitleAttempts = 0
	m.nameWatchSeq++
	m.nameWatchName = name
	m.nameWatchValid = true
	m.nameWatchPath = m.state.SessionFile
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.SetSessionName(name))
		return responseMsg{action: "name", resp: response, err: err}
	}
}

// applyResponse folds a command result into the UI.
func (m *Model) applyResponse(msg responseMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		if msg.action == "name" {
			m.nameWatchValid = false
			m.nameWatchName = ""
		}
		m.addError(msg.err.Error())
		if msg.action == "prompt" && !msg.queued {
			m.busy = false
			m.activity.reset()
			m.layout()
		}
		return m, nil
	}

	response := msg.resp
	switch msg.action {
	case "steer":
		m.setToast("steer message sent")
		return m, nil

	case "prompt":
		var payload struct {
			Disposition string `json:"disposition"`
		}
		if response != nil {
			_ = response.DecodeData(&payload)
		}
		var titleCmd tea.Cmd
		if !msg.queued && payload.Disposition != "handled" && m.state.SessionName == "" && m.state.MessageCount == 0 &&
			!m.titleRunning && strings.TrimSpace(m.pendingPromptText) != "" {
			// Name a brand-new session from the first accepted prompt instead
			// of waiting for a long turn to settle.
			titleCmd = m.startAutoTitle([]rpc.Message{{
				Role:    "user",
				Content: rpc.Content{{Type: "text", Text: m.pendingPromptText}},
			}})
		}
		switch payload.Disposition {
		case "queued":
			// A prompt sent as a new turn can still land in pi's queue when a
			// run started while the request was in flight. Take back the
			// optimistic block; message_end will add it when it is delivered.
			if !msg.queued && m.pendingPrompt != nil {
				m.removeBlock(m.pendingPrompt)
				m.clearPendingPrompt()
			}
			m.setToast("message queued")
		case "handled":
			// An extension command is not conversation: take back the block the
			// composer optimistically added.
			handledText := m.pendingPromptText
			if !msg.queued && m.pendingPrompt != nil {
				m.removeBlock(m.pendingPrompt)
				m.clearPendingPrompt()
			}
			if !strings.HasPrefix(handledText, "/pie-") {
				m.setToast("handled by pi")
			}
		}
		if !msg.queued {
			// The block itself now carries the echo match.
			m.pendingPromptText = ""
		}
		return m, titleCmd

	case "model":
		if model, err := rpc.DecodeTyped[rpc.ModelInfo](response); err == nil && model.ID != "" {
			m.state.Model = &model
			if len(msg.levels) > 0 {
				m.levels = msg.levels
			}
			m.rememberModelSelection(model)
			m.setToast("model: " + model.Label())
			// The context window belongs to the model; reread it so the meter
			// shows the new limit before the next turn settles.
			return m, m.refreshStats()
		}

	case "thinking":
		// cycle_thinking_level reports the effective level; set_thinking_level
		// returns no payload, so the requested level from the command is used.
		level := msg.level
		if decoded, err := rpc.DecodeTyped[struct {
			Level string `json:"level"`
		}](response); err == nil && decoded.Level != "" {
			level = decoded.Level
		}
		if level == "" || (m.state.Model != nil && !m.state.Model.Reasoning) {
			m.setToast("this model does not support thinking levels")
			return m, nil
		}
		m.state.ThinkingLevel = level
		m.rememberThinkingLevel(level)
		m.setToast("thinking: " + level)

	case "new_session":
		m.resetPresetRestore()
		m.sessionEpoch.Add(1)
		m.invalidateStats()
		m.clearPendingPrompt()
		m.queue = rpc.QueueUpdateEvent{}
		m.transcript.Clear()
		m.autoTitlePending = false
		m.autoTitleAttempts = 0
		m.resetSessionNameWatch()
		m.invalidateTitle()
		m.state.SessionName = ""
		m.state.SessionFile = ""
		m.state.SessionID = ""
		// The entries and the refreshed state race; a new session has no
		// messages, so the saved preset must not read the old count.
		m.state.MessageCount = 0
		m.hasSelection = false
		m.currentMode = ""
		m.presetBeforePlan = ""
		m.logEntries = nil
		m.transcript.Add(m.welcomeBlock())
		m.addNotice("started a new session")
		return m, tea.Batch(m.refreshState(), m.refreshStats(), m.loadEntries())

	case "switch_session":
		m.resetPresetRestore()
		m.sessionEpoch.Add(1)
		m.invalidateStats()
		m.clearPendingPrompt()
		m.queue = rpc.QueueUpdateEvent{}
		m.transcript.Clear()
		m.autoTitlePending = false
		m.autoTitleAttempts = 0
		m.resetSessionNameWatch()
		m.invalidateTitle()
		m.state.SessionName = ""
		m.state.SessionFile = ""
		m.state.SessionID = ""
		m.presetBeforePlan = ""
		return m, tea.Batch(m.refreshState(), m.refreshStats(), m.loadEntries())

	case "compact":
		m.setToast("context compacted")
		return m, m.refreshStats()

	case "export":
		if payload, err := rpc.DecodeTyped[rpc.ExportPayload](response); err == nil && payload.Path != "" {
			m.setToast("exported to " + payload.Path)
		} else {
			m.setToast("session exported")
		}

	case "name":
		if response != nil {
			m.setToast("session renamed")
		}

	case "extension-select", "extension-input", "extension-editor":
		return m, nil
	}

	return m, nil
}

// refreshCommands rereads pi's extension commands after a reload, so a package
// disabled in Settings stops advertising its commands without a restart.
func (m *Model) refreshCommands() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.GetCommands())
		if err != nil {
			return commandsMsg{err: err}
		}
		payload, err := rpc.DecodeTyped[struct {
			Commands []rpc.CommandInfo `json:"commands"`
		}](response)
		if err != nil {
			return commandsMsg{err: err}
		}
		return commandsMsg{commands: payload.Commands}
	}
}

func (m *Model) refreshState() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.GetState())
		if err != nil {
			return responseMsg{action: "state", err: err}
		}
		state, _ := rpc.DecodeTyped[rpc.State](response)
		return stateMsg{state: state}
	}
}

// handleExtensionUI reacts to an extension UI subprotocol record.
func (m *Model) handleExtensionUI(request *rpc.ExtensionUIRequestEvent) (tea.Model, tea.Cmd) {
	// Sign-in state travels as one prefixed notification because the RPC UI
	// protocol has no richer channel; everything else stays a plain toast.
	if request.Method == "notify" {
		if payload, ok := parseAuthNotify(request.Message); ok {
			return m, tea.Batch(m.applyAuthNotify(payload), m.waitEvent())
		}
	}
	switch request.Method {
	case "notify":
		m.setToast(request.Message)
		if request.NotifyType == "error" {
			m.addError(request.Message)
		}
	case "setStatus":
		if request.StatusText == "" {
			delete(m.statuses, request.StatusKey)
		} else {
			m.statuses[request.StatusKey] = request.StatusText
		}
	case "setWidget":
		m.widget = request.WidgetLines
	case "setTitle":
		return m, tea.SetWindowTitle(request.Title)
	case "set_editor_text":
		if m.ask != nil {
			// The composer is answering a question, so a prefill lands in the
			// stashed draft and waits for the prompt to come back.
			m.ask.draft = request.Text
			break
		}
		m.composer.SetText(request.Text)
		m.completion.Refresh(m.composer.Value())
		m.layout()
	case "select", "confirm", "input", "editor":
		if m.overlay == nil && m.ask == nil {
			m.openExtensionOverlay(request)
			return m, m.waitEvent()
		}
		// A sign-in prompt has to be visible or the flow cannot proceed, so it
		// takes over the settings panel and returns there when answered.
		if m.authFlow != "" && m.overlay != nil && m.overlay.kind == overlaySettings &&
			!isAskUserSelect(request) {
			previous := m.overlay
			m.openExtensionOverlay(request)
			if m.overlay != nil && m.overlay.requestID != "" {
				m.overlay.returnTo = previous
			}
			return m, m.waitEvent()
		}
		m.dialogs = append(m.dialogs, request)
	}
	return m, m.waitEvent()
}

func (m *Model) openExtensionOverlay(request *rpc.ExtensionUIRequestEvent) {
	var overlay *overlay
	switch request.Method {
	case "select":
		if isAskUserSelect(request) {
			// ask_user is not a dialog: it stays inline above the composer so the
			// conversation the question refers to keeps its space.
			m.openAsk(request)
			return
		}
		overlay = newSelectOverlay(request)
	case "confirm":
		overlay = newConfirmOverlay(request)
	case "input":
		overlay = newInputOverlay(request)
	case "editor":
		overlay = newEditorOverlay(request)
	default:
		return
	}
	m.openOverlay(overlay)
}

func (m *Model) openOverlay(o *overlay) {
	if m.transcript != nil {
		m.transcript.ClearSelection()
	}
	if m.composer != nil {
		m.composer.ClearSelection()
	}
	m.overlay = o
	o.Resize(m.frameWidth(), m.body)
	m.completion.Hide()
	m.layout()
}

func (m *Model) closeOverlay() {
	// A picker opened from a settings panel goes back to it, so signing in
	// from the panel returns where the user was. A queued dialog wins: it is
	// waiting for the user and must not stay hidden.
	if m.overlay != nil && m.overlay.returnTo != nil && len(m.dialogs) == 0 {
		previous := m.overlay.returnTo
		m.overlay.returnTo = nil
		m.openOverlay(previous)
		return
	}
	m.overlay = nil
	m.layout()
	// A sign-in step that arrived behind a dialog is shown now.
	if m.showPendingAuthStep() {
		return
	}
	m.openQueuedDialog()
}

// showPendingAuthStep opens a sign-in step that arrived behind a dialog.
func (m *Model) showPendingAuthStep() bool {
	if m.pendingAuthStep == nil {
		return false
	}
	step := m.pendingAuthStep
	m.pendingAuthStep = nil
	m.openOverlay(step)
	return true
}

// openQueuedDialog shows the extension UI request waiting behind the current
// dialog or question, if any.
func (m *Model) openQueuedDialog() {
	if len(m.dialogs) == 0 {
		return
	}
	next := m.dialogs[0]
	m.dialogs = m.dialogs[1:]
	m.openExtensionOverlay(next)
}

// handleOverlayKey routes keys while a modal is open.
func (m *Model) handleOverlayKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.overlay.kind == overlaySettings {
		return m.handleSettingsKey(msg)
	}
	key := msg.String()
	o := m.overlay

	if o.kind == overlayAuth {
		switch key {
		case "ctrl+c":
			return m, tea.Quit
		case "esc", "q":
			m.closeOverlay()
		case "o", "enter":
			return m, m.openAuthURL()
		case "c":
			return m, m.copyAuthValue()
		case "ctrl+x":
			m.setToast("cancelling the sign-in…")
			return m, m.cancelProviderLogin(o.authProvider)
		}
		return m, nil
	}

	// A pending delete only survives until the next key press, so confirming
	// really is two ctrl+d presses with nothing in between.
	if o.sessionPicker() && key != "ctrl+d" && o.deleteArm != "" {
		o.disarmDelete()
	}

	switch key {
	case "esc":
		if o.requestID != "" {
			id := o.requestID
			client := m.client
			m.closeOverlay()
			return m, func() tea.Msg {
				_ = client.Send(rpc.ExtensionUICancelled(id))
				return nil
			}
		}
		if o.action == "settings-choice" || o.action == "settings-agents" {
			m.pendingSettingsRow = nil
			m.openSettingsOverlay()
			return m, nil
		}
		m.closeOverlay()
		return m, nil

	case "up", "ctrl+p", "shift+tab":
		if o.kind == overlayPicker || o.kind == overlaySelect {
			o.move(-1)
			return m, nil
		}
	case "down", "ctrl+n", "tab":
		if o.kind == overlayPicker || o.kind == overlaySelect {
			o.move(1)
			return m, nil
		}

	case "enter":
		switch o.kind {
		case overlayPicker, overlaySelect:
			return m, m.selectOverlayItem()
		case overlayConfirm:
			return m, m.answerConfirm(true)
		case overlayInput:
			return m, m.answerInput(o.filter.Value())
		}

	case "y":
		if o.kind == overlayConfirm {
			return m, m.answerConfirm(true)
		}
	case "n":
		if o.kind == overlayConfirm {
			return m, m.answerConfirm(false)
		}

	case "ctrl+s", "alt+s":
		if o.kind == overlayEditor {
			return m, m.answerInput(o.editor.Value())
		}

	case "ctrl+d":
		// The first press only arms the row; the second deletes it.
		if o.sessionPicker() {
			return m, m.deleteSelectedSession()
		}

	case "ctrl+c":
		return m, tea.Quit
	}

	return m, o.Update(msg)
}

func (m *Model) selectOverlayItem() tea.Cmd {
	o := m.overlay
	item, ok := o.selected()
	if !ok {
		return nil
	}

	switch o.kind {
	case overlaySelect:
		id := o.requestID
		client := m.client
		value := item.Value
		m.closeOverlay()
		return func() tea.Msg {
			_ = client.Send(rpc.ExtensionUIValue(id, value))
			return nil
		}

	case overlayPicker:
		action := o.action
		switch action {
		case "model":
			m.closeOverlay()
			return m.setModelByLabel(item.Value)
		case "session":
			if item.Value == sessionAllValue {
				m.closeOverlay()
				m.sessionsAll = true
				return m.listSessions()
			}
			m.closeOverlay()
			m.sessionsAll = false
			m.transcript.Clear()
			return m.switchSession(item.Value)
		case "help":
			m.closeOverlay()
			return nil
		case "session-name":
			m.closeOverlay()
			return m.setSessionName(item.Value)
		case "settings-choice":
			m.closeOverlay()
			return m.applySettingChoice(item.Value)
		case "preset":
			m.closeOverlay()
			return m.applyPreset(item.Value)
		case "project":
			m.closeOverlay()
			if item.Value == projectBrowseValue {
				start := m.opts.CWD
				if m.prefs != nil {
					if last := m.prefs.LastCWD(); last != "" {
						start = last
					}
				}
				return m.openDirectoryPicker(start)
			}
			return m.switchProject(item.Value)
		case "palette":
			return m.runPaletteItem(item.Value)
		case "login":
			m.closeOverlay()
			providerID, authType, _ := strings.Cut(item.Value, "|")
			return m.startProviderLogin(providerID, authType)
		case "logout":
			m.closeOverlay()
			return m.startProviderLogout(item.Value)
		case "fork":
			m.closeOverlay()
			return m.forkSession(item.Value)
		case "session-search-hit":
			m.closeOverlay()
			m.sessionsAll = false
			m.transcript.Clear()
			return m.switchSession(item.Value)
		case "cwd-browse":
			return m.browseTo(item.Value)
		case "skill-search-results":
			m.closeOverlay()
			m.setToast("installing " + item.Value + "…")
			return m.installSkill(item.Value)
		default:
			m.closeOverlay()
			return nil
		}
	}
	return nil
}

func (m *Model) answerConfirm(confirmed bool) tea.Cmd {
	id := m.overlay.requestID
	client := m.client
	m.closeOverlay()
	return func() tea.Msg {
		_ = client.Send(rpc.ExtensionUIConfirmed(id, confirmed))
		return nil
	}
}

func (m *Model) answerInput(value string) tea.Cmd {
	o := m.overlay
	id := o.requestID
	action := o.action
	client := m.client
	m.closeOverlay()

	if action == "session-name" {
		return m.setSessionName(value)
	}
	if action == "session-search" {
		return m.searchSessions(value)
	}
	if action == "skill-search" {
		m.setToast("searching skills.sh…")
		return m.searchSkills(value)
	}
	if action == "skill-install-source" {
		m.setToast("installing " + value + "…")
		return m.installSkill(value)
	}
	if action == "plugin-install-global" {
		return m.installPackage(value, true)
	}
	if action == "plugin-install-project" {
		return m.installPackage(value, false)
	}
	if action == "mcp-add-global" {
		return m.addMCP(value, false)
	}
	if action == "mcp-add-local" {
		return m.addMCP(value, true)
	}
	if action == "settings-agents" {
		if err := config.WriteInstructions(m.paths, value); err != nil {
			if m.settingsPanel != nil {
				m.settingsPanel.err = "save AGENTS.md: " + err.Error()
			}
		} else if m.settingsPanel != nil {
			m.settingsPanel.notice = "instructions saved"
		}
		m.openSettingsOverlay()
		if m.bridgeReady {
			return m.reloadPi()
		}
		return nil
	}
	return func() tea.Msg {
		_ = client.Send(rpc.ExtensionUIValue(id, value))
		return nil
	}
}

// addNotice appends an informational block.
func (m *Model) addNotice(text string) {
	m.transcript.Add(newBlock(blockNotice, text))
	m.followOutput()
}

// followOutput scrolls to the newest line only when the user is already at the
// bottom, so tool output never yanks the transcript away mid-scroll.
func (m *Model) followOutput() {
	if m.transcript.stickBottom {
		m.transcript.ScrollToBottom()
	}
}

// addError appends an error block and keeps it visible.
func (m *Model) addError(text string) {
	if strings.TrimSpace(text) == "" {
		return
	}
	m.transcript.Add(newBlock(blockError, text))
	m.transcript.ScrollToBottom()
}

func mustJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return encoded
}

func messageThinking(message rpc.Message) string {
	var out strings.Builder
	for _, block := range message.Content {
		if block.Type == "thinking" && block.Thinking != "" {
			out.WriteString(block.Thinking)
		}
	}
	return out.String()
}

// toolResultText extracts readable text from a tool result payload.
func toolResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var payload struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ""
	}
	if payload.Text != "" {
		return payload.Text
	}
	var parts []string
	for _, item := range payload.Content {
		if item.Type == "text" && item.Text != "" {
			parts = append(parts, item.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func onOff(value bool) string {
	if value {
		return "shown"
	}
	return "hidden"
}

func formatDuration(d time.Duration) string {
	if d <= 0 {
		return ""
	}
	if d < time.Second {
		return fmt.Sprintf("%dms", d.Milliseconds())
	}
	return fmt.Sprintf("%.1fs", d.Seconds())
}
