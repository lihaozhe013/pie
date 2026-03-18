package ui

import (
	"strings"
)

// toolSummary is the one-line argument preview of a tool call.
func toolSummary(name string, args map[string]any) string {
	if args == nil {
		return ""
	}
	pick := func(keys ...string) string {
		for _, key := range keys {
			if value, ok := args[key].(string); ok && value != "" {
				return value
			}
		}
		return ""
	}

	summary := pick("command", "path", "file_path", "pattern", "query", "url", "name", "description")
	if summary == "" {
		return ""
	}
	summary = strings.ReplaceAll(summary, "\n", " ")
	if len([]rune(summary)) > 80 {
		summary = string([]rune(summary)[:77]) + "…"
	}
	return summary
}

// toolPathKeys are the argument names under which a coding tool names the file
// it works on. The list mirrors Pie's web UI so both clients colour the same
// calls.
var toolPathKeys = []string{
	"path",
	"file_path",
	"filePath",
	"filepath",
	"absolute_path",
	"target_file",
	"notebook_path",
	"filename",
	"fileName",
	"file",
}

// toolArgPath is the file a coding tool's arguments name, if they name one.
func toolArgPath(args map[string]any) string {
	for _, key := range toolPathKeys {
		if value, ok := args[key].(string); ok && value != "" {
			return value
		}
	}
	return ""
}

// diffPair is one old/new text replacement of an edit tool call.
type diffPair struct {
	Old string
	New string
}

// toolDiff extracts a renderable diff from a tool call.
//
// Current pi edit calls carry `edits: [{oldText, newText}]`; older sessions use
// top-level oldText/newText, which the docs still ask clients to accept. write
// calls carry the full file content and diff as pure additions.
func toolDiff(name string, args map[string]any) (string, []diffPair, bool) {
	if args == nil {
		return "", nil, false
	}
	path := toolArgPath(args)

	switch name {
	case "write", "create":
		content, ok := args["content"].(string)
		if !ok {
			return path, nil, false
		}
		return path, []diffPair{{New: content}}, true
	case "edit", "multi_edit", "patch":
		var pairs []diffPair
		if rawEdits, ok := args["edits"].([]any); ok {
			for _, raw := range rawEdits {
				edit, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				oldText, _ := edit["oldText"].(string)
				newText, _ := edit["newText"].(string)
				if oldText == "" && newText == "" {
					continue
				}
				pairs = append(pairs, diffPair{Old: oldText, New: newText})
			}
		}
		if len(pairs) == 0 {
			oldText, _ := args["oldText"].(string)
			newText, _ := args["newText"].(string)
			if oldText != "" || newText != "" {
				pairs = append(pairs, diffPair{Old: oldText, New: newText})
			}
		}
		if len(pairs) == 0 {
			return path, nil, false
		}
		return path, pairs, true
	default:
		return path, nil, false
	}
}

// diffLine is one line of a rendered diff.
type diffLine struct {
	kind   byte // ' ', '+', '-'
	number int
	text   string
}

// computeDiff produces a line diff with a small amount of context. It trims the
// common prefix and suffix, then reports the changed middle as removals followed
// by additions. That is exact for the replacement snippets edit tools emit and
// keeps the renderer dependency free.
func computeDiff(oldText, newText string, context int) []diffLine {
	oldLines := splitLines(oldText)
	newLines := splitLines(newText)

	prefix := 0
	for prefix < len(oldLines) && prefix < len(newLines) && oldLines[prefix] == newLines[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(oldLines)-prefix && suffix < len(newLines)-prefix &&
		oldLines[len(oldLines)-1-suffix] == newLines[len(newLines)-1-suffix] {
		suffix++
	}

	var out []diffLine
	start := prefix - context
	if start < 0 {
		start = 0
	}
	for i := start; i < prefix; i++ {
		out = append(out, diffLine{kind: ' ', number: i + 1, text: oldLines[i]})
	}
	for i := prefix; i < len(oldLines)-suffix; i++ {
		out = append(out, diffLine{kind: '-', number: i + 1, text: oldLines[i]})
	}
	for i := prefix; i < len(newLines)-suffix; i++ {
		out = append(out, diffLine{kind: '+', number: i + 1, text: newLines[i]})
	}
	tail := prefix + context
	for i := len(oldLines) - suffix; i < len(oldLines) && i < tail+suffix; i++ {
		out = append(out, diffLine{kind: ' ', number: i + 1, text: oldLines[i]})
	}
	return out
}

func splitLines(text string) []string {
	if text == "" {
		return nil
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.TrimSuffix(text, "\n")
	return strings.Split(text, "\n")
}

// diffStats counts added and removed lines.
func diffStats(pairs []diffPair) (added, removed int) {
	for _, pair := range pairs {
		lines := computeDiff(pair.Old, pair.New, 0)
		for _, line := range lines {
			switch line.kind {
			case '+':
				added++
			case '-':
				removed++
			}
		}
	}
	return added, removed
}
