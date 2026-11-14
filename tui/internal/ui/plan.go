package ui

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/rpc"
	"github.com/lihaozhe013/pie/tui/internal/session"
)

const (
	maxPlanDisplayBytes = 2 << 20
	// The bridge refuses to hash plans above 256 KiB because it reads them
	// with the same cap. Keep the approval gate aligned with that limit.
	maxPlanApproveBytes = 256 << 10
)

// planSnapshot is one read of the plan file. The revision exists only for a
// complete read; approving a truncated view would approve bytes the user did
// not see.
type planSnapshot struct {
	path      string
	text      string
	title     string
	status    string
	revision  string
	truncated bool
}

// artifactState carries the plan actions that are independent of the wrapped
// text in viewerState.
type artifactState struct {
	path      string
	revision  string
	status    string
	planMode  bool
	truncated bool
}

type planMsg struct {
	snapshot planSnapshot
	err      error
}

type planApprovalMsg struct {
	path      string
	selection string
	err       error
}

// openPlan reads the session's plan file into the artifact page. The file is
// authoritative; the page itself never writes it.
func (m *Model) openPlan() tea.Cmd {
	if !m.hasPlan || strings.TrimSpace(m.plan.Path) == "" {
		m.setToast("no plan file yet; press shift+tab to enter plan mode")
		return nil
	}
	path := m.plan.Path
	agentDir := m.paths.Dir
	if !planPathAllowed(agentDir, path) {
		m.setToast("plan file is outside the agent plan directory")
		return nil
	}
	return func() tea.Msg {
		snapshot, err := readPlanSnapshot(agentDir, path)
		return planMsg{snapshot: snapshot, err: err}
	}
}

// readPlanSnapshot is the one reader shared by the artifact and approval
// verification. It rejects paths outside pie-plans and hashes only complete
// reads.
func readPlanSnapshot(agentDir, path string) (planSnapshot, error) {
	if !planPathAllowed(agentDir, path) {
		return planSnapshot{}, fmt.Errorf("plan file is outside the agent plan directory")
	}
	file, err := os.Open(path)
	if err != nil {
		return planSnapshot{}, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxPlanDisplayBytes+1))
	if err != nil {
		return planSnapshot{}, err
	}
	truncated := len(data) > maxPlanDisplayBytes
	if truncated {
		data = data[:maxPlanDisplayBytes]
	}
	text := string(data)
	title, status := planHeader(text)
	snapshot := planSnapshot{
		path:      path,
		text:      text,
		title:     title,
		status:    status,
		truncated: truncated,
	}
	if !truncated && len(data) <= maxPlanApproveBytes {
		sum := sha256.Sum256(data)
		snapshot.revision = hex.EncodeToString(sum[:])
	}
	return snapshot, nil
}

func planHeader(text string) (title, status string) {
	title = "Plan"
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
	return title, status
}

func planArtifactTitle(snapshot planSnapshot) string {
	title := snapshot.title
	if title == "" {
		title = "Plan"
	}
	if snapshot.status != "" {
		return title + " \u00b7 " + snapshot.status
	}
	return title
}

func (m *Model) applyPlanMsg(msg planMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.addError("plan: " + msg.err.Error())
		return m, nil
	}
	snapshot := msg.snapshot
	if strings.TrimSpace(snapshot.text) == "" {
		m.setToast("the plan file is empty")
		return m, nil
	}
	if snapshot.truncated {
		m.setToast("plan file truncated for display; approval is disabled")
	} else if strings.TrimSpace(snapshot.revision) == "" {
		m.setToast("plan is too large to approve from the artifact")
	}
	viewer := newViewerOverlay(planArtifactTitle(snapshot), snapshot.text)
	viewer.action = "artifact"
	viewer.artifact = &artifactState{
		path:      snapshot.path,
		revision:  snapshot.revision,
		status:    snapshot.status,
		planMode:  m.currentMode == "plan",
		truncated: snapshot.truncated,
	}
	viewer.returnTo = m.overlay
	m.openOverlay(viewer)
	return m, nil
}

// confirmApprovePlan opens the confirmation dialog for a plan the model marked
// ready. Starting work is a real turn, so it always gets an explicit yes.
func (m *Model) confirmApprovePlan() tea.Cmd {
	o := m.overlay
	if o == nil || o.artifact == nil {
		return nil
	}
	if m.planApprovalPending {
		m.setToast("plan approval is already running")
		return nil
	}
	if m.busy {
		m.setToast("wait for the current turn to finish")
		return nil
	}
	if !m.bridgeReady {
		m.setToast("bridge extension unavailable; cannot approve the plan")
		return nil
	}
	if o.artifact.truncated || strings.TrimSpace(o.artifact.revision) == "" {
		m.setToast("plan file is too large to verify; approval is disabled")
		return nil
	}
	if m.currentMode != "plan" || !o.artifact.planMode {
		m.setToast("plan mode is not active")
		return nil
	}
	status := strings.ToLower(strings.TrimSpace(o.artifact.status))
	if status == "in-progress" || status == "done" {
		m.setToast("plan is already " + status)
		return nil
	}
	selection := m.planExitSelection()
	if _, ok := m.preparePreset(selection); !ok {
		m.setToast("the previous preset no longer exists")
		return nil
	}
	modelLabel := "the current model"
	if m.state.Model != nil {
		modelLabel = m.state.Model.Label()
	}
	statusLabel := status
	if statusLabel == "" {
		statusLabel = "draft"
	}
	var body strings.Builder
	fmt.Fprintf(&body, "Approve this plan and start implementing with %s?\n\n", modelLabel)
	fmt.Fprintf(&body, "Plan file: %s\n", shortenPath(o.artifact.path))
	fmt.Fprintf(&body, "Status: %s\n", statusLabel)
	fmt.Fprintf(&body, "Plan mode will end and %s will be restored.", m.presetLabel(selection))
	if statusLabel == "draft" {
		body.WriteString("\n\nThe plan is still marked draft.")
	}
	confirm := newConfirmMessageOverlay("plan-approve", "Approve plan", body.String(), o.artifact.revision)
	confirm.returnTo = o
	m.openOverlay(confirm)
	return nil
}

