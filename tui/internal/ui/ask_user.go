package ui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

// askUserOtherLabel is the sentinel the bridge appends to ask_user selects.
// The TUI strips it and keeps the composer as the free-form answer; other hosts
// keep the select -> input fallback. Keep it in sync with pie-bridge.ts and the
// web client's label.
const askUserOtherLabel = "Write my own answer…"

const (
	// askMaxQuestionLines caps a long question so it cannot crowd out the
	// conversation the question is about.
	askMaxQuestionLines = 3
	// askMaxOptionRows matches the six options ask_user accepts.
	askMaxOptionRows = 6
	// askMinBodyRows is the transcript height reserved above the question.
	askMinBodyRows = 3
	// askAnswerPlaceholder replaces the prompt placeholder while a question
	// waits, so the prompt reads as the "write my own answer" choice.
	askAnswerPlaceholder = "type your own answer…"
)

// isAskUserSelect reports whether a select dialog is an ask_user question.
func isAskUserSelect(request *rpc.ExtensionUIRequestEvent) bool {
	if request.Method != "select" || len(request.Options) == 0 {
		return false
	}
	return request.Options[len(request.Options)-1] == askUserOtherLabel
}

// askPanel is an ask_user question rendered between the transcript and the
// composer. A full-screen modal hid the conversation the question refers to, so
// the question and its options sit inline and the composer below them answers
// with free-form text: choosing an option and typing an answer reply in one
// step.
type askPanel struct {
	requestID string
	question  string
	options   []string
	cursor    int
	// draft is the prompt text stashed when the question took the composer
	// over. It comes back when the question closes.
	draft string
	// lines is the rendered option block. layout reserves its rows and View
	// appends it, so both read the same slice.
	lines []string
	start int // first visible option
}

func newAskPanel(request *rpc.ExtensionUIRequestEvent) *askPanel {
	options := make([]string, 0, len(request.Options))
	for _, option := range request.Options {
		if option == askUserOtherLabel {
			continue
		}
		options = append(options, option)
	}
	return &askPanel{
		requestID: request.ID,
		question:  request.Title,
		options:   options,
	}
}

// openAsk gives an ask_user question the composer: the transcript stays
// readable above the options, and the prompt below becomes the answer field.
func (m *Model) openAsk(request *rpc.ExtensionUIRequestEvent) {
	if m.ask != nil {
		// One question at a time: a second one waits at the head of the queue
		// instead of replacing the open question and leaving it unanswered.
		m.dialogs = append([]*rpc.ExtensionUIRequestEvent{request}, m.dialogs...)
		return
	}

	m.dismissSplash()
	if m.transcript != nil {
		m.transcript.ClearSelection()
	}

	panel := newAskPanel(request)
	if m.composer != nil {
		m.composer.ClearSelection()
		// What the user was drafting is not an answer to this question.
		panel.draft = m.composer.Value()
		m.composer.Reset()
		m.composer.SetPlaceholder(askAnswerPlaceholder)
	}
	m.ask = panel
	m.completion.Hide()
	m.layout()
}

// closeAsk drops the inline question and gives the prompt back to the user.
func (m *Model) closeAsk() {
	if m.ask == nil {
		return
	}
	draft := m.ask.draft
	m.ask = nil
	if m.composer != nil {
		m.composer.SetPlaceholder(composerPlaceholder)
		m.composer.SetText(draft)
		m.completion.Refresh(m.composer.Value())
	}
	m.layout()
	if m.showPendingAuthStep() {
		return
	}
	m.openQueuedDialog()
}

// submitAsk answers with the typed text when there is any, else with the
// highlighted option.
func (m *Model) submitAsk() tea.Cmd {
	if m.ask == nil {
		return nil
	}
	answer := strings.TrimSpace(m.composer.Value())
	if answer == "" {
		if len(m.ask.options) == 0 {
			return nil
		}
		answer = m.ask.options[m.ask.cursor]
	}
	id := m.ask.requestID
	client := m.client
	m.closeAsk()
	return func() tea.Msg {
		_ = client.Send(rpc.ExtensionUIValue(id, answer))
		return nil
	}
}

