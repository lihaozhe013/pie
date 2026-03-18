// Package rpc implements the JSONL protocol spoken by `pi --mode rpc`.
//
// The protocol has four record families: commands (client to pi), responses,
// session events, and the extension UI subprotocol. This file defines the
// inbound side: session events, responses, and the permissive parser that turns
// a raw stdout line into a typed value. Parsing never fails on a well-formed
// JSON object; unknown or partially malformed records degrade to *UnknownEvent
// so a newer pi release cannot crash the client.
package rpc

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// ErrMalformedRecord reports a stdout line that is not a usable JSON object.
var ErrMalformedRecord = errors.New("malformed rpc record")

// Event is one decoded record read from pi's stdout.
type Event interface {
	// Kind reports the protocol record type, for example "message_update".
	Kind() string
}

// Response reports the outcome of one command. Responses are correlated by ID
// and are normally consumed by Client, not by the UI.
type Response struct {
	ID      string          `json:"id,omitempty"`
	Command string          `json:"command"`
	Success bool            `json:"success"`
	Error   string          `json:"error,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// Kind implements Event.
func (*Response) Kind() string { return "response" }

// DecodeData decodes the response payload into v.
func (r *Response) DecodeData(v any) error {
	if len(r.Data) == 0 || string(r.Data) == "null" {
		return nil
	}
	return json.Unmarshal(r.Data, v)
}

// AgentStartEvent is emitted when a low-level agent run starts.
type AgentStartEvent struct{}

// Kind implements Event.
func (*AgentStartEvent) Kind() string { return "agent_start" }

// AgentEndEvent closes one low-level agent run. Automatic retries, overflow
// recovery, compaction, steering, or follow-up work can still follow, so this
// is not the end of the session-level run.
type AgentEndEvent struct {
	Messages  []Message `json:"messages"`
	WillRetry bool      `json:"willRetry"`
}

// Kind implements Event.
func (*AgentEndEvent) Kind() string { return "agent_end" }

// AgentSettledEvent means pi will not continue automatically.
type AgentSettledEvent struct {
	Aborted bool `json:"aborted"`
}

// Kind implements Event.
func (*AgentSettledEvent) Kind() string { return "agent_settled" }

// TurnStartEvent starts one assistant turn.
type TurnStartEvent struct{}

// Kind implements Event.
func (*TurnStartEvent) Kind() string { return "turn_start" }

// TurnEndEvent finishes one assistant turn and its tool calls.
type TurnEndEvent struct {
	Message     Message   `json:"message"`
	ToolResults []Message `json:"toolResults"`
}

// Kind implements Event.
func (*TurnEndEvent) Kind() string { return "turn_end" }

// MessageStartEvent announces a started message.
type MessageStartEvent struct {
	Message Message `json:"message"`
}

// Kind implements Event.
func (*MessageStartEvent) Kind() string { return "message_start" }

// MessageUpdateEvent carries one streaming delta of an assistant message.
type MessageUpdateEvent struct {
	Usage     *Usage                `json:"usage"`
	Assistant AssistantMessageEvent `json:"assistantMessageEvent"`
	Timestamp int64                 `json:"timestamp,omitempty"`
}

// Kind implements Event.
func (*MessageUpdateEvent) Kind() string { return "message_update" }

// MessageEndEvent carries the authoritative final message.
type MessageEndEvent struct {
	Message Message `json:"message"`
}

// Kind implements Event.
func (*MessageEndEvent) Kind() string { return "message_end" }

// ToolExecutionStartEvent starts a tool execution.
type ToolExecutionStartEvent struct {
	ToolCallID string          `json:"toolCallId"`
	ToolName   string          `json:"toolName"`
	Args       json.RawMessage `json:"args"`
}

// Kind implements Event.
func (*ToolExecutionStartEvent) Kind() string { return "tool_execution_start" }

// ToolExecutionUpdateEvent reports a partial tool result.
type ToolExecutionUpdateEvent struct {
	ToolCallID    string          `json:"toolCallId"`
	ToolName      string          `json:"toolName"`
	Args          json.RawMessage `json:"args"`
	PartialResult json.RawMessage `json:"partialResult"`
}

// Kind implements Event.
func (*ToolExecutionUpdateEvent) Kind() string { return "tool_execution_update" }

// ToolExecutionEndEvent finishes a tool execution.
type ToolExecutionEndEvent struct {
	ToolCallID string          `json:"toolCallId"`
	ToolName   string          `json:"toolName"`
	Result     json.RawMessage `json:"result"`
	IsError    bool            `json:"isError"`
	DurationMs *float64        `json:"durationMs,omitempty"`
}

// Kind implements Event.
func (*ToolExecutionEndEvent) Kind() string { return "tool_execution_end" }

// QueueUpdateEvent reports the complete pending steering and follow-up queues.
type QueueUpdateEvent struct {
	Steering []string `json:"steering"`
	FollowUp []string `json:"followUp"`
}

// Kind implements Event.
func (*QueueUpdateEvent) Kind() string { return "queue_update" }

// SessionInfoChangedEvent reports a renamed or cleared session.
type SessionInfoChangedEvent struct {
	Name string `json:"name"`
}

// Kind implements Event.
func (*SessionInfoChangedEvent) Kind() string { return "session_info_changed" }

// ThinkingLevelChangedEvent reports a thinking level change.
type ThinkingLevelChangedEvent struct {
	Level string `json:"level"`
}

// Kind implements Event.
func (*ThinkingLevelChangedEvent) Kind() string { return "thinking_level_changed" }

// EntryAppendedEvent reports an extension-appended session entry.
type EntryAppendedEvent struct {
	Entry json.RawMessage `json:"entry"`
}

// Kind implements Event.
func (*EntryAppendedEvent) Kind() string { return "entry_appended" }

// CompactionStartEvent reports why compaction began.
type CompactionStartEvent struct {
	Reason string `json:"reason"`
}

// Kind implements Event.
func (*CompactionStartEvent) Kind() string { return "compaction_start" }

// CompactionEndEvent reports a finished, aborted, or failed compaction.
type CompactionEndEvent struct {
	Reason       string            `json:"reason"`
	Result       *CompactionResult `json:"result,omitempty"`
	Aborted      bool              `json:"aborted"`
	WillRetry    bool              `json:"willRetry"`
	ErrorMessage string            `json:"errorMessage,omitempty"`
}

// Kind implements Event.
func (*CompactionEndEvent) Kind() string { return "compaction_end" }

// AutoRetryStartEvent reports an assistant-turn retry.
type AutoRetryStartEvent struct {
	Attempt      int    `json:"attempt"`
	MaxAttempts  int    `json:"maxAttempts"`
	DelayMs      int64  `json:"delayMs"`
	ErrorMessage string `json:"errorMessage"`
}

// Kind implements Event.
func (*AutoRetryStartEvent) Kind() string { return "auto_retry_start" }

// AutoRetryEndEvent reports the outcome of a retry sequence.
type AutoRetryEndEvent struct {
	Success    bool   `json:"success"`
	Attempt    int    `json:"attempt"`
	FinalError string `json:"finalError,omitempty"`
}

// Kind implements Event.
func (*AutoRetryEndEvent) Kind() string { return "auto_retry_end" }

// SummarizationRetryScheduledEvent reports a scheduled compaction retry.
type SummarizationRetryScheduledEvent struct {
	Attempt      int    `json:"attempt"`
	MaxAttempts  int    `json:"maxAttempts"`
	DelayMs      int64  `json:"delayMs"`
	ErrorMessage string `json:"errorMessage"`
}

// Kind implements Event.
func (*SummarizationRetryScheduledEvent) Kind() string { return "summarization_retry_scheduled" }

// SummarizationRetryAttemptStartEvent reports the start of a retry attempt.
type SummarizationRetryAttemptStartEvent struct {
	Source string `json:"source"`
	Reason string `json:"reason,omitempty"`
}

// Kind implements Event.
func (*SummarizationRetryAttemptStartEvent) Kind() string {
	return "summarization_retry_attempt_start"
}

// SummarizationRetryFinishedEvent reports the end of a summarization retry.
type SummarizationRetryFinishedEvent struct{}

// Kind implements Event.
func (*SummarizationRetryFinishedEvent) Kind() string { return "summarization_retry_finished" }

// BashExecutionUpdateEvent is one streamed chunk of a direct `bash` command.
type BashExecutionUpdateEvent struct {
	ID    string `json:"id,omitempty"`
	Delta string `json:"delta"`
}

// Kind implements Event.
func (*BashExecutionUpdateEvent) Kind() string { return "bash_execution_update" }

// ExtensionErrorEvent reports a throwing extension handler.
type ExtensionErrorEvent struct {
	ExtensionPath string `json:"extensionPath"`
	Event         string `json:"event"`
	Error         string `json:"error"`
}

// Kind implements Event.
func (*ExtensionErrorEvent) Kind() string { return "extension_error" }

// ExtensionUIRequestEvent is a request from pi's extension UI subprotocol.
//
// Dialog methods (select, confirm, input, editor) block until the client sends
// a matching ExtensionUIResponse. The rest are fire-and-forget.
type ExtensionUIRequestEvent struct {
	ID              string   `json:"id"`
	Method          string   `json:"method"`
	Title           string   `json:"title,omitempty"`
	Message         string   `json:"message,omitempty"`
	Options         []string `json:"options,omitempty"`
	Placeholder     string   `json:"placeholder,omitempty"`
	Prefill         string   `json:"prefill,omitempty"`
	Timeout         int      `json:"timeout,omitempty"`
	NotifyType      string   `json:"notifyType,omitempty"`
	StatusKey       string   `json:"statusKey,omitempty"`
	StatusText      string   `json:"statusText,omitempty"`
	WidgetKey       string   `json:"widgetKey,omitempty"`
	WidgetLines     []string `json:"widgetLines,omitempty"`
	WidgetPlacement string   `json:"widgetPlacement,omitempty"`
	Text            string   `json:"text,omitempty"`
}

// Kind implements Event.
func (*ExtensionUIRequestEvent) Kind() string { return "extension_ui_request" }

// IsDialog reports whether the request blocks until answered.
func (e *ExtensionUIRequestEvent) IsDialog() bool {
	switch e.Method {
	case "select", "confirm", "input", "editor":
		return true
	default:
		return false
	}
}

// UnknownEvent is a record this client does not model, or a known record that
// failed to decode. It is never fatal.
type UnknownEvent struct {
	Type string
	Raw  json.RawMessage
}

// Kind implements Event.
func (e *UnknownEvent) Kind() string { return e.Type }

// Message is a protocol message. Content blocks are decoded leniently: a plain
// string is treated as a single text block.
type Message struct {
	Role         string          `json:"role"`
	Content      Content         `json:"content"`
	Timestamp    int64           `json:"timestamp"`
	StopReason   string          `json:"stopReason,omitempty"`
	ErrorMessage string          `json:"errorMessage,omitempty"`
	Usage        *Usage          `json:"usage,omitempty"`
	Provider     string          `json:"provider,omitempty"`
	Model        string          `json:"model,omitempty"`
	ToolCallID   string          `json:"toolCallId,omitempty"`
	ToolName     string          `json:"toolName,omitempty"`
	Details      json.RawMessage `json:"details,omitempty"`
	IsError      bool            `json:"isError,omitempty"`
}

// Text concatenates every text block of the message.
func (m Message) Text() string {
	var b strings.Builder
	for _, block := range m.Content {
		if block.Type == "text" && block.Text != "" {
			if b.Len() > 0 {
				b.WriteString("\n")
			}
			b.WriteString(block.Text)
		}
	}
	return b.String()
}

// Tools reports the tool calls carried by the message.
func (m Message) Tools() []ToolCall {
	var out []ToolCall
	for _, block := range m.Content {
		if block.Type == "toolCall" && block.ToolCall != nil {
			out = append(out, *block.ToolCall)
		}
	}
	return out
}

// Content is a list of content blocks.
type Content []ContentBlock

// UnmarshalJSON accepts a string, null, or an array of blocks.
func (c *Content) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	switch {
	case trimmed == "" || trimmed == "null":
		*c = nil
		return nil
	case strings.HasPrefix(trimmed, `"`):
		var text string
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
		*c = Content{{Type: "text", Text: text}}
		return nil
	}

	var rawBlocks []json.RawMessage
	if err := json.Unmarshal(data, &rawBlocks); err != nil {
		return err
	}
	blocks := make(Content, 0, len(rawBlocks))
	for _, raw := range rawBlocks {
		block, err := decodeContentBlock(raw)
		if err != nil {
			// A single unexpected block must not discard the whole message.
			continue
		}
		blocks = append(blocks, block)
	}
	*c = blocks
	return nil
}