// openPlanReject asks for the feedback that should drive the next plan
// revision. It never leaves Plan mode.
func (m *Model) openPlanReject() tea.Cmd {
	o := m.overlay
	if o == nil || o.artifact == nil {
		return nil
	}
	if m.busy {
		m.setToast("wait for the current turn to finish")
		return nil
	}
	if m.currentMode != "plan" {
		m.setToast("plan mode is not active")
		return nil
	}
	request := &rpc.ExtensionUIRequestEvent{
		Title:       "Reject plan",
		Method:      "input",
		Placeholder: "what should change?",
		Message:     "Plan mode stays on. The agent revises the plan file from your feedback.",
	}
	input := newInputOverlay(request)
	input.action = "plan-reject"
	input.returnTo = o
	m.openOverlay(input)
	return nil
}

// openArtifactModelPicker returns to the artifact after a model selection. The
// normal /model command remains the same outside the artifact.
func (m *Model) openArtifactModelPicker() tea.Cmd {
	o := m.overlay
	if o == nil || o.artifact == nil {
		return nil
	}
	command := m.openModelPicker()
	if m.overlay != nil && m.overlay != o {
		m.overlay.returnTo = o
	}
	return command
}

// approvePlan approves the exact revision shown in the artifact, restores the
// preset that preceded Plan mode, and only then lets the implementation prompt
// start a normal turn.
func (m *Model) approvePlan(path, revision string) tea.Cmd {
	if m.planApprovalPending {
		m.setToast("plan approval is already running")
		return nil
	}
	if m.busy {
		m.setToast("wait for the current turn to finish")
		return nil
	}
	if !m.bridgeReady {
		m.setToast("bridge extension unavailable; cannot approve the plan")
		return nil
	}
	if strings.TrimSpace(revision) == "" {
		m.setToast("plan revision is unavailable")
		return nil
	}
	selection := m.planExitSelection()
	prepared, ok := m.preparePreset(selection)
	if !ok {
		m.setToast("the previous preset no longer exists")
		return nil
	}
	client := m.client
	agentDir := m.paths.Dir
	m.planApprovalPending = true
	m.setToast("approving plan\u2026")
	return func() tea.Msg {
		msg := planApprovalMsg{path: path, selection: selection}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()

		entriesBefore, err := fetchEntries(ctx, client)
		if err != nil {
			msg.err = err
			return msg
		}
		if _, err := client.DoOK(ctx, rpc.Prompt("/pie-plan-approve "+revision)); err != nil {
			msg.err = err
			return msg
		}
		snapshot, err := readPlanSnapshot(agentDir, path)
		if err != nil {
			msg.err = err
			return msg
		}
		if strings.ToLower(strings.TrimSpace(snapshot.status)) != "in-progress" {
			msg.err = fmt.Errorf("the plan was not approved; it may have changed")
			return msg
		}
		if snapshot.revision == revision {
			msg.err = fmt.Errorf("the plan approval did not produce a new revision")
			return msg
		}
		entriesAfter, err := fetchEntries(ctx, client)
		if err != nil {
			msg.err = err
			return msg
		}
		if newestPlanEntryID(entriesBefore) == newestPlanEntryID(entriesAfter) {
			msg.err = fmt.Errorf("the plan approval was not recorded")
			return msg
		}
		if err := applyPresetCommand(ctx, client, prepared, true); err != nil {
			msg.err = err
			return msg
		}
		return msg
	}
}

func newestPlanEntryID(entries []session.LogEntry) string {
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		if entry.Type == "custom" && entry.CustomType == session.PlanEntryType {
			return entry.ID
		}
	}
	return ""
}

func planImplementationPrompt(path string) string {
	return fmt.Sprintf(
		"The plan at %s is approved. Implement it now. Read the plan file first and follow it. The approved plan content is read-only; do not edit it directly. After verification, call update_plan with status done. If the plan needs a material change, stop and ask me to revise it in Plan mode.",
		path,
	)
}

func planRejectPrompt(feedback string) string {
	return fmt.Sprintf(
		"I am not approving the current plan. Revise the plan file using this feedback:\n\n%s\n\nRead the current plan file first, keep Plan mode, and write the full revised plan with update_plan. Set Status to draft until it is ready.",
		strings.TrimSpace(feedback),
	)
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
