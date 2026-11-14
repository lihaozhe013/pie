package ui

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/lihaozhe013/pie/tui/internal/mcp"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
	"github.com/lihaozhe013/pie/tui/internal/session"
)

type projectsMsg struct {
	projects []session.Project
	err      error
}

type projectSwitchedMsg struct {
	client Client
	dir    string
	err    error
}

const (
	projectBrowseValue = "\x00browse"
	projectUseValue    = "\x00use"
	sessionAllValue    = "\x00all"
)

// openProjectPicker lists the directories sessions were created in, with a
// directory browser behind it. Choosing one restarts pi there.
func (m *Model) openProjectPicker() tea.Cmd {
	dir := m.opts.SessionDir
	return func() tea.Msg {
		resolved, err := session.Dir(dir)
		if err != nil {
			return projectsMsg{err: err}
		}
		projects, err := session.Projects(resolved)
		return projectsMsg{projects: projects, err: err}
	}
}

func (m *Model) showProjectPicker() {
	items := make([]pickerItem, 0, len(m.projectList)+1)
	for _, project := range m.projectList {
		if project.Path == m.opts.CWD {
			continue
		}
		detail := fmt.Sprintf("%d session(s)", project.Sessions)
		if project.Last > 0 {
			detail += " · " + humanTime(time.Unix(0, project.Last))
		}
		items = append(items, pickerItem{Value: project.Path, Label: shortenPath(project.Path), Detail: detail})
	}
	items = append(items, pickerItem{Value: projectBrowseValue, Label: "Browse directories…", Detail: "pick any folder"})
	m.openOverlay(newPickerOverlay("project", "Switch project", items))
}

func (m *Model) applyProjects(msg projectsMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.addError("scan projects: " + msg.err.Error())
		return m, nil
	}
	m.projectList = msg.projects
	m.showProjectPicker()
	return m, nil
}

// openDirectoryPicker navigates the filesystem from start. Selecting a child
// descends; the first item switches the project to the current folder.
func (m *Model) openDirectoryPicker(start string) tea.Cmd {
	dir := expandHome(start)
	if dir == "" {
		dir = m.opts.CWD
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(m.opts.CWD, dir)
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		m.setToast("cannot open " + dir)
		return nil
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.IsDir() {
		m.setToast("not a directory: " + absolute)
		return nil
	}
	entries, err := os.ReadDir(absolute)
	if err != nil {
		m.setToast("cannot read " + absolute)
		return nil
	}
	items := []pickerItem{
		{Value: projectUseValue, Label: "Use this directory", Detail: "start a new session here"},
	}
	parent := filepath.Dir(absolute)
	if parent != absolute {
		items = append(items, pickerItem{Value: parent, Label: "..", Detail: shortenPath(parent)})
	}
	var dirs []string
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		dirs = append(dirs, filepath.Join(absolute, entry.Name()))
	}
	sort.Slice(dirs, func(i, j int) bool { return strings.ToLower(dirs[i]) < strings.ToLower(dirs[j]) })
	for _, path := range dirs {
		items = append(items, pickerItem{Value: path, Label: filepath.Base(path) + "/", Detail: shortenPath(path)})
	}
	m.browseDir = absolute
	previous := m.overlay
	var returnTo *overlay
	if previous != nil {
		if previous.returnTo != nil {
			returnTo = previous.returnTo
		} else if previous.action == "project" {
			returnTo = previous
		}
	}
	overlay := newPickerOverlay("cwd-browse", "Directory · "+shortenPath(absolute), items)
	overlay.returnTo = returnTo
	m.openOverlay(overlay)
	return nil
}

func (m *Model) browseTo(path string) tea.Cmd {
	switch path {
	case projectUseValue:
		m.closeOverlay()
		return m.switchProject(m.browseDir)
	default:
		return m.openDirectoryPicker(path)
	}
}

// switchProject restarts pi in dir. The running session belongs to the old
// directory, so this starts a new one; the transcript is cleared rather than
// carried into a folder it was not recorded in.
func (m *Model) switchProject(dir string) tea.Cmd {
	dir = expandHome(strings.TrimSpace(dir))
	if dir == "" {
		return nil
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(m.opts.CWD, dir)
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		m.setToast("invalid directory: " + dir)
		return nil
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.IsDir() {
		m.setToast("not a directory: " + absolute)
		return nil
	}
	if sameDirectory(absolute, m.opts.CWD) {
		m.setToast("already in " + shortenPath(absolute))
		return nil
	}
	if m.busy {
		m.setToast("stop the current turn before switching projects")
		return nil
	}
	if m.opts.Restart == nil {
		m.setToast("this build cannot restart pi; start pie in that directory instead")
		return nil
	}
	if m.prefs != nil {
		_ = m.prefs.SetLastCWD(absolute)
	}

	m.closeOverlay()
	m.dialogs = nil
	m.restarting = true
	old := m.client
	restart := m.opts.Restart
	m.addNotice("switching to " + absolute + "…")
	return func() tea.Msg {
		_ = old.Close()
		client, err := restart(absolute)
		return projectSwitchedMsg{client: client, dir: absolute, err: err}
	}
}

func (m *Model) applyProjectSwitch(msg projectSwitchedMsg) (tea.Model, tea.Cmd) {
	m.restarting = false
	if msg.err != nil {
		m.disconnected = true
		m.addError("switch project: " + msg.err.Error())
		return m, nil
	}

	m.client = msg.client
	m.opts.CWD = msg.dir
	m.sessionEpoch.Add(1)
	m.autoTitlePending = false
	m.autoTitleAttempts = 0
	m.resetSessionNameWatch()
	m.invalidateTitle()
	m.transcript.Clear()
	m.state = rpc.State{}
	m.firstUserPrompt = ""
	m.extensionTitle = ""
	m.queue = rpc.QueueUpdateEvent{}
	m.clearPendingPrompt()
	m.stats = rpc.SessionStats{}
	m.invalidateStats()
	m.busy = false
	m.stream = streamState{}
	m.activity.reset()
	m.logEntries = nil
	m.selection = session.ToolSelection{}
	m.hasSelection = false
	m.currentMode = ""
	m.plan = session.Plan{}
	m.hasPlan = false
	m.presetBeforePlan = ""
	m.goal = session.Goal{}
	m.hasGoal = false
	m.mcpSnapshot = mcp.Snapshot{}
	m.mcpChecked = false
	m.presetDraft = nil
	m.resetPresetRestore()
	m.statuses = map[string]string{}
	m.widget = nil
	m.fatal = ""
	m.disconnected = false
	m.reloadConfig()
	m.pendingNotice = "new session in " + msg.dir
	m.layout()
	return m, tea.Batch(m.waitEvent(), m.handshake(), m.syncTerminalTitle())
}

// sameDirectory resolves symlinks so /tmp and /private/tmp compare equal.
func sameDirectory(left, right string) bool {
	if left == "" || right == "" {
		return filepath.Clean(left) == filepath.Clean(right)
	}
	resolve := func(path string) string {
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			return filepath.Clean(resolved)
		}
		return filepath.Clean(path)
	}
	return resolve(left) == resolve(right)
}

func expandHome(path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err == nil {
			return filepath.Join(home, strings.TrimPrefix(path, "~"))
		}
	}
	return path
}
