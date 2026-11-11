package ui

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

// activityPhase is the broad state of the current run. It is what the activity
// bar names while no tool is executing.
type activityPhase int

const (
	activityIdle activityPhase = iota
	activityWaiting
	activityThinking
	activityStreaming
	activityPreparingTool
	activityRunningTools
)

// activityTool is one tool call currently executing. The bar keeps the decoded
// arguments for the label and the raw JSON for the token estimate.
type activityTool struct {
	callID string
	name   string
	args   map[string]any
	input  string
}

// activityStreamBlock is one content block of the assistant message being
// written right now. It mirrors the GUI's per-message streaming store, so the
// estimate and the token rate never read another message's leftovers.
type activityStreamBlock struct {
	kind string // "text", "thinking" or "toolCall"
	text string // block text, or the raw arguments of a tool call
}

// activityState is the live run status shown in the single row above the
// composer. It lives outside the transcript, so a long run remains visible
// while the user scrolls history.
type activityState struct {
	phase      activityPhase
	startedAt  time.Time
	tools      []activityTool
	draftTool  string
	compacting bool
	retry      string
	stream     map[int]*activityStreamBlock
	rateAt     time.Time
	rateTokens float64
}

// begin starts a new run's clock and clears the state of the previous one.
func (a *activityState) begin() {
	*a = activityState{
		phase:     activityWaiting,
		startedAt: time.Now(),
	}
}

// reset folds the bar away when no run is active.
func (a *activityState) reset() { *a = activityState{} }

// beginMessage starts a fresh assistant message's estimate state. The GUI
// anchors the token rate per reply, and stale blocks must not outlive theirs.
func (a *activityState) beginMessage() {
	a.stream = nil
	a.rateAt = time.Time{}
	a.rateTokens = 0
}

func (a *activityState) ensureStarted() {
	if a.startedAt.IsZero() {
		a.startedAt = time.Now()
	}
}

func (a *activityState) addTool(callID, name string, args map[string]any, input string) {
	a.tools = append(a.tools, activityTool{callID: callID, name: name, args: args, input: input})
	a.phase = activityRunningTools
	a.draftTool = ""
	a.ensureStarted()
}

// removeTool reports whether a call was running, so ending an unknown call
// cannot move the phase on its own.
func (a *activityState) removeTool(callID string) bool {
	for i, tool := range a.tools {
		if tool.callID != callID {
			continue
		}
		a.tools = append(a.tools[:i], a.tools[i+1:]...)
		if len(a.tools) == 0 && a.phase == activityRunningTools {
			a.phase = activityWaiting
		}
		return true
	}
	return false
}

// applyDelta folds one streaming assistant delta into the current message's
// blocks, the way the GUI's streaming store does for its composer row.
func (a *activityState) applyDelta(event rpc.AssistantMessageEvent) {
	kind := ""
	switch {
	case strings.HasPrefix(event.Type, "text_"):
		kind = "text"
	case strings.HasPrefix(event.Type, "thinking_"):
		kind = "thinking"
	case strings.HasPrefix(event.Type, "toolcall_"):
		kind = "toolCall"
	default:
		return
	}
	if a.stream == nil {
		a.stream = make(map[int]*activityStreamBlock, 2)
	}
	block := a.stream[event.ContentIndex]
	if block == nil {
		block = &activityStreamBlock{kind: kind}
		a.stream[event.ContentIndex] = block
	}
	switch event.Type {
	case "text_start", "thinking_start", "toolcall_start":
		block.kind = kind
	case "text_delta", "thinking_delta", "toolcall_delta":
		block.text += event.Delta
	case "text_end", "thinking_end":
		if event.Content != "" {
			block.text = event.Content
		}
	case "toolcall_end":
		if event.ToolCall != nil && len(event.ToolCall.Arguments) > 0 {
			block.text = string(event.ToolCall.Arguments)
		}
	}
}

// lastStreamBlock is the block the model is writing right now, ordered the
// way the accumulator orders content.
func (a *activityState) lastStreamBlock() *activityStreamBlock {
	var last *activityStreamBlock
	lastIndex := -1
	for index, block := range a.stream {
		if index > lastIndex {
			lastIndex, last = index, block
		}
	}
	return last
}

// streamTokens is the whole current message's estimate: the number the rate
// divides, never shown on its own.
func (a *activityState) streamTokens() float64 {
	var total float64
	for _, block := range a.stream {
		total += estimateTokens(block.text)
	}
	return total
}

