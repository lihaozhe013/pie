package session

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
)

// SearchHit is one session that matches a query in its name, directory, or
// transcript.
type SearchHit struct {
	Entry
	Snippet string
	Matches int
}

const (
	searchFileLimit = 200
	searchMaxBytes  = 8 << 20
	snippetBefore   = 60
	snippetAfter    = 120
)

// Search scans the newest sessions for a case-insensitive query. A session's
// name and directory are checked first; the transcript scan extracts the
// matching string values so the snippet reads as text, not JSON.
func Search(dir, query string, limit int) ([]SearchHit, error) {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return nil, nil
	}
	entries, err := List(dir, searchFileLimit)
	if err != nil {
		return nil, err
	}
	hits := make([]SearchHit, 0, limit)
	for _, entry := range entries {
		hit := SearchHit{Entry: entry}
		if strings.Contains(strings.ToLower(entry.Name), query) || strings.Contains(strings.ToLower(entry.CWD), query) {
			hit.Matches = 1
			hit.Snippet = entry.Label()
		}
		if snippet, matches := searchFile(entry.Path, query); matches > 0 {
			hit.Matches += matches
			if hit.Snippet == "" {
				hit.Snippet = snippet
			}
		}
		if hit.Matches == 0 {
			continue
		}
		hits = append(hits, hit)
		if limit > 0 && len(hits) >= limit {
			break
		}
	}
	return hits, nil
}

func searchFile(path, query string) (string, int) {
	info, err := os.Stat(path)
	if err != nil || info.Size() > searchMaxBytes {
		return "", 0
	}
	file, err := os.Open(path)
	if err != nil {
		return "", 0
	}
	defer file.Close()

	snippet := ""
	count := 0
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if !strings.Contains(strings.ToLower(string(line)), query) {
			continue
		}
		count++
		if snippet != "" {
			continue
		}
		if text := matchingText(line, query); text != "" {
			snippet = clipSnippet(text, query)
		}
	}
	return snippet, count
}

// matchingText walks the JSON line and returns the first string containing the
// query, which is normally a message's text or a tool result.
func matchingText(line []byte, query string) string {
	var value any
	if err := json.Unmarshal(line, &value); err != nil {
		return ""
	}
	var found string
	var walk func(any) bool
	walk = func(node any) bool {
		switch typed := node.(type) {
		case string:
			if strings.Contains(strings.ToLower(typed), query) {
				found = typed
				return true
			}
		case []any:
			for _, item := range typed {
				if walk(item) {
					return true
				}
			}
		case map[string]any:
			for _, key := range []string{"message", "content", "text", "thinking", "summary", "input"} {
				if child, ok := typed[key]; ok && walk(child) {
					return true
				}
			}
		}
		return false
	}
	walk(value)
	return found
}

func clipSnippet(text, query string) string {
	text = strings.Join(strings.Fields(text), " ")
	index := strings.Index(strings.ToLower(text), query)
	if index < 0 {
		if len(text) > snippetAfter {
			return text[:snippetAfter] + "…"
		}
		return text
	}
	start := index - snippetBefore
	if start < 0 {
		start = 0
	}
	end := index + len(query) + snippetAfter
	if end > len(text) {
		end = len(text)
	}
	out := text[start:end]
	if start > 0 {
		out = "…" + out
	}
	if end < len(text) {
		out += "…"
	}
	return out
}