// cancelAsk dismisses the question without answering. The agent treats a
// dismissal as "decide without me", never as agreement.
func (m *Model) cancelAsk() tea.Cmd {
	if m.ask == nil {
		return nil
	}
	id := m.ask.requestID
	client := m.client
	m.closeAsk()
	return func() tea.Msg {
		_ = client.Send(rpc.ExtensionUICancelled(id))
		return nil
	}
}

// handleAskKey routes one key press while a question waits. The options only
// take the arrows while the composer is empty, so the prompt keeps its normal
// caret movement once the user types.
func (m *Model) handleAskKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	options := len(m.ask.options) > 0
	empty := m.composer.Empty()

	switch {
	case key == "ctrl+c":
		return m, tea.Quit
	case key == "esc":
		return m, m.cancelAsk()
	case key == "enter" || key == "alt+enter":
		// A question answer is a single line, so both the enter and alt+enter
		// send chords submit it.
		return m, m.submitAsk()
	case options && empty && (key == "up" || key == "shift+tab" || key == "ctrl+p"):
		m.moveAsk(-1)
		return m, nil
	case options && empty && (key == "down" || key == "tab" || key == "ctrl+n"):
		m.moveAsk(1)
		return m, nil
	case key == "pgup" || key == "pgdown" || key == "ctrl+u":
		return m, m.transcript.Update(msg)
	}

	beforeHeight := m.composer.Height()
	cmd := m.composer.Update(msg)
	// The highlight follows the answer field, and the block height follows the
	// prompt, so either change needs a new frame.
	if m.composer.Height() != beforeHeight || m.composer.Empty() != empty {
		m.layout()
	}
	return m, cmd
}

// moveAsk walks the option rows, wrapping at both ends.
func (m *Model) moveAsk(delta int) {
	n := len(m.ask.options)
	if n == 0 {
		return
	}
	m.ask.cursor = (m.ask.cursor + delta + n) % n
	m.layout()
}

// resizeAsk rebuilds the question block for the current frame.
func (m *Model) resizeAsk() {
	if m.ask == nil {
		return
	}
	m.ask.lines = m.buildAskLines()
}

// buildAskLines renders the question and the visible option rows. The rows come
// out of the transcript first: even a short terminal keeps the conversation the
// question refers to on screen.
func (m *Model) buildAskLines() []string {
	ask := m.ask
	width := m.frameWidth()
	if ask == nil || width <= 0 {
		return nil
	}

	lines := make([]string, 0, askMaxQuestionLines+askMaxOptionRows+1)
	if question := strings.TrimSpace(ask.question); question != "" {
		wrapped := strings.Split(wrapPlain(question, maxInt(20, width-4)), "\n")
		if len(wrapped) > askMaxQuestionLines {
			wrapped = wrapped[:askMaxQuestionLines]
			wrapped[len(wrapped)-1] += " …"
		}
		for i, line := range wrapped {
			prefix := "  "
			if i == 0 {
				prefix = m.styles.accent.Render("? ")
			}
			lines = append(lines, truncateLine(prefix+m.styles.pickerItem.Render(line), width))
		}
		if len(ask.options) > 0 {
			lines = append(lines, "")
		}
	}

	// The option rows are the first thing a short terminal gives up, because
	// the typed answer stays available from the composer either way.
	budget := m.height - 1 - m.activityRows() - (m.composer.Height() + 3) - askMinBodyRows
	rows := minInt(len(ask.options), askMaxOptionRows)
	if budget > len(lines) {
		rows = minInt(rows, budget-len(lines))
	} else {
		rows = 0
	}
	if rows > 0 {
		start := ask.start
		if ask.cursor < start {
			start = ask.cursor
		}
		if ask.cursor >= start+rows {
			start = ask.cursor - rows + 1
		}
		if limit := len(ask.options) - rows; start > limit {
			start = maxInt(0, limit)
		}
		ask.start = start
		highlight := m.composer.Empty()
		for i := start; i < start+rows; i++ {
			number := fmt.Sprintf("%d.", i+1)
			var line string
			if i == ask.cursor && highlight {
				line = "  " + m.styles.pickerSel.Render("› "+number) + " " +
					m.styles.pickerSel.Render(ask.options[i])
			} else {
				line = "    " + m.styles.faint.Render(number) + " " +
					m.styles.pickerItem.Render(ask.options[i])
			}
			lines = append(lines, truncateLine(line, width))
		}
	}
	return lines
}