// activityActive reports whether the animation needs a tick. It follows the
// row rather than busy alone: a manual compaction and a retry run without a
// prompt, and both still need the marker to blink.
func (m *Model) activityActive() bool { return m.activityRows() > 0 }

// activityRows is the space the bar reserves in the frame. The row folds away
// when no run is active, mirroring the collapsible status slot of the desktop
// client. While a run is active the slot stays open even when its content is
// hidden — the GUI keeps its row height through a plain text stream so the
// composer never moves.
func (m *Model) activityRows() int {
	if m.activityLabel() != "" {
		return 1
	}
	if m.busy {
		return 1
	}
	return 0
}

// activityLabel is the single sentence the bar shows for the current run. The
// wording mirrors the GUI's composer-activity labels.
func (m *Model) activityLabel() string {
	a := &m.activity
	switch {
	case a.compacting:
		return "Compacting context…"
	case a.retry != "":
		return a.retry
	case len(a.tools) > 0:
		return activityToolsLabel(a.tools)
	case a.draftTool != "":
		return "Preparing " + a.draftTool + "…"
	case a.phase == activityPreparingTool:
		// The call's name has not arrived yet; the GUI names the wait here.
		return "Waiting for provider…"
	case a.phase == activityThinking:
		return "Thinking…"
	case a.phase == activityWaiting:
		return "Waiting for provider…"
	default:
		// The GUI hides the row's content while the model writes plain text;
		// the slot stays reserved so the composer never moves.
		return ""
	}
}

// renderActivity renders the single activity row above the status line. It lives
// outside the transcript, so a long run stays visible while history scrolls.
func (m *Model) renderActivity() string {
	label := m.activityLabel()
	width := m.frameWidth()
	if label == "" || width <= 0 {
		return ""
	}

	marker := m.activityMarker()
	meta := m.activityMeta()
	sep := ""
	if meta != "" {
		sep = "  "
	}
	styled := m.styles.activityLabel.Render(label)
	line := marker + " " + styled
	if sep != "" {
		line += sep + meta
	}
	if lipglossWidth(line) <= width {
		return line
	}

	// The GUI shrinks the label first and keeps every meta item whole; only
	// when the marker and meta alone overflow does the right edge clip, which
	// loses the rate first.
	budget := width - lipglossWidth(marker) - 1 - lipglossWidth(sep) - lipglossWidth(meta)
	if budget >= 1 {
		return marker + " " + truncateLine(styled, budget) + sep + meta
	}
	head := marker + " "
	room := width - lipglossWidth(head)
	if room < 1 {
		return truncateLine(line, width)
	}
	return head + truncateLine(meta, room)
}

// activityMeta is the quiet sibling of the label: the run's clock, the
// estimate of the block the label names, and the live token rate.
func (m *Model) activityMeta() string {
	a := &m.activity
	var parts []string
	if !a.startedAt.IsZero() {
		elapsed := formatTurnDuration(time.Since(a.startedAt))
		parts = append(parts, m.styles.activityMeta.Render("Elapsed "+elapsed))
	}
	if tokens, ok := m.activityTokenEstimate(); ok {
		if rounded := int(math.Round(tokens)); rounded >= 1 {
			parts = append(parts, m.styles.activityMeta.Render(
				"~"+formatCompactCount(rounded)+" tokens"))
		}
	}
	if rate, ok := m.activityTokensPerSecond(time.Now()); ok {
		parts = append(parts, m.styles.activityMeta.Render(rate))
	}
	return strings.Join(parts, "  ")
}

// activityTokenEstimate is the "~N tokens" beside the label: one block at a
// time, never a total, so the number only ever annotates what the label names.
// The branch order mirrors the GUI's composerActivityTokens.
func (m *Model) activityTokenEstimate() (float64, bool) {
	a := &m.activity
	if a.compacting {
		return 0, false
	}
	if len(a.tools) > 1 {
		// A grouped row names several calls, so no single number applies.
		return 0, false
	}
	if len(a.tools) == 1 {
		if a.tools[0].input == "" {
			return 0, false
		}
		return estimateTokens(a.tools[0].input), true
	}
	block := a.lastStreamBlock()
	if block == nil {
		return 0, false
	}
	if block.kind == "toolCall" {
		return estimateTokens(block.text), true
	}
	if a.phase == activityWaiting {
		return 0, false
	}
	if block.kind == "thinking" {
		return estimateTokens(block.text), true
	}
	return 0, false
}

