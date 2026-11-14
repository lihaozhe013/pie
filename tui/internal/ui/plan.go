package ui

import (
	"io"
	"os"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

const maxPlanDisplayBytes = 2 << 20

type planMsg struct {
	path      string
	text      string
	truncated bool
	err       error
}

// openPlan reads the session's plan file into the client's read-only viewer.
// The file is authoritative; this view never writes it.
func (m *Model) openPlan() tea.Cmd {
	if !m.hasPlan || strings.TrimSpace(m.plan.Path) == "" {
		m.setToast("no plan file yet; press shift+tab to enter plan mode")
		return nil
	}
	path := m.plan.Path
	if !planPathAllowed(m.paths.Dir, path) {
		m.setToast("plan file is outside the agent plan directory")
		return nil
	}
	return func() tea.Msg {
		file, err := os.Open(path)
		if err != nil {
			return planMsg{path: path, err: err}
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, maxPlanDisplayBytes+1))
		if err != nil {
			return planMsg{path: path, err: err}
		}
		truncated := len(data) > maxPlanDisplayBytes
		if truncated {
			data = data[:maxPlanDisplayBytes]
		}
		return planMsg{path: path, text: string(data), truncated: truncated}
	}
}

func (m *Model) applyPlanMsg(msg planMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.addError("plan: " + msg.err.Error())
		return m, nil
	}
	if strings.TrimSpace(msg.text) == "" {
		m.setToast("the plan file is empty")
		return m, nil
	}
	if msg.truncated {
		m.setToast("plan file truncated for display")
	}
	viewer := newViewerOverlay(planViewerTitle(msg.text), msg.text)
	viewer.returnTo = m.overlay
	m.openOverlay(viewer)
	return m, nil
}

// planPathAllowed accepts only a regular file below <agentDir>/pie-plans.
// The session log is user data, so its path is checked before it is read.
func planPathAllowed(agentDir, path string) bool {
	dir := filepath.Join(agentDir, "pie-plans")
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		realDir, err = filepath.Abs(dir)
		if err != nil {
			return false
		}
	}
	realPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		realPath, err = filepath.Abs(path)
		if err != nil {
			return false
		}
	}
	rel, err := filepath.Rel(realDir, realPath)
	if err != nil || rel == "" || rel == "." || rel == ".." || filepath.IsAbs(rel) {
		return false
	}
	return !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

func planViewerTitle(text string) string {
	title := "Plan"
	status := ""
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if title == "Plan" && strings.HasPrefix(trimmed, "# ") {
			title = strings.TrimSpace(strings.TrimPrefix(trimmed, "# "))
		}
		lower := strings.ToLower(trimmed)
		if strings.HasPrefix(lower, "status:") {
			status = strings.TrimSpace(trimmed[len("status:"):])
		}
	}
	if status != "" {
		return title + " · " + status
	}
	return title
}
