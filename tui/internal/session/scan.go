// Package session inspects pi's session directory so the client can offer a
// resume picker. It reads session files but never writes them: pi owns that
// storage.
package session

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/lihaozhe013/pie/tui/internal/config"
)

// Entry is one resumable session file.
type Entry struct {
	// Path is the absolute path of the .jsonl session file.
	Path string
	// ID is the session UUID from the header.
	ID string
	// CWD is the working directory the session was created in.
	CWD string
	// Name is the display name from the newest session_info entry, if any.
	Name string
	// FirstMessage is the first user prompt, used as a label before a name
	// exists, as Pie's session list does.
	FirstMessage string
	// Modified is the file modification time.
	Modified time.Time
	// Size is the file size in bytes.
	Size int64
}

// Label renders a picker title: the session name, else the first prompt, else
// a short ID.
func (e Entry) Label() string {
	if e.Name != "" {
		return e.Name
	}
	if e.FirstMessage != "" {
		return e.FirstMessage
	}
	if len(e.ID) >= 8 {
		return "session " + e.ID[:8]
	}
	return "session " + e.ID
}

const (
	// DefaultDirEnv overrides the session directory.
	DefaultDirEnv = "PI_CODING_AGENT_SESSION_DIR"
	// headerLimit caps the header JSON we read from a session file.
	headerLimit = 1 << 20
	// firstMessageLimit bounds the prefix scanned for the first prompt.
	firstMessageLimit = 64 << 10
	// nameChunk is the backward read size used to find the newest name.
	nameChunk = 64 << 10
	// NamePartialLimit bounds the incomplete line retained between incremental
	// name-watch reads. A session_info record is short; this only protects
	// against a huge message line.
	NamePartialLimit = 64 << 10
)

// Dir resolves the session directory. Precedence matches pi: explicit
// override, then PI_CODING_AGENT_SESSION_DIR, then settings.json sessionDir
// (relative paths resolve from the working directory), then the agent
// directory's sessions folder.
func Dir(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if env := os.Getenv(DefaultDirEnv); env != "" {
		return env, nil
	}
	paths, err := config.ResolvePaths()
	if err != nil {
		return "", err
	}
	if settings, loadErr := config.LoadSettings(paths); loadErr == nil {
		if dir, ok, typeErr := settings.SessionDir(); typeErr == nil && ok {
			if filepath.IsAbs(dir) {
				return dir, nil
			}
			wd, wdErr := os.Getwd()
			if wdErr != nil {
				return "", fmt.Errorf("resolve sessionDir %q: %w", dir, wdErr)
			}
			return filepath.Join(wd, dir), nil
		}
	}
	return paths.Sessions(), nil
}

// List returns the most recently modified sessions, newest first.
//
// Unreadable or malformed session files are skipped: a single corrupt file must
// not break the resume picker.
func List(dir string, limit int) ([]Entry, error) {
	root, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}

	var entries []Entry
	for _, project := range root {
		if !project.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(dir, project.Name()))
		if err != nil {
			continue
		}
		for _, file := range files {
			if file.IsDir() || !strings.HasSuffix(file.Name(), ".jsonl") {
				continue
			}
			path := filepath.Join(dir, project.Name(), file.Name())
			entry, err := readEntry(path)
			if err != nil {
				continue
			}
			entries = append(entries, entry)
		}
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Modified.After(entries[j].Modified)
	})
	if limit > 0 && len(entries) > limit {
		entries = entries[:limit]
	}
	return entries, nil
}

// canonicalDir resolves symlinks so /tmp and /private/tmp compare equal, as
// pi canonicalizes session headers and Pie groups by them.
func canonicalDir(path string) string {
	if path == "" {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return filepath.Clean(resolved)
	}
	if absolute, err := filepath.Abs(path); err == nil {
		return filepath.Clean(absolute)
	}
	return filepath.Clean(path)
}

// ListForCWD keeps only sessions created in cwd.
func ListForCWD(dir, cwd string, limit int) ([]Entry, error) {
	all, err := List(dir, 0)
	if err != nil {
		return nil, err
	}
	if cwd == "" {
		return all, nil
	}
	clean := canonicalDir(cwd)
	matched := all[:0]
	for _, entry := range all {
		if entry.CWD == "" || canonicalDir(entry.CWD) == clean {
			matched = append(matched, entry)
		}
	}
	if limit > 0 && len(matched) > limit {
		matched = matched[:limit]
	}
	return matched, nil
}

type header struct {
	Type      string `json:"type"`
	Version   int    `json:"version"`
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	CWD       string `json:"cwd"`
}

