package ui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

// overlayKind selects the widget a modal draws.
type overlayKind int

const (
	overlayPicker overlayKind = iota
	overlaySelect
	overlayAsk
	overlayConfirm
	overlayInput
	overlayEditor
	overlaySettings
	overlayAuth
)

// pickerItem is one selectable row.
type pickerItem struct {
	Value  string
	Label  string
	Detail string
}

// overlay is a modal drawn over the transcript area.
type overlay struct {
	kind    overlayKind
	action  string
	title   string
	message string

	items    []pickerItem
	filtered []pickerItem
	cursor   int

	filter textinput.Model
	editor textarea.Model

	requestID string
	width     int
	height    int
	settings  *settingsState

	// authProvider, authURL, and authCode carry one provider sign-in step:
	// the authorization page to open, and the device code to type into it.
	authProvider string
	authURL      string
	authCode     string

	// returnTo is the overlay this one was opened from, restored on close.
	returnTo *overlay

	// deleteArm is the session row the first ctrl+d selected, and deleteArmAt
	// when it happened. A second press on the same row inside
	// sessionDeleteWindow deletes it, so one stray chord cannot remove a
	// conversation.
	deleteArm   string
	deleteArmAt time.Time
}

const maxPickerRows = 10

func newPickerOverlay(action, title string, items []pickerItem) *overlay {
	filter := textinput.New()
	filter.Placeholder = "filter"
	filter.Prompt = "/ "
	filter.CharLimit = 120
	filter.Focus()

	o := &overlay{
		kind:   overlayPicker,
		action: action,
		title:  title,
		items:  items,
		filter: filter,
	}
	o.refilter()
	return o
}

func newSelectOverlay(request *rpc.ExtensionUIRequestEvent) *overlay {
	items := make([]pickerItem, 0, len(request.Options))
	for i, option := range request.Options {
		items = append(items, pickerItem{Value: option, Label: option, Detail: fmt.Sprintf("%d", i+1)})
	}
	o := newPickerOverlay("extension-select", request.Title, items)
	o.kind = overlaySelect
	o.requestID = request.ID
	o.message = withTimeout(request.Message, request.Timeout)
	o.filter.Blur()
	return o
}

func newConfirmOverlay(request *rpc.ExtensionUIRequestEvent) *overlay {
	return &overlay{
		kind:      overlayConfirm,
		action:    "extension-confirm",
		title:     request.Title,
		message:   withTimeout(request.Message, request.Timeout),
		requestID: request.ID,
	}
}

func newInputOverlay(request *rpc.ExtensionUIRequestEvent) *overlay {
	input := textinput.New()
	input.Placeholder = request.Placeholder
	input.Focus()
	input.CharLimit = 4000

	return &overlay{
		kind:      overlayInput,
		action:    "extension-input",
		title:     request.Title,
		message:   withTimeout(request.Message, request.Timeout),
		requestID: request.ID,
		filter:    input,
	}
}

func newEditorOverlay(request *rpc.ExtensionUIRequestEvent) *overlay {
	editor := textarea.New()
	editor.SetValue(request.Prefill)
	editor.SetHeight(8)
	editor.ShowLineNumbers = false
	editor.Prompt = ""
	// The widget's default cursor line paints a solid background across the
	// whole line, which fights the modal's palette.
	editor.FocusedStyle.CursorLine = lipgloss.NewStyle()
	editor.Focus()

	return &overlay{
		kind:      overlayEditor,
		action:    "extension-editor",
		title:     request.Title,
		message:   withTimeout(request.Message, request.Timeout),
		requestID: request.ID,
		editor:    editor,
	}
}

// withTimeout appends the auto-resolve deadline pi reported, if any.
func withTimeout(message string, timeoutMs int) string {
	if timeoutMs <= 0 {
		return message
	}
	hint := fmt.Sprintf("expires in %ds", timeoutMs/1000)
	if message == "" {
		return hint
	}
	return message + "\n\n" + hint
}

