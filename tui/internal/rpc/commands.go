package rpc

import "encoding/json"

// This file is the outbound side of the protocol: typed builders for every
// command in docs/rpc-commands.md, plus the payload shapes the UI reads back.
// Builders return Command values ready for Client.Do / Client.DoOK.

// Image is base64 encoded image content attached to a prompt.
type Image struct {
	Type     string `json:"type"`
	Data     string `json:"data"`
	MimeType string `json:"mimeType"`
}

// Prompt asks pi to start a run.
//
// The response only means the prompt was accepted; completion is reported by
// the agent_settled event.
func Prompt(message string) Command {
	return Command{"type": "prompt", "message": message}
}

// PromptWithImages is Prompt with image attachments.
func PromptWithImages(message string, images []Image) Command {
	command := Prompt(message)
	if len(images) > 0 {
		command["images"] = images
	}
	return command
}

// Steer queues a message for delivery after the current turn.
func Steer(message string) Command {
	return Command{"type": "steer", "message": message}
}

// FollowUp queues a message for when the agent finishes.
func FollowUp(message string) Command {
	return Command{"type": "follow_up", "message": message}
}

// Abort cancels the current operation.
func Abort() Command { return Command{"type": "abort"} }

// ClearQueue drops queued steering and follow-up messages and returns them.
func ClearQueue() Command { return Command{"type": "clear_queue"} }

// NewSession starts a fresh session.
func NewSession() Command { return Command{"type": "new_session"} }

// GetState returns the current session state.
func GetState() Command { return Command{"type": "get_state"} }

// GetMessages returns every message of the active branch.
func GetMessages() Command { return Command{"type": "get_messages"} }

// SetModel switches to a specific provider/model pair.
func SetModel(provider, modelID string) Command {
	return Command{"type": "set_model", "provider": provider, "modelId": modelID}
}

// CycleModel advances to the next available model.
func CycleModel() Command { return Command{"type": "cycle_model"} }

// GetAvailableModels lists configured models.
func GetAvailableModels() Command { return Command{"type": "get_available_models"} }

// SetThinkingLevel sets the reasoning level.
func SetThinkingLevel(level string) Command {
	return Command{"type": "set_thinking_level", "level": level}
}

// CycleThinkingLevel advances to the next reasoning level.
func CycleThinkingLevel() Command { return Command{"type": "cycle_thinking_level"} }

// GetAvailableThinkingLevels lists levels supported by the current model.
func GetAvailableThinkingLevels() Command {
	return Command{"type": "get_available_thinking_levels"}
}

// SetSteeringMode selects how steering messages are delivered.
func SetSteeringMode(mode string) Command {
	return Command{"type": "set_steering_mode", "mode": mode}
}

// SetFollowUpMode selects how follow-up messages are delivered.
func SetFollowUpMode(mode string) Command {
	return Command{"type": "set_follow_up_mode", "mode": mode}
}

// Compact compacts the conversation context.
func Compact(customInstructions string) Command {
	command := Command{"type": "compact"}
	if customInstructions != "" {
		command["customInstructions"] = customInstructions
	}
	return command
}

// SetAutoCompaction toggles automatic compaction.
func SetAutoCompaction(enabled bool) Command {
	return Command{"type": "set_auto_compaction", "enabled": enabled}
}

// SetAutoRetry toggles automatic retries on transient provider errors.
func SetAutoRetry(enabled bool) Command {
	return Command{"type": "set_auto_retry", "enabled": enabled}
}

// AbortRetry cancels an in-progress retry delay.
func AbortRetry() Command { return Command{"type": "abort_retry"} }

// Bash runs a shell command and adds its output to the conversation context.
func Bash(command string, excludeFromContext bool) Command {
	out := Command{"type": "bash", "command": command}
	if excludeFromContext {
		out["excludeFromContext"] = true
	}
	return out
}

// AbortBash cancels a running bash command.
func AbortBash() Command { return Command{"type": "abort_bash"} }

// GetSessionStats returns token usage and context window state.
func GetSessionStats() Command { return Command{"type": "get_session_stats"} }

// ExportHTML writes the session to an HTML file.
func ExportHTML(outputPath string) Command {
	command := Command{"type": "export_html"}
	if outputPath != "" {
		command["outputPath"] = outputPath
	}
	return command
}

// SwitchSession loads another session file.
func SwitchSession(sessionPath string) Command {
	return Command{"type": "switch_session", "sessionPath": sessionPath}
}

// Fork creates a new branch from a previous user message.
func Fork(entryID string) Command {
	return Command{"type": "fork", "entryId": entryID}
}

// Clone duplicates the active branch into a new session.
func Clone() Command { return Command{"type": "clone"} }

// GetForkMessages lists forkable user messages.
func GetForkMessages() Command { return Command{"type": "get_fork_messages"} }

// GetEntries returns session entries, optionally after a cursor.
func GetEntries(since string) Command {
	command := Command{"type": "get_entries"}
	if since != "" {
		command["since"] = since
	}
	return command
}

// GetTree returns the session tree.
func GetTree() Command { return Command{"type": "get_tree"} }

// GetLastAssistantText returns the last assistant message text.
func GetLastAssistantText() Command { return Command{"type": "get_last_assistant_text"} }

// SetSessionName sets the session display name.
func SetSessionName(name string) Command {
	return Command{"type": "set_session_name", "name": name}
}