// activityTokensPerSecond is the live speed beside the label's number. It
// measures the whole streaming reply, anchored at the message's first tokens,
// and hides whenever the model is silent: while a call executes the count is
// frozen, and a rate over frozen tokens would only fall as the tool runs.
func (m *Model) activityTokensPerSecond(now time.Time) (string, bool) {
	a := &m.activity
	if a.compacting || len(a.tools) > 0 {
		return "", false
	}
	block := a.lastStreamBlock()
	if block == nil {
		return "", false
	}
	drafting := block.kind == "toolCall"
	activeThinking := block.kind == "thinking" && a.phase != activityWaiting
	if !drafting && !activeThinking {
		return "", false
	}
	total := a.streamTokens()
	if total <= 0 {
		return "", false
	}
	if a.rateAt.IsZero() {
		a.rateAt = now
		a.rateTokens = total
		return "", false
	}
	elapsed := now.Sub(a.rateAt).Seconds()
	if elapsed <= 0.5 {
		return "", false
	}
	rate := (total - a.rateTokens) / elapsed
	if rate < 0 {
		rate = 0
	}
	return fmt.Sprintf("%.1f t/s", rate), true
}

// activityMarker is the pulsing blue dot in front of the label. It changes both
// colour and glyph, so the blink survives a terminal without colour.
func (m *Model) activityMarker() string {
	const frames = 8 // 8 × 40 ms: a calm ~320 ms half-cycle
	if (m.frame/frames)%2 == 0 {
		return m.styles.activityMarker.Render("●")
	}
	return m.styles.activityMarkerDim.Render("○")
}

// formatTurnDuration is the run's clock, the GUI's turn-duration format:
// 42s · 3m 5s · 1h 20m 5s.
func formatTurnDuration(elapsed time.Duration) string {
	total := int(elapsed / time.Second)
	if total < 0 {
		total = 0
	}
	switch {
	case total < 60:
		return fmt.Sprintf("%ds", total)
	case total < 3600:
		return fmt.Sprintf("%dm %ds", total/60, total%60)
	default:
		return fmt.Sprintf("%dh %dm %ds", total/3600, (total/60)%60, total%60)
	}
}

// formatCompactCount is the GUI's compact counter: 950 · 1.1k · 18.4k · 1.2M.
func formatCompactCount(value int) string {
	if value >= 1_000_000 {
		return fmt.Sprintf("%.1fM", float64(value)/1_000_000)
	}
	if value >= 1000 {
		formatted := fmt.Sprintf("%.1f", float64(value)/1000)
		formatted = strings.TrimSuffix(formatted, ".0")
		return formatted + "k"
	}
	return strconv.Itoa(value)
}

// estimateTokens is the GUI's heuristic, not a measurement: CJK is roughly one
// token per character, everything else roughly four characters per token.
func estimateTokens(text string) float64 {
	var cjk, rest float64
	for _, r := range text {
		if isCJKRune(r) {
			cjk++
		} else {
			rest++
		}
	}
	return cjk + rest/4
}

// isCJKRune mirrors the GUI's CJK token pattern over code points.
func isCJKRune(r rune) bool {
	switch {
	case r >= 0x3000 && r <= 0x30FF:
		return true
	case r >= 0x3400 && r <= 0x9FFF:
		return true
	case r >= 0xF900 && r <= 0xFAFF:
		return true
	case r >= 0x20000 && r <= 0x2FA1F:
		return true
	case r >= 0xAC00 && r <= 0xD7AF:
		return true
	}
	return false
}

// activityToolKind groups concurrent calls so the bar stays one line. The
// classification mirrors the GUI's tool-name predicates.
type activityToolKind int

const (
	activityToolOther activityToolKind = iota
	activityToolRead
	activityToolSearch
	activityToolList
	activityToolShell
)

// readToolPattern is the GUI's isReadToolName: read, read_file, and the same
// word behind a `_` or `.` separator.
var readToolPattern = regexp.MustCompile(`(?i)^(?:read(?:_file)?|.*[._]read(?:_file)?)$`)

// shellToolSet is the GUI's shell tool names.
var shellToolSet = map[string]bool{
	"bash": true, "shell": true, "sh": true, "zsh": true,
	"powershell": true, "pwsh": true, "cmd": true, "exec": true,
	"exec_command": true, "run_command": true, "run_shell_command": true,
	"execute_command": true, "terminal": true, "local_shell": true,
}

var (
	shellTailSplit = regexp.MustCompile(`\.|__`)
	shellWord      = regexp.MustCompile(`(^|[._-])(bash|shell|powershell)([._-]|$)`)
)

