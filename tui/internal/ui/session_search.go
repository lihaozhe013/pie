package ui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/lihaozhe013/pie/tui/internal/session"
)

type sessionSearchMsg struct {
	query string
	hits  []session.SearchHit
	err   error
}

// searchSessions scans names, directories, and transcripts for a query, then
// offers the hits as resumable sessions.
func (m *Model) searchSessions(query string) tea.Cmd {
	query = strings.TrimSpace(query)
	if query == "" {
		m.setToast("a search query is required")
		return nil
	}
	dir := m.opts.SessionDir
	return func() tea.Msg {
		resolved, err := session.Dir(dir)
		if err != nil {
			return sessionSearchMsg{query: query, err: err}
		}
		hits, err := session.Search(resolved, query, 30)
		return sessionSearchMsg{query: query, hits: hits, err: err}
	}
}

func (m *Model) applySessionSearch(msg sessionSearchMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.addError("search: " + msg.err.Error())
		return m, nil
	}
	if len(msg.hits) == 0 {
		m.setToast("no sessions match " + msg.query)
		return m, nil
	}
	items := make([]pickerItem, 0, len(msg.hits))
	for _, hit := range msg.hits {
		detail := fmt.Sprintf("%s · %d match(es)", shortenPath(hit.CWD), hit.Matches)
		if hit.Snippet != "" {
			detail += " · " + hit.Snippet
		}
		items = append(items, pickerItem{
			Value:  hit.Path,
			Label:  hit.Label(),
			Detail: detail,
		})
	}
	m.openOverlay(newPickerOverlay("session-search-hit", "Search · "+msg.query, items))
	return m, nil
}