// ContentBlock is one text, thinking, image, or tool-call block.
type ContentBlock struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	Thinking string    `json:"thinking,omitempty"`
	Redacted bool      `json:"redacted,omitempty"`
	Data     string    `json:"data,omitempty"`
	MimeType string    `json:"mimeType,omitempty"`
	ToolCall *ToolCall `json:"toolCall,omitempty"`
}

func decodeContentBlock(raw json.RawMessage) (ContentBlock, error) {
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return ContentBlock{}, err
	}

	block := ContentBlock{Type: envelope.Type}
	switch envelope.Type {
	case "text":
		var payload struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return ContentBlock{}, err
		}
		block.Text = payload.Text
	case "thinking":
		var payload struct {
			Thinking string `json:"thinking"`
			Redacted bool   `json:"redacted"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return ContentBlock{}, err
		}
		block.Thinking = payload.Thinking
		block.Redacted = payload.Redacted
	case "image":
		var payload struct {
			Data     string `json:"data"`
			MimeType string `json:"mimeType"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return ContentBlock{}, err
		}
		block.Data = payload.Data
		block.MimeType = payload.MimeType
	case "toolCall":
		var call ToolCall
		if err := json.Unmarshal(raw, &call); err != nil {
			return ContentBlock{}, err
		}
		block.ToolCall = &call
	default:
		// Unknown block kinds (future providers) keep their type only.
	}
	return block, nil
}