func (o *overlay) refilter() {
	query := strings.ToLower(strings.TrimSpace(o.filter.Value()))
	o.filtered = o.filtered[:0]
	for _, item := range o.items {
		haystack := strings.ToLower(item.Label + " " + item.Detail)
		if query == "" || strings.Contains(haystack, query) {
			o.filtered = append(o.filtered, item)
		}
	}
	if o.cursor >= len(o.filtered) {
		o.cursor = maxInt(0, len(o.filtered)-1)
	}
}

func (o *overlay) move(delta int) {
	if len(o.filtered) == 0 {
		return
	}
	o.cursor = (o.cursor + delta + len(o.filtered)) % len(o.filtered)
}

func (o *overlay) selected() (pickerItem, bool) {
	if len(o.filtered) == 0 || o.cursor >= len(o.filtered) {
		return pickerItem{}, false
	}
	return o.filtered[o.cursor], true
}

// sessionPicker reports whether the rows are resumable sessions, which are the
// pickers that accept ctrl+d deletion.
func (o *overlay) sessionPicker() bool {
	return o.kind == overlayPicker && (o.action == "session" || o.action == "session-search-hit")
}

// deleteArmedNow reports whether a second ctrl+d on value may delete it.
func (o *overlay) deleteArmedNow(value string) bool {
	return o.deleteArm != "" && o.deleteArm == value && time.Since(o.deleteArmAt) < sessionDeleteWindow
}

func (o *overlay) disarmDelete() {
	o.deleteArm = ""
	o.deleteArmAt = time.Time{}
}

// dropItem removes one row and leaves the cursor on the row that followed it.
// It reports whether the row was still present, so a late deletion message
// cannot disturb a picker the user already replaced.
func (o *overlay) dropItem(value string) bool {
	for i, item := range o.items {
		if item.Value != value {
			continue
		}
		o.items = append(o.items[:i], o.items[i+1:]...)
		o.refilter()
		return true
	}
	return false
}

// Update forwards typing to the overlay's input widget.
func (o *overlay) Update(msg tea.Msg) tea.Cmd {
	switch o.kind {
	case overlayPicker, overlayInput, overlayAsk:
		var cmd tea.Cmd
		o.filter, cmd = o.filter.Update(msg)
		if o.kind == overlayPicker {
			o.refilter()
		}
		return cmd
	case overlayEditor:
		var cmd tea.Cmd
		o.editor, cmd = o.editor.Update(msg)
		return cmd
	default:
		return nil
	}
}

// Resize sizes the modal to the available area.
func (o *overlay) Resize(width, height int) {
	boxWidth := width - 8
	maxWidth := 72
	if o.kind == overlaySettings {
		maxWidth = 96
	}
	if boxWidth > maxWidth {
		boxWidth = maxWidth
	}
	if boxWidth < 24 {
		boxWidth = 24
	}
	o.width = boxWidth
	o.height = height
	if o.kind == overlayPicker || o.kind == overlayInput || o.kind == overlayAsk {
		o.filter.Width = boxWidth - 8
	}
	if o.kind == overlayEditor {
		o.editor.SetWidth(boxWidth - 8)
	}
}

// View renders the modal box.
func (o *overlay) View(st styles) string {
	if o.kind == overlaySettings {
		if o.settings == nil {
			return st.overlayBox.Render("settings unavailable")
		}
		return o.settings.View(st, o.width+8, o.height)
	}

	var body strings.Builder

	switch o.kind {
	case overlayPicker, overlaySelect:
		o.renderPicker(&body, st)
	case overlayAsk:
		o.renderAsk(&body, st)
	case overlayConfirm:
		if o.message != "" {
			body.WriteString(o.message)
			body.WriteString("\n\n")
		}
		body.WriteString(st.overlayHint.Render("enter or y to confirm · esc or n to cancel"))
	case overlayInput:
		if o.message != "" {
			body.WriteString(o.message)
			body.WriteString("\n\n")
		}
		body.WriteString(o.filter.View())
		body.WriteString("\n\n")
		body.WriteString(st.overlayHint.Render("enter to submit · esc to cancel"))
	case overlayAuth:
		o.renderAuth(&body, st)
	case overlayEditor:
		if o.message != "" {
			body.WriteString(o.message)
			body.WriteString("\n\n")
		}
		body.WriteString(o.editor.View())
		body.WriteString("\n")
		body.WriteString(st.overlayHint.Render("ctrl+s to submit · esc to cancel"))
	}

	title := st.overlayHead.Render(wrapCapped(o.title, maxInt(20, o.width-6), 6))
	box := st.overlayBox.Copy().Width(o.width).Render(title + "\n\n" + body.String())
	return box
}

