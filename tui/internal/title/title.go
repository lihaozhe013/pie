// Package title generates a session title from a transcript, mirroring the
// web UI: a one-shot request with a short system prompt, no tools, and bounded
// transcript text.
package title

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/lihaozhe013/pie/tui/internal/modelcatalog"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

const (
	// Timeout bounds the one-shot model call.
	Timeout = 90 * time.Second
	// MaxLength caps the saved title in characters.
	MaxLength = 80

	userChars          = 800
	assistantChars     = 300
	lastAssistantChars = 600
	summaryChars       = 600
	transcriptChars    = 6000
	transcriptHead     = 2400

	elision          = "[…]"
	imagePlaceholder = "[image]"
)

// SystemPrompt is the one-line instruction for the title model.
const SystemPrompt = "You name chat sessions from a transcript. Reply with the title only."

// Prompt asks for the title itself.
const Prompt = `Create a concise title for this session based on the conversation above.

Requirements:
- Match the primary language used by the user.
- Describe the user's concrete goal or the outcome, not the act of chatting.
- Use 4-12 words for space-separated languages, or 8-24 characters for CJK text when practical.
- Do not call any tools.
- Return only the title as plain text, with no quotes, label, markdown, or explanation.`

// Transcript flattens session messages into the bounded plain text the title
// model reads. Tool calls and results are dropped; they say nothing about the
// goal and dominate the token count.
func Transcript(messages []rpc.Message) string {
	lastAssistant := -1
	for i, message := range messages {
		if message.Role == "assistant" && contentText(message.Content) != "" {
			lastAssistant = i
		}
	}

	lines := make([]string, 0, len(messages))
	for i, message := range messages {
		switch message.Role {
		case "user":
			text := contentText(message.Content)
			if text == "" {
				continue
			}
			lines = append(lines, "User: "+clip(text, userChars))
		case "assistant":
			text := contentText(message.Content)
			if text == "" {
				continue
			}
			limit := assistantChars
			if i == lastAssistant {
				limit = lastAssistantChars
			}
			lines = append(lines, "Assistant: "+clip(text, limit))
		case "compactionSummary", "branchSummary":
			text := strings.TrimSpace(message.Text())
			if text == "" {
				continue
			}
			lines = append(lines, "[Earlier summary] "+clip(text, summaryChars))
		}
	}
	return bound(lines)
}

// contentText keeps text blocks and represents images with a marker.
func contentText(content rpc.Content) string {
	var parts []string
	images := 0
	for _, block := range content {
		switch block.Type {
		case "text":
			if block.Text != "" {
				parts = append(parts, block.Text)
			}
		case "image":
			images++
		}
	}
	text := strings.TrimSpace(strings.Join(parts, "\n"))
	if images == 0 {
		return text
	}
	marker := imagePlaceholder
	if images > 1 {
		marker = fmt.Sprintf("%s ×%d", imagePlaceholder, images)
	}
	if text == "" {
		return marker
	}
	return text + "\n" + marker
}

func clip(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}

// bound keeps both ends of a long transcript: the opening turns state the
// goal, the newest turns state the outcome, and the middle only adds cost.
func bound(lines []string) string {
	joined := strings.Join(lines, "\n\n")
	if utf8.RuneCountInString(joined) <= transcriptChars || len(lines) < 2 {
		return joined
	}

	head := make([]string, 0, len(lines))
	used := len([]rune(elision)) + 4
	next := 0
	for ; next < len(lines); next++ {
		size := used + utf8.RuneCountInString(lines[next]) + 2
		if len(head) > 0 && size > transcriptHead {
			break
		}
		head = append(head, lines[next])
		used = size
	}

	tail := make([]string, 0, len(lines))
	for i := len(lines) - 1; i >= next; i-- {
		size := used + utf8.RuneCountInString(lines[i]) + 2
		if size > transcriptChars {
			break
		}
		tail = append([]string{lines[i]}, tail...)
		used = size
	}

	if next+len(tail) >= len(lines) {
		return joined
	}
	out := append(append([]string{}, head...), elision)
	out = append(out, tail...)
	return strings.Join(out, "\n\n")
}

