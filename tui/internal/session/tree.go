package session

import (
	"encoding/json"
	"strings"
)

// TreeNode is one session entry with its children.
type TreeNode struct {
	ID       string
	ParentID string
	Type     string
	// Label summarizes the entry: a message's role and text, a session name,
	// a custom type, or the raw entry type.
	Label    string
	Children []TreeNode
}

// Tree is the parsed get_tree payload.
type Tree struct {
	Roots  []TreeNode
	LeafID string
}

type rawTree struct {
	Tree   []rawTreeNode `json:"tree"`
	LeafID string        `json:"leafId"`
}

type rawTreeNode struct {
	Entry    json.RawMessage `json:"entry"`
	Children []rawTreeNode   `json:"children"`
	Label    string          `json:"label"`
}

type rawEntry struct {
	ID         string          `json:"id"`
	ParentID   string          `json:"parentId"`
	Type       string          `json:"type"`
	CustomType string          `json:"customType"`
	Name       *string         `json:"name"`
	Message    json.RawMessage `json:"message"`
	Summary    string          `json:"summary"`
	Content    json.RawMessage `json:"content"`
}

// ParseTree flattens the raw tree into labels the panel can show. Unreadable
// entries are skipped rather than failing the whole tree.
func ParseTree(data json.RawMessage) (Tree, error) {
	var raw rawTree
	if err := json.Unmarshal(data, &raw); err != nil {
		return Tree{}, err
	}
	tree := Tree{LeafID: raw.LeafID}
	for _, node := range raw.Tree {
		if parsed, ok := parseNode(node); ok {
			tree.Roots = append(tree.Roots, parsed)
		}
	}
	return tree, nil
}

func parseNode(node rawTreeNode) (TreeNode, bool) {
	var entry rawEntry
	if err := json.Unmarshal(node.Entry, &entry); err != nil || entry.ID == "" {
		return TreeNode{}, false
	}
	parsed := TreeNode{
		ID:       entry.ID,
		ParentID: entry.ParentID,
		Type:     entry.Type,
		Label:    entryLabel(entry),
	}
	if node.Label != "" {
		parsed.Label = node.Label
	}
	for _, child := range node.Children {
		if parsedChild, ok := parseNode(child); ok {
			parsed.Children = append(parsed.Children, parsedChild)
		}
	}
	return parsed, true
}

func entryLabel(entry rawEntry) string {
	switch entry.Type {
	case "message":
		var message struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(entry.Message, &message); err == nil {
			text := contentText(message.Content)
			if text != "" {
				return message.Role + ": " + clip(text, 100)
			}
			return message.Role
		}
		return "message"
	case "session_info":
		if entry.Name != nil {
			return "name: " + *entry.Name
		}
		return "session info"
	case "custom":
		if entry.CustomType != "" {
			return entry.CustomType
		}
		return "custom"
	case "compaction":
		return "compaction"
	case "branch_summary":
		return "branch summary"
	default:
		if entry.Type != "" {
			return entry.Type
		}
		return "entry"
	}
}

func contentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return strings.TrimSpace(text)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if block.Type == "text" && block.Text != "" {
			parts = append(parts, block.Text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, " "))
}

func clip(text string, limit int) string {
	runes := []rune(strings.Join(strings.Fields(text), " "))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit]) + "…"
}