// ToolCall is one tool invocation carried inside an assistant message.
type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

// Usage is provider-reported token usage.
type Usage struct {
	Input       int  `json:"input"`
	Output      int  `json:"output"`
	CacheRead   int  `json:"cacheRead"`
	CacheWrite  int  `json:"cacheWrite"`
	Reasoning   int  `json:"reasoning,omitempty"`
	TotalTokens int  `json:"totalTokens"`
	Cost        Cost `json:"cost"`
}

// Cost is provider-reported spend in US dollars.
type Cost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Total      float64 `json:"total"`
}

// AssistantMessageEvent is the nested delta payload of a message_update record.
type AssistantMessageEvent struct {
	Type         string    `json:"type"`
	ContentIndex int       `json:"contentIndex,omitempty"`
	Delta        string    `json:"delta,omitempty"`
	Content      string    `json:"content,omitempty"`
	ToolCallID   string    `json:"id,omitempty"`
	ToolName     string    `json:"toolName,omitempty"`
	ToolCall     *ToolCall `json:"toolCall,omitempty"`
	Reason       string    `json:"reason,omitempty"`
	Error        string    `json:"error,omitempty"`
}

// CompactionResult describes a successful compaction.
type CompactionResult struct {
	Summary              string `json:"summary"`
	FirstKeptEntryID     string `json:"firstKeptEntryId"`
	TokensBefore         int    `json:"tokensBefore"`
	EstimatedTokensAfter int    `json:"estimatedTokensAfter"`
	Usage                *Usage `json:"usage,omitempty"`
}