// ResolveThinkingLevel picks the cheapest level the model supports. Naming is a
// short classification task, so reasoning only adds latency and tokens.
func ResolveThinkingLevel(model *modelcatalog.Model) string {
	if model == nil || !model.Reasoning {
		return "off"
	}
	supported := make([]string, 0, 7)
	for _, level := range []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"} {
		if model.SupportsThinkingLevel(level) {
			supported = append(supported, level)
		}
	}
	rejectsMinimal := model.API == "google-generative-ai" || strings.Contains(strings.ToLower(model.ID), "gemini")
	if rejectsMinimal {
		filtered := supported[:0]
		for _, level := range supported {
			if level != "off" && level != "minimal" {
				filtered = append(filtered, level)
			}
		}
		supported = filtered
	}
	if len(supported) > 0 {
		return supported[0]
	}
	return "off"
}

var (
	fencedTitle = regexp.MustCompile(`(?s)^` + "```" + `(?:json|text)?\s*(.*?)\s*` + "```" + `$`)
	titlePrefix = regexp.MustCompile(`(?i)^(?:session\s+title|title|标题)\s*[:：-]\s*`)
)

// Parse extracts a usable title from the model's raw reply.
func Parse(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if match := fencedTitle.FindStringSubmatch(value); match != nil {
		value = strings.TrimSpace(match[1])
	}
	if strings.HasPrefix(value, "{") {
		var parsed struct {
			Title string `json:"title"`
		}
		if err := json.Unmarshal([]byte(value), &parsed); err == nil && parsed.Title != "" {
			value = strings.TrimSpace(parsed.Title)
		}
	}

	if index := strings.IndexAny(value, "\r\n"); index >= 0 {
		value = value[:index]
	}
	value = titlePrefix.ReplaceAllString(value, "")
	value = stripWrappingQuotes(value)
	value = strings.Join(strings.Fields(value), " ")
	value = strings.TrimRight(value, "。.!！？?")

	usable := false
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			usable = true
			break
		}
	}
	if !usable {
		return "", fmt.Errorf("the model did not return a usable session title")
	}

	runes := []rune(value)
	if len(runes) > MaxLength {
		value = strings.TrimSpace(string(runes[:MaxLength]))
	}
	return value, nil
}

func stripWrappingQuotes(value string) string {
	pairs := [][2]string{
		{`"`, `"`},
		{"'", "'"},
		{"`", "`"},
		{"“", "”"},
		{"「", "」"},
		{"『", "』"},
	}
	value = strings.TrimSpace(value)
	for _, pair := range pairs {
		if strings.HasPrefix(value, pair[0]) && strings.HasSuffix(value, pair[1]) &&
			utf8.RuneCountInString(value) > utf8.RuneCountInString(pair[0]+pair[1]) {
			return strings.TrimSpace(value[len(pair[0]) : len(value)-len(pair[1])])
		}
	}
	return value
}

// Options configures a one-shot title request.
type Options struct {
	PiBin    string
	Model    string // provider/model
	Thinking string
}

// Generate runs `pi --print` with the transcript and returns the parsed title.
func Generate(ctx context.Context, opts Options, transcript string) (string, error) {
	if strings.TrimSpace(transcript) == "" {
		return "", fmt.Errorf("nothing to title yet")
	}
	bin := opts.PiBin
	if bin == "" {
		bin = "pi"
	}
	args := []string{
		"--print",
		"--no-session",
		"--no-tools",
		"--no-mcp",
		"--no-context-files",
		"--no-skills",
		"--system-prompt", SystemPrompt,
	}
	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
	}
	if opts.Thinking != "" && opts.Thinking != "off" {
		args = append(args, "--thinking", opts.Thinking)
	}
	args = append(args, "--", transcript+"\n\n"+Prompt)

	command := exec.CommandContext(ctx, bin, args...)
	output, err := command.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			message := strings.TrimSpace(string(exitErr.Stderr))
			if message != "" {
				return "", fmt.Errorf("title request failed: %s", message)
			}
		}
		return "", fmt.Errorf("title request failed: %w", err)
	}
	return Parse(string(output))
}