// activityToolKindOf classifies a tool name with the GUI's predicates: only
// the last name segment counts for search and list, so a tool named
// find_user keeps a label of its own.
func activityToolKindOf(name string) activityToolKind {
	lower := strings.ToLower(strings.TrimSpace(name))

	segments := strings.FieldsFunc(lower, func(r rune) bool {
		return r == '.' || r == '_'
	})
	last := ""
	if len(segments) > 0 {
		last = segments[len(segments)-1]
	}

	switch {
	case last == "grep" || last == "find":
		return activityToolSearch
	case last == "ls":
		return activityToolList
	case readToolPattern.MatchString(lower):
		return activityToolRead
	case isShellToolName(lower):
		return activityToolShell
	}
	return activityToolOther
}

// isShellToolName mirrors the GUI: the head before whitespace or a paren, the
// tail behind `.` or `__`, and the decorated bash/shell/powershell forms.
func isShellToolName(lower string) bool {
	head := lower
	if i := strings.IndexAny(head, " ("); i >= 0 {
		head = head[:i]
	}
	if shellToolSet[head] {
		return true
	}
	tails := shellTailSplit.Split(head, -1)
	if shellToolSet[tails[len(tails)-1]] {
		return true
	}
	return shellWord.MatchString(head)
}

// activityToolsLabel names concurrent calls, grouping repeats by kind in the
// GUI's fixed order so the row never grows past one line.
func activityToolsLabel(tools []activityTool) string {
	if len(tools) == 1 {
		return activityToolLabel(tools[0])
	}

	var reads, searches, listings, shells, others []activityTool
	for _, tool := range tools {
		switch activityToolKindOf(tool.name) {
		case activityToolSearch:
			searches = append(searches, tool)
		case activityToolList:
			listings = append(listings, tool)
		case activityToolRead:
			reads = append(reads, tool)
		case activityToolShell:
			shells = append(shells, tool)
		default:
			others = append(others, tool)
		}
	}

	parts := make([]string, 0, 5)
	if len(reads) == 1 {
		parts = append(parts, activityToolLabel(reads[0]))
	} else if len(reads) > 1 {
		parts = append(parts, fmt.Sprintf("Reading %d files", len(reads)))
	}
	if len(searches) == 1 {
		parts = append(parts, activityToolLabel(searches[0]))
	} else if len(searches) > 1 {
		parts = append(parts, fmt.Sprintf("Searching %d patterns", len(searches)))
	}
	if len(listings) == 1 {
		parts = append(parts, activityToolLabel(listings[0]))
	} else if len(listings) > 1 {
		parts = append(parts, fmt.Sprintf("Listing %d directories", len(listings)))
	}
	if len(shells) == 1 {
		parts = append(parts, activityToolLabel(shells[0]))
	} else if len(shells) > 1 {
		parts = append(parts, fmt.Sprintf("Running %d commands", len(shells)))
	}
	if len(others) > 0 {
		parts = append(parts, activityOthersLabel(others))
	}
	return strings.Join(parts, " · ")
}

// activityOthersLabel covers every tool that is not a read, search, listing,
// or shell call — the GUI keeps those as plain "Running <name>" groups.
func activityOthersLabel(tools []activityTool) string {
	if len(tools) == 1 {
		return "Running " + tools[0].name + "..."
	}
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, tool.name)
	}
	if len(names) <= 3 {
		return "Running " + strings.Join(names, ", ") + "..."
	}
	return fmt.Sprintf("Running %s (+%d)...", strings.Join(names[:2], ", "), len(names)-2)
}

// activityToolLabel is one concrete call's label: a group of one keeps its
// detail (path, pattern), exactly like the GUI.
func activityToolLabel(tool activityTool) string {
	switch activityToolKindOf(tool.name) {
	case activityToolRead:
		if path := activityArg(tool.args, "path", "file_path", "filePath"); path != "" {
			return "Reading " + path
		}
		return "Reading…"
	case activityToolSearch:
		pattern := activityArg(tool.args, "pattern", "query")
		if pattern == "" {
			return "Searching…"
		}
		if path := activityArg(tool.args, "path", "file_path", "filePath"); path != "" {
			return fmt.Sprintf("Searching \"%s\" in %s", pattern, path)
		}
		return fmt.Sprintf("Searching \"%s\"", pattern)
	case activityToolList:
		if path := activityArg(tool.args, "path", "file_path", "filePath"); path != "" {
			return "Listing " + path
		}
		return "Listing…"
	case activityToolShell:
		return "Running command…"
	}
	return "Running " + tool.name + "..."
}

// activityArg picks the first non-empty string argument, the way the GUI
// reads path/pattern/command out of a call's input.
func activityArg(args map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := args[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