// ParseLine decodes one stdout record.
//
// The only error returned is a record that is not a JSON object. Unknown record
// types and known types with unexpected payloads are returned as *UnknownEvent
// so the caller can keep the session alive across pi upgrades.
func ParseLine(line []byte) (Event, error) {
	record := bytes.TrimSpace(line)
	if len(record) == 0 {
		return nil, fmt.Errorf("%w: empty record", ErrMalformedRecord)
	}
	if record[0] != '{' {
		return nil, fmt.Errorf("%w: not a JSON object", ErrMalformedRecord)
	}

	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(record, &envelope); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformedRecord, err)
	}
	if envelope.Type == "" {
		return nil, fmt.Errorf("%w: missing type field", ErrMalformedRecord)
	}

	switch envelope.Type {
	case "response":
		return decodeEvent[Response](envelope.Type, record)
	case "agent_start":
		return &AgentStartEvent{}, nil
	case "agent_end":
		return decodeEvent[AgentEndEvent](envelope.Type, record)
	case "agent_settled":
		return decodeEvent[AgentSettledEvent](envelope.Type, record)
	case "turn_start":
		return &TurnStartEvent{}, nil
	case "turn_end":
		return decodeEvent[TurnEndEvent](envelope.Type, record)
	case "message_start":
		return decodeEvent[MessageStartEvent](envelope.Type, record)
	case "message_update":
		return decodeEvent[MessageUpdateEvent](envelope.Type, record)
	case "message_end":
		return decodeEvent[MessageEndEvent](envelope.Type, record)
	case "tool_execution_start":
		return decodeEvent[ToolExecutionStartEvent](envelope.Type, record)
	case "tool_execution_update":
		return decodeEvent[ToolExecutionUpdateEvent](envelope.Type, record)
	case "tool_execution_end":
		return decodeEvent[ToolExecutionEndEvent](envelope.Type, record)
	case "queue_update":
		return decodeEvent[QueueUpdateEvent](envelope.Type, record)
	case "session_info_changed":
		return decodeEvent[SessionInfoChangedEvent](envelope.Type, record)
	case "thinking_level_changed":
		return decodeEvent[ThinkingLevelChangedEvent](envelope.Type, record)
	case "entry_appended":
		return decodeEvent[EntryAppendedEvent](envelope.Type, record)
	case "compaction_start":
		return decodeEvent[CompactionStartEvent](envelope.Type, record)
	case "compaction_end":
		return decodeEvent[CompactionEndEvent](envelope.Type, record)
	case "auto_retry_start":
		return decodeEvent[AutoRetryStartEvent](envelope.Type, record)
	case "auto_retry_end":
		return decodeEvent[AutoRetryEndEvent](envelope.Type, record)
	case "summarization_retry_scheduled":
		return decodeEvent[SummarizationRetryScheduledEvent](envelope.Type, record)
	case "summarization_retry_attempt_start":
		return decodeEvent[SummarizationRetryAttemptStartEvent](envelope.Type, record)
	case "summarization_retry_finished":
		return &SummarizationRetryFinishedEvent{}, nil
	case "bash_execution_update":
		return decodeEvent[BashExecutionUpdateEvent](envelope.Type, record)
	case "extension_error":
		return decodeEvent[ExtensionErrorEvent](envelope.Type, record)
	case "extension_ui_request":
		return decodeEvent[ExtensionUIRequestEvent](envelope.Type, record)
	default:
		return &UnknownEvent{Type: envelope.Type, Raw: append(json.RawMessage(nil), record...)}, nil
	}
}

