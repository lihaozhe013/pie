package session

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Delete removes one session file and re-parents the forks that recorded it as
// their origin, matching what the Web UI does when it deletes a conversation.
//
// Only a file with a pi session header is deleted: a bad path fails instead of
// removing something else. The caller owns the running session, so it must not
// pass the file pi currently has open.
func Delete(path string) error {
	clean := filepath.Clean(path)
	if !strings.HasSuffix(clean, ".jsonl") {
		return fmt.Errorf("refusing to delete %q: not a session file", path)
	}

	parent, err := sessionParent(clean)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read session header: %w", err)
	}

	// Re-parent before unlinking so an interrupted delete cannot leave the
	// children pointing at nothing while the parent is already gone.
	reparentChildren(filepath.Dir(clean), clean, parent)

	if err := os.Remove(clean); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// sessionParent reads the parentSession recorded in a session header. It is
// empty for a session that was not forked from another file.
func sessionParent(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	line, err := bufio.NewReaderSize(io.LimitReader(file, headerLimit), 64*1024).ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	var head struct {
		Type          string `json:"type"`
		ParentSession string `json:"parentSession"`
	}
	if err := json.Unmarshal(line, &head); err != nil {
		return "", fmt.Errorf("parse header: %w", err)
	}
	if head.Type != "session" {
		return "", errors.New("not a session header")
	}
	return head.ParentSession, nil
}

// reparentChildren rewrites every session in dir that records deleted as its
// origin. A child that cannot be read or rewritten is skipped: a broken sibling
// must never stop the deletion the user asked for. The parent argument is the
// deleted session's own parent, empty when it had none.
func reparentChildren(dir, deleted, parent string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	target := canonicalDir(deleted)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		child := filepath.Join(dir, entry.Name())
		if canonicalDir(child) == target {
			continue
		}
		childParent, err := sessionParent(child)
		if err != nil || childParent == "" || canonicalDir(childParent) != target {
			continue
		}
		_ = rewriteSessionParent(child, parent)
	}
}

// rewriteSessionParent replaces the parentSession field of one session header
// and leaves every other byte of the file alone. The header is re-marshaled
// from its raw fields, so unknown keys survive even though their order may not.
func rewriteSessionParent(path, parent string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	line, err := bufio.NewReaderSize(io.LimitReader(file, headerLimit), 64*1024).ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(line, &fields); err != nil {
		return fmt.Errorf("parse header: %w", err)
	}
	if string(fields["type"]) != `"session"` {
		return errors.New("not a session header")
	}
	if parent == "" {
		// A fork whose origin is gone becomes a plain session, the way the Web
		// UI drops the key instead of writing a dangling path.
		delete(fields, "parentSession")
	} else {
		encoded, err := json.Marshal(parent)
		if err != nil {
			return err
		}
		fields["parentSession"] = encoded
	}
	header, err := json.Marshal(fields)
	if err != nil {
		return err
	}

	// The header reader may have buffered past the first line, so seek to the
	// known header length before copying the rest of the conversation.
	if _, err := file.Seek(int64(len(line)), io.SeekStart); err != nil {
		return err
	}
	rest, err := io.ReadAll(file)
	if err != nil {
		return err
	}

	// Write a sibling temporary file and rename it over the session, so an
	// interrupted rewrite cannot truncate a conversation.
	temp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer func() { _ = os.Remove(tempName) }()
	if err := temp.Chmod(info.Mode().Perm()); err != nil {
		_ = temp.Close()
		return err
	}
	body := make([]byte, 0, len(header)+1+len(rest))
	body = append(append(append(body, header...), '\n'), rest...)
	if _, err := temp.Write(body); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, path)
}