// wrapCapped is wrapPlain with a line budget, so a long URL cannot push an
// overlay past the transcript area.
func wrapCapped(text string, width, maxLines int) string {
	lines := strings.Split(wrapPlain(text, width), "\n")
	if maxLines <= 0 || len(lines) <= maxLines {
		return strings.Join(lines, "\n")
	}
	lines = lines[:maxLines]
	lines[maxLines-1] += " …"
	return strings.Join(lines, "\n")
}

func (o *overlay) renderAuth(body *strings.Builder, st styles) {
	if o.message != "" {
		body.WriteString(st.muted.Render(wrapCapped(o.message, maxInt(20, o.width-6), 4)))
		body.WriteString("\n\n")
	}
	if o.authCode != "" {
		body.WriteString(st.overlayHint.Render("code"))
		body.WriteString("\n")
		body.WriteString(st.accent.Render(o.authCode))
		body.WriteString("\n\n")
	}
	if o.authURL != "" {
		body.WriteString(st.overlayHint.Render("url"))
		body.WriteString("\n")
		body.WriteString(wrapCapped(o.authURL, maxInt(20, o.width-6), 6))
		body.WriteString("\n\n")
	}
	hints := make([]string, 0, 3)
	if o.authURL != "" {
		hints = append(hints, "o open in browser")
		if o.authCode != "" {
			hints = append(hints, "c copy code")
		} else {
			hints = append(hints, "c copy url")
		}
	}
	hints = append(hints, "esc hide · sign-in continues", "ctrl+x cancel")
	body.WriteString(st.overlayHint.Render(strings.Join(hints, " · ")))
}

func (o *overlay) renderPicker(body *strings.Builder, st styles) {
	if o.kind == overlayPicker {
		body.WriteString(o.filter.View())
		body.WriteString("\n\n")
	}
	if len(o.filtered) == 0 {
		body.WriteString(st.overlayHint.Render("no matches"))
		return
	}

	start := 0
	if o.cursor >= maxPickerRows {
		start = o.cursor - maxPickerRows + 1
	}
	end := start + maxPickerRows
	if end > len(o.filtered) {
		end = len(o.filtered)
	}

	for i := start; i < end; i++ {
		item := o.filtered[i]
		label := item.Label
		if label == "" {
			label = item.Value
		}
		var line string
		if i == o.cursor {
			line = st.pickerSel.Render("\u203a "+label) + "  " + st.overlayHint.Render(item.Detail)
		} else {
			line = "  " + st.pickerItem.Render(label) + "  " + st.overlayHint.Render(item.Detail)
		}
		// Truncate before lipgloss pads the box: an overlong row would widen
		// the border and break the frame width on small terminals.
		body.WriteString(truncateLine(line, o.width-4))
		if i != end-1 {
			body.WriteString("\n")
		}
	}

	body.WriteString("\n\n")
	hint := "enter to select \u00b7 esc to cancel \u00b7 \u2191/\u2193 to move"
	if o.action == "palette" {
		hint = "enter to run \u00b7 esc to cancel \u00b7 \u2191/\u2193 to move"
	}
	if o.sessionPicker() {
		armed := false
		if item, ok := o.selected(); ok {
			armed = o.deleteArmedNow(item.Value)
		}
		if armed {
			hint = "ctrl+d again to delete \u00b7 esc to cancel"
		} else {
			hint = "enter to resume \u00b7 ctrl+d twice to delete \u00b7 esc to cancel"
		}
	}
	body.WriteString(st.overlayHint.Render(hint))
}