func decodeEvent[T any](typeName string, record json.RawMessage) (Event, error) {
	var value T
	if err := json.Unmarshal(record, &value); err != nil {
		return &UnknownEvent{Type: typeName, Raw: append(json.RawMessage(nil), record...)}, nil
	}
	event, ok := any(&value).(Event)
	if !ok {
		return &UnknownEvent{Type: typeName, Raw: append(json.RawMessage(nil), record...)}, nil
	}
	return event, nil
}

// StreamBlock is one accumulating content block of a streaming message.
type StreamBlock struct {
	Index      int
	Kind       string // "text", "thinking", or "toolCall"
	Text       string
	ToolCallID string
	ToolName   string
	Args       string
	Done       bool
}

// StreamAccumulator rebuilds an assistant message from delta-only
// message_update records.
//
// Deltas are for live display only. text_end, thinking_end, toolcall_end, and
// message_end carry authoritative content and always overwrite accumulated
// text. The accumulator is not safe for concurrent use.
type StreamAccumulator struct {
	blocks map[int]*StreamBlock
}

// Reset drops all accumulated state.
func (s *StreamAccumulator) Reset() {
	s.blocks = nil
}

// Apply folds one assistant message event into the accumulated state.
func (s *StreamAccumulator) Apply(event AssistantMessageEvent) {
	if s.blocks == nil {
		s.blocks = make(map[int]*StreamBlock, 4)
	}
	block := s.blocks[event.ContentIndex]
	if block == nil {
		kind := kindForStreamEvent(event.Type)
		if kind == "" {
			return
		}
		block = &StreamBlock{Index: event.ContentIndex, Kind: kind}
		s.blocks[event.ContentIndex] = block
	}

	switch event.Type {
	case "text_start", "thinking_start", "toolcall_start":
		if event.ToolCallID != "" {
			block.ToolCallID = event.ToolCallID
		}
		if event.ToolName != "" {
			block.ToolName = event.ToolName
		}
	case "text_delta", "thinking_delta":
		block.Text += event.Delta
	case "toolcall_delta":
		block.Args += event.Delta
	case "text_end", "thinking_end":
		block.Text = event.Content
		block.Done = true
	case "toolcall_end":
		block.Done = true
		if event.ToolCall != nil {
			block.ToolCallID = event.ToolCall.ID
			block.ToolName = event.ToolCall.Name
			if len(event.ToolCall.Arguments) > 0 {
				block.Args = string(event.ToolCall.Arguments)
			}
		}
	}
}

