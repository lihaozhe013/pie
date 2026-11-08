package ui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

// askUserOtherLabel is the sentinel the bridge appends to ask_user selects.
// The TUI strips it and renders its own answer field; other hosts keep the
// select -> input fallback. Keep it in sync with pie-bridge.ts and the web
// client's label.
const askUserOtherLabel = "Write my own answer…"

// isAskUserSelect reports whether a select dialog is an ask_user question.
func isAskUserSelect(request *rpc.ExtensionUIRequestEvent) bool {
	if request.Method != "select" || len(request.Options) == 0 {
		return false
	}
	return request.Options[len(request.Options)-1] == askUserOtherLabel
}

// newAskOverlay builds the question panel: the question, its options, and one
// text field that accepts a typed answer in the same response.
func newAskOverlay(request *rpc.ExtensionUIRequestEvent) *overlay {
	options := request.Options
	if len(options) > 0 && options[len(options)-1] == askUserOtherLabel {
		options = options[:len(options)-1]
	}
	items := make([]pickerItem, 0, len(options))
	for i, option := range options {
		items = append(items, pickerItem{Value: option, Label: option, Detail: fmt.Sprintf("%d", i+1)})
	}

	input := textinput.New()
	input.Placeholder = "type an answer"
	input.Prompt = "answer › "
	input.CharLimit = 4000
	input.Focus()

	return &overlay{
		kind:      overlayAsk,
		action:    "extension-ask",
		title:     "Question",
		message:   request.Title,
		items:     items,
		filtered:  items,
		filter:    input,
		requestID: request.ID,
	}
}

// answerAsk submits the typed answer, or the highlighted option when the field
// is empty. Typing and choosing share one response so the agent can answer
// without the extra select -> input step other hosts use.
func (m *Model) answerAsk() tea.Cmd {
	o := m.overlay
	if raw := o.filter.Value(); raw != "" {
		answer := strings.TrimSpace(raw)
		if answer == "" {
			return nil
		}
		return m.answerInput(answer)
	}
	if item, ok := o.selected(); ok {
		return m.answerInput(item.Value)
	}
	return nil
}

// renderAsk draws the question, the option rows, and the answer field.
func (o *overlay) renderAsk(body *strings.Builder, st styles) {
	if o.message != "" {
		body.WriteString(st.pickerItem.Render(wrapCapped(o.message, maxInt(20, o.width-4), 10)))
		body.WriteString("\n\n")
	}

	if len(o.items) > 0 {
		start := 0
		if o.cursor >= maxPickerRows {
			start = o.cursor - maxPickerRows + 1
		}
		end := start + maxPickerRows
		if end > len(o.items) {
			end = len(o.items)
		}
		for i := start; i < end; i++ {
			item := o.items[i]
			label := item.Label
			if label == "" {
				label = item.Value
			}
			var line string
			if o.filter.Value() == "" && i == o.cursor {
				line = st.pickerSel.Render("\u203a "+label) + "  " + st.overlayHint.Render(item.Detail)
			} else {
				line = "  " + st.pickerItem.Render(label) + "  " + st.overlayHint.Render(item.Detail)
			}
			body.WriteString(truncateLine(line, o.width-4))
			body.WriteString("\n")
		}
		body.WriteString("\n")
	}

	body.WriteString(o.filter.View())
	body.WriteString("\n\n")
	hint := "type an answer or \u2191/\u2193 choose \u00b7 enter send \u00b7 esc dismiss"
	if len(o.items) == 0 {
		hint = "type an answer \u00b7 enter send \u00b7 esc dismiss"
	}
	body.WriteString(st.overlayHint.Render(hint))
}