// GetCommands lists extension commands, prompt templates, and skills.
func GetCommands() Command { return Command{"type": "get_commands"} }

// ExtensionUIValue answers a select, input, or editor dialog.
func ExtensionUIValue(id, value string) Command {
	return Command{"type": "extension_ui_response", "id": id, "value": value}
}

// ExtensionUIConfirmed answers a confirm dialog.
func ExtensionUIConfirmed(id string, confirmed bool) Command {
	return Command{"type": "extension_ui_response", "id": id, "confirmed": confirmed}
}

// ExtensionUICancelled dismisses a dialog.
func ExtensionUICancelled(id string) Command {
	return Command{"type": "extension_ui_response", "id": id, "cancelled": true}
}

// State is the get_state payload.
type State struct {
	Model                 *ModelInfo `json:"model"`
	ThinkingLevel         string     `json:"thinkingLevel"`
	IsStreaming           bool       `json:"isStreaming"`
	IsCompacting          bool       `json:"isCompacting"`
	SteeringMode          string     `json:"steeringMode"`
	FollowUpMode          string     `json:"followUpMode"`
	SessionFile           string     `json:"sessionFile"`
	SessionID             string     `json:"sessionId"`
	SessionName           string     `json:"sessionName"`
	AutoCompactionEnabled bool       `json:"autoCompactionEnabled"`
	MessageCount          int        `json:"messageCount"`
	PendingMessageCount   int        `json:"pendingMessageCount"`
}

// ModelInfo is one configured model.
type ModelInfo struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	API           string    `json:"api"`
	Provider      string    `json:"provider"`
	BaseURL       string    `json:"baseUrl"`
	Reasoning     bool      `json:"reasoning"`
	Input         []string  `json:"input"`
	ContextWindow int       `json:"contextWindow"`
	MaxTokens     int       `json:"maxTokens"`
	Cost          ModelCost `json:"cost"`
}

// ModelCost is per-million-token pricing in US dollars.
type ModelCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

// Label renders a stable "provider/model" identifier for pickers.
func (m ModelInfo) Label() string {
	if m.Provider == "" {
		return m.ID
	}
	return m.Provider + "/" + m.ID
}

// ModelsPayload is the get_available_models payload.
type ModelsPayload struct {
	Models []ModelInfo `json:"models"`
}

// ThinkingLevelsPayload is the get_available_thinking_levels payload.
type ThinkingLevelsPayload struct {
	Levels []string `json:"levels"`
}

// MessagesPayload is the get_messages payload.
type MessagesPayload struct {
	Messages []Message `json:"messages"`
}

// SessionStats is the get_session_stats payload.
type SessionStats struct {
	SessionFile       string        `json:"sessionFile"`
	SessionID         string        `json:"sessionId"`
	UserMessages      int           `json:"userMessages"`
	AssistantMessages int           `json:"assistantMessages"`
	ToolCalls         int           `json:"toolCalls"`
	ToolResults       int           `json:"toolResults"`
	TotalMessages     int           `json:"totalMessages"`
	Tokens            TokenTotals   `json:"tokens"`
	Cost              float64       `json:"cost"`
	ContextUsage      *ContextUsage `json:"contextUsage,omitempty"`
}

// TokenTotals is cumulative token usage.
type TokenTotals struct {
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cacheRead"`
	CacheWrite int `json:"cacheWrite"`
	Total      int `json:"total"`
}

// ContextUsage describes how full the context window is.
type ContextUsage struct {
	Tokens        int     `json:"tokens"`
	ContextWindow int     `json:"contextWindow"`
	Percent       float64 `json:"percent"`
}

// CommandInfo is one discoverable slash command.
type CommandInfo struct {
	Name        string             `json:"name"`
	Description string             `json:"description"`
	Source      string             `json:"source"`
	SourceInfo  *CommandSourceInfo `json:"sourceInfo,omitempty"`
}

// CommandSourceInfo describes where a command came from.
type CommandSourceInfo struct {
	Path   string `json:"path"`
	Source string `json:"source"`
	Scope  string `json:"scope"`
	Origin string `json:"origin"`
}

// CommandsPayload is the get_commands payload.
type CommandsPayload struct {
	Commands []CommandInfo `json:"commands"`
}

// BashResult is the bash payload.
type BashResult struct {
	Output         string `json:"output"`
	ExitCode       int    `json:"exitCode"`
	Cancelled      bool   `json:"cancelled"`
	Truncated      bool   `json:"truncated"`
	FullOutputPath string `json:"fullOutputPath,omitempty"`
}

// ExportPayload is the export_html payload.
type ExportPayload struct {
	Path string `json:"path"`
}

// SessionChangePayload reports a canceled or completed session switch.
type SessionChangePayload struct {
	Cancelled bool `json:"cancelled"`
}

// ForkPayload reports the forked-from text.
type ForkPayload struct {
	Text      string `json:"text"`
	Cancelled bool   `json:"cancelled"`
}

// DecodeTyped decodes a response payload into T.
func DecodeTyped[T any](response *Response) (T, error) {
	var zero T
	if response == nil {
		return zero, nil
	}
	if len(response.Data) == 0 || string(response.Data) == "null" {
		return zero, nil
	}
	if err := json.Unmarshal(response.Data, &zero); err != nil {
		return zero, err
	}
	return zero, nil
}