// Blocks returns the accumulated blocks ordered by content index.
func (s *StreamAccumulator) Blocks() []StreamBlock {
	out := make([]StreamBlock, 0, len(s.blocks))
	for _, block := range s.blocks {
		out = append(out, *block)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Index < out[j].Index })
	return out
}

// Text concatenates every accumulated text block.
func (s *StreamAccumulator) Text() string {
	out := s.Blocks()
	var b strings.Builder
	for _, block := range out {
		if block.Kind == "text" {
			b.WriteString(block.Text)
		}
	}
	return b.String()
}

// Thinking concatenates every accumulated thinking block.
func (s *StreamAccumulator) Thinking() string {
	out := s.Blocks()
	var b strings.Builder
	for _, block := range out {
		if block.Kind == "thinking" {
			b.WriteString(block.Text)
		}
	}
	return b.String()
}

func kindForStreamEvent(eventType string) string {
	switch {
	case strings.HasPrefix(eventType, "text_"):
		return "text"
	case strings.HasPrefix(eventType, "thinking_"):
		return "thinking"
	case strings.HasPrefix(eventType, "toolcall_"):
		return "toolCall"
	default:
		return ""
	}
}

// DecodeArgs decodes tool call arguments permissively. Invalid JSON yields nil.
func DecodeArgs(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var args map[string]any
	if err := json.Unmarshal(raw, &args); err != nil {
		return nil
	}
	return args
}