func readEntry(path string) (Entry, error) {
	info, err := os.Stat(path)
	if err != nil {
		return Entry{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return Entry{}, err
	}
	defer file.Close()

	line, err := bufio.NewReaderSize(io.LimitReader(file, headerLimit), 64*1024).ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return Entry{}, err
	}
	var head header
	if err := json.Unmarshal(line, &head); err != nil {
		return Entry{}, fmt.Errorf("parse header: %w", err)
	}
	if head.Type != "session" || head.ID == "" {
		return Entry{}, errors.New("not a session header")
	}

	return Entry{
		Path:         path,
		ID:           head.ID,
		CWD:          head.CWD,
		Name:         readName(file, info.Size()),
		FirstMessage: readFirstMessage(file, info.Size()),
		Modified:     info.ModTime(),
		Size:         info.Size(),
	}, nil
}

// readFirstMessage finds the first user prompt near the start of the file.
// Reading a bounded prefix keeps a large session cheap to list.
func readFirstMessage(file *os.File, size int64) string {
	length := size
	if length > firstMessageLimit {
		length = firstMessageLimit
	}
	if length <= 0 {
		return ""
	}
	buf := make([]byte, length)
	if _, err := file.ReadAt(buf, 0); err != nil && !errors.Is(err, io.EOF) {
		return ""
	}
	lines := strings.Split(string(buf), "\n")
	for index, line := range lines {
		if index == 0 || !strings.Contains(line, `"message"`) {
			continue
		}
		var record struct {
			Type    string `json:"type"`
			Message struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal([]byte(line), &record); err != nil || record.Type != "message" {
			continue
		}
		if record.Message.Role != "user" {
			continue
		}
		if text := messageText(record.Message.Content); text != "" {
			return truncateLabel(text, 60)
		}
	}
	return ""
}

func messageText(raw json.RawMessage) string {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return strings.Join(strings.Fields(text), " ")
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	var parts []string
	for _, block := range blocks {
		if block.Type == "text" && strings.TrimSpace(block.Text) != "" {
			parts = append(parts, block.Text)
		}
	}
	return strings.Join(strings.Fields(strings.Join(parts, " ")), " ")
}

func truncateLabel(text string, limit int) string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) <= limit {
		return string(runes)
	}
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}

// ParseNameChunk returns the newest session_info name among the complete
// lines in data. The bytes after the last newline are returned as partial so
// an incremental caller can prepend them to the next read. found is false
// when the chunk held no session_info record.
func ParseNameChunk(data []byte) (name string, found bool, partial []byte) {
	last := bytes.LastIndexByte(data, '\n')
	if last < 0 {
		return "", false, append([]byte(nil), data...)
	}
	for _, line := range strings.Split(string(data[:last]), "\n") {
		if value, ok := parseSessionNameLine(line); ok {
			name, found = value, true
		}
	}
	return name, found, append([]byte(nil), data[last+1:]...)
}

// readName finds the newest session_info entry by reading the file backwards
// in chunks. A fixed tail probe is not enough: an auto-generated name is
// written early in a session, and a long conversation can push it megabytes
// away from the end. Scanning stops at the first entry found, so the common
// case only reads one chunk.
func readName(file *os.File, size int64) string {
	name, _ := readNameFound(file, size)
	return name
}

// readNameFound is readName with a found flag: an absent name and a deliberate
// clear both return an empty string, but only the clear is a match.
func readNameFound(file *os.File, size int64) (string, bool) {
	if size <= 0 {
		return "", false
	}

	var pending []byte
	offset := size
	for offset > 0 {
		n := int64(nameChunk)
		if offset < n {
			n = offset
		}
		offset -= n
		buf := make([]byte, n)
		if _, err := file.ReadAt(buf, offset); err != nil && !errors.Is(err, io.EOF) {
			return "", false
		}

		data := buf
		if len(pending) > 0 {
			data = append(buf, pending...)
		}
		lines := strings.Split(string(data), "\n")
		start := 0
		if offset > 0 {
			// The first line may begin before this chunk.
			start = 1
		}
		for i := len(lines) - 1; i >= start; i-- {
			if name, ok := parseSessionNameLine(lines[i]); ok {
				return name, true
			}
		}
		if offset > 0 {
			pending = []byte(lines[0])
		} else {
			pending = nil
		}
	}
	return "", false
}

// LatestName reads the newest session_info name from path and reports the file
// size that was scanned, so a caller can continue incrementally from there.
// A found record with an empty name is a deliberate clear.
func LatestName(path string) (name string, found bool, size int64, err error) {
	file, err := os.Open(path)
	if err != nil {
		return "", false, 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", false, 0, err
	}
	name, found = readNameFound(file, info.Size())
	return name, found, info.Size(), nil
}

// parseSessionNameLine parses one JSONL record and reports whether it is a
// session_info entry. A null or missing name is a deliberate clear, so it
// still counts as a match and stops the backward scan.
func parseSessionNameLine(line string) (string, bool) {
	line = strings.TrimSuffix(line, "\r")
	if !strings.Contains(line, `"session_info"`) {
		return "", false
	}
	var info struct {
		Type string  `json:"type"`
		Name *string `json:"name"`
	}
	if err := json.Unmarshal([]byte(line), &info); err != nil || info.Type != "session_info" {
		return "", false
	}
	if info.Name == nil {
		return "", true
	}
	return strings.TrimSpace(*info.Name), true
}
