// Package ui is the Bubble Tea front end of pie. It renders events produced
// by the rpc client and turns keyboard input into JSONL commands; it holds no
// conversation logic of its own.
package ui

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/config"
	"github.com/lihaozhe013/pie/tui/internal/mcp"
	"github.com/lihaozhe013/pie/tui/internal/modelcatalog"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
	"github.com/lihaozhe013/pie/tui/internal/session"
)

// Client is the subset of rpc.Client the model depends on. Tests substitute a
// fake so key handling can be exercised without a subprocess.
type Client interface {
	Do(ctx context.Context, command rpc.Command) (*rpc.Response, error)
	DoOK(ctx context.Context, command rpc.Command) (*rpc.Response, error)
	Send(command rpc.Command) error
	Events() <-chan rpc.Event
	Done() <-chan struct{}
	Err() error
	StderrTail() []string
	Close() error
}

// Options configures the model.
type Options struct {
	// SessionDir overrides where the resume picker looks for sessions.
	SessionDir string
	// CWD is the working directory shown for sessions without a recorded one.
	CWD string
	// Version is displayed in the help overlay.
	Version string
	// PiBin is the resolved pi executable, used for catalog and package
	// commands the client shells out to.
	PiBin string
	// Restart starts a fresh pi in dir, used when the working directory
	// changes. Nil disables project switching.
	Restart func(dir string) (Client, error)
	// AgentDir overrides PI_CODING_AGENT_DIR. Tests use it to keep the
	// developer's real configuration out of the run.
	AgentDir string
	// Mouse reports whether terminal mouse capture is enabled at startup.
	// The /mouse command toggles it at runtime.
	Mouse bool
	// Copy writes text to the clipboard. Nil installs the OSC52 and platform
	// clipboard writer.
	Copy func(string) tea.Cmd
}

// Timing constants for the event loop.
const (
	// renderInterval throttles markdown re-rendering while a message streams.
	renderInterval = 40 * time.Millisecond
	// tickInterval drives the spinner and pending stream renders.
	tickInterval = 40 * time.Millisecond
	// toastDuration is how long extension notifications stay visible.
	toastDuration = 5 * time.Second
	// heartbeatInterval expires toasts even when pi is idle.
	heartbeatInterval = time.Second
	// externalNamePollInterval keeps a Web-generated title visible without
	// rereading the whole session file on every tick.
	externalNamePollInterval = 2 * time.Second
	// maxSessionNameRead bounds one incremental name-watch read. A larger
	// gap is handled by a reverse scan instead of a large allocation.
	maxSessionNameRead = 4 << 20
	// maxAutoTitleAttempts bounds consecutive automatic title calls. A fresh
	// prompt resets a spent budget.
	maxAutoTitleAttempts = 3
	// commandTimeout bounds a single RPC command issued by the UI.
	commandTimeout = 60 * time.Second
)

// Layout constants for the frame.
const (
	// frameGutter is the number of blank columns kept on each side of the
	// terminal so the UI never sits flush against the screen edge.
	frameGutter = 2
	// minFrameWidth is the narrowest content column worth keeping; below it
	// the gutters collapse so the layout stays usable.
	minFrameWidth = 24
)

// Messages produced by commands.
type (
	eventMsg struct{ event rpc.Event }

	closedMsg struct {
		client Client
		err    error
	}

	tickMsg struct{}

	heartbeatMsg struct{}

	handshakeMsg struct {
		state    rpc.State
		models   []rpc.ModelInfo
		levels   []string
		commands []rpc.CommandInfo
		history  []rpc.Message
		stats    rpc.SessionStats
		err      error
	}

	responseMsg struct {
		action string
		level  string
		resp   *rpc.Response
		err    error
	}

	abortMsg struct {
		restored []string
		err      error
	}

	sessionListMsg struct {
		entries []session.Entry
		err     error
	}

	historyMsg struct {
		messages []rpc.Message
		state    *rpc.State
		err      error
	}

	titleMsg struct {
		silent    bool
		title     string
		sessionID string
		requestID uint64
		resp      *rpc.Response
		err       error
	}

	autoTitleRetryMsg struct{ sessionID string }

	sessionNameMsg struct {
		sessionID string
		pollID    uint64
		watchSeq  uint64
		path      string
		name      string
		found     bool
		offset    int64
		partial   []byte
		err       error
	}

	statsMsg struct {
		request uint64
		stats   rpc.SessionStats
		err     error
	}

	stateMsg struct{ state rpc.State }

	entriesMsg struct {
		entries []session.LogEntry
		err     error
	}

	snapshotMsg struct {
		snapshot toolSnapshot
		err      error
	}

	providerAuthMsg struct {
		providers map[string]*modelcatalog.ProviderAuth
		err       error
	}

	providerAuthCommandMsg struct {
		action   string
		provider string
		err      error
	}

	availableModelsMsg struct {
		models []rpc.ModelInfo
		err    error
	}

	presetAppliedMsg struct {
		selection string
		quiet     bool
		err       error
	}

	commandsMsg struct {
		commands []rpc.CommandInfo
		err      error
	}
)

// streamState accumulates one streaming assistant response.
type streamState struct {
	acc       rpc.StreamAccumulator
	assistant *block
	thinking  *block
	dirty     bool
}

// Model is the top-level Bubble Tea model.
type Model struct {
	client Client
	styles styles
	opts   Options

	transcript *transcript
	composer   *composer
	completion *completion
	overlay    *overlay

	width  int
	height int
	body   int

	state    rpc.State
	models   []rpc.ModelInfo
	levels   []string
	commands []rpc.CommandInfo
	stats    rpc.SessionStats
	queue    rpc.QueueUpdateEvent
	// statsRequest numbers get_session_stats reads, and statsApplied is the
	// newest successful reply already applied. Without the ordering, a slow
	// read from an earlier turn can land after a newer one and freeze the
	// context meter.
	statsRequest  uint64
	statsApplied  uint64
	statsInFlight uint64

	statuses     map[string]string
	toast        string
	toastUntil   time.Time
	widget       []string
	showThinking bool
	expanded     bool
	enterToSend  bool
	mouseOn      bool
	copyFn       func(string) tea.Cmd

	busy         bool
	frame        int
	stream       streamState
	activity     activityState
	spinning     bool
	ticking      bool
	fatal        string
	disconnected bool
	ready        bool
	quitting     bool
	ctrlCAt      time.Time

	dialogs []*rpc.ExtensionUIRequestEvent

	paths              config.Paths
	settings           *config.Settings
	prefs              *config.TUIConfig
	configErr          error
	settingsPanel      *settingsState
	pendingSettingsRow *settingsRow

	// projectTrusted is trust.json's nearest decision for the working
	// directory; trustErr records an unreadable store.
	projectTrusted bool
	trustErr       error

	// bridgeReady reports whether pi loaded pie's bridge extension, which
	// provides hot tool switching, work modes, reload, and provider sign-in.
	bridgeReady bool

	// providerAuth is the bridge's provider sign-in snapshot. It also lists
	// providers with no credential, which the RPC model list cannot report.
	providerAuth    map[string]*modelcatalog.ProviderAuth
	providerAuthErr error
	// authFlow is the provider whose sign-in is running, so its panel can
	// offer a cancel and its dialogs are cleared when the flow ends.
	authFlow string
	// panelProvider is the provider whose detail panel is open, so a sign-in
	// result can rebuild it with the new credential state.
	panelProvider string
	// pendingAuthStep is a sign-in step that arrived while a dialog was open;
	// it is shown once that dialog closes.
	pendingAuthStep *overlay
	// pendingModelPick asks the next available-model reply to adopt the
	// provider's first model when the session has none yet.
	pendingModelPick string

	// pendingPrompt is the optimistic user block for the prompt in flight, so
	// a command handled by an extension can take it back.
	pendingPrompt     *block
	pendingPromptText string
	// autoTitlePending asks the next settled turn to name an unnamed session.
	autoTitlePending bool
	// titleRunning prevents overlapping manual or automatic title requests.
	titleRunning bool
	// titleRequest identifies the request that owns titleRunning.
	titleRequest uint64
	titleSeq     uint64
	// sessionEpoch invalidates in-flight title requests after a session switch.
	sessionEpoch atomic.Uint64
	// autoTitleAttempts caps retries for one session. A success, a manual
	// rename, or a session switch resets it.
	autoTitleAttempts int
	// nameWatch* follow the current session file so a title written by the
	// Web UI appears here without reopening the session.
	nameWatchPath    string
	nameWatchOffset  int64
	nameWatchPartial []byte
	nameWatchName    string
	nameWatchValid   bool
	nameWatchSeq     uint64
	namePollID       uint64
	namePollPending  bool
	namePollAt       time.Time

	presetFile  *config.PresetFile
	presetDraft *presetDraft
	// presetRestored reports whether the saved preset was applied to this
	// session; entriesLoaded gates that attempt until the log has been read.
	presetRestored bool
	entriesLoaded  bool
	toolSnapshot   *toolSnapshot
	modelSettings  *config.ModelSettings
	modelsFile     *config.ModelsFile
	catalog        *modelcatalog.Catalog
	catalogErr     error
	enabledModels  map[string]bool
	modelPins      map[string]string
	logEntries     []session.LogEntry
	selection      session.ToolSelection
	hasSelection   bool
	currentMode    string

	goalAvailable bool
	goalEnabled   bool
	goal          session.Goal
	hasGoal       bool

	mcpSnapshot mcp.Snapshot
	mcpChecked  bool

	restarting     bool
	pendingNotice  string
	pendingContext bool
	tree           session.Tree
	projectList    []session.Project
	browseDir      string
	sessionsAll    bool
}

// New builds the model around a connected client.
func New(client Client, opts Options) *Model {
	var paths config.Paths
	var err error
	if opts.AgentDir != "" {
		paths = config.Paths{Dir: opts.AgentDir}
	} else {
		paths, err = config.ResolvePaths()
	}
	m := &Model{
		client:       client,
		opts:         opts,
		paths:        paths,
		statuses:     map[string]string{},
		showThinking: true,
		mouseOn:      opts.Mouse,
		copyFn:       opts.Copy,
	}
	if m.copyFn == nil {
		m.copyFn = defaultCopyCommand()
	}
	if err != nil {
		m.configErr = err
	} else {
		m.reloadConfig()
	}

	themeID := "auto"
	if m.prefs != nil {
		themeID = m.prefs.Theme()
		m.showThinking = m.prefs.ShowThinking()
		m.expanded = m.prefs.ExpandTools()
		m.goalEnabled = m.prefs.GoalEnabled()
		m.enterToSend = m.prefs.EnterToSend()
	}
	m.styles = newStyles(themeFor(themeID))
	m.transcript = newTranscript(m.styles)
	m.composer = newComposer(m.styles)
	m.completion = &completion{}
	m.completion.SetItems(builtinCommands())
	return m
}

// reloadConfig refreshes the shared settings and terminal preferences from
// disk. A broken file disables the rows that need it instead of failing the
// whole client.
func (m *Model) reloadConfig() {
	if m.paths.Dir == "" {
		paths, err := config.ResolvePaths()
		if err != nil {
			m.configErr = err
			return
		}
		m.paths = paths
	}
	settings, err := config.LoadSettings(m.paths)
	if err != nil {
		m.configErr = err
		m.settings = nil
	} else {
		m.configErr = nil
		m.settings = settings
	}
	prefs, err := config.LoadTUIConfig(m.paths)
	if err != nil {
		m.prefs = nil
	} else {
		m.prefs = prefs
	}
	m.presetFile = config.LoadPresets(m.paths)
	if modelSettings, err := config.LoadModelSettings(m.paths); err == nil {
		m.modelSettings = modelSettings
	}
	if modelsFile, err := config.LoadModels(m.paths); err == nil {
		m.modelsFile = modelsFile
	}
	if m.paths.Dir != "" && m.opts.CWD != "" {
		m.projectTrusted, m.trustErr = config.ProjectTrusted(m.paths.Dir, m.opts.CWD)
	}
	m.reloadCatalog()
}

// projectWriteRefusal explains why a project write must not happen, or nil.
// requiresDecision matches MCP's rule (an explicit trust decision, even in a
// folder with no project resources); plugins accept a fresh folder.
func (m *Model) projectWriteRefusal(requiresDecision bool) error {
	if m.opts.CWD == "" {
		return errors.New("no working directory is set")
	}
	if m.trustErr != nil {
		return fmt.Errorf("cannot read trust.json: %w", m.trustErr)
	}
	if !requiresDecision && !config.ProjectRequiresTrust(m.opts.CWD) {
		return nil
	}
	if m.projectTrusted {
		return nil
	}
	return errors.New("the project is not trusted; start pi in it, choose Trust, then reload settings")
}

// reloadCatalog rebuilds the provider catalog and folds in the models the
// running pi reported.
func (m *Model) reloadCatalog() {
	catalog, err := modelcatalog.Load(m.paths)
	if err != nil {
		m.catalogErr = err
		m.catalog = nil
		m.enabledModels = nil
		return
	}
	runtime := make([]modelcatalog.Model, 0, len(m.models))
	for _, info := range m.models {
		runtime = append(runtime, modelcatalog.Model{
			ProviderID:    info.Provider,
			ID:            info.ID,
			Name:          info.Name,
			API:           info.API,
			BaseURL:       info.BaseURL,
			Reasoning:     info.Reasoning,
			Input:         info.Input,
			ContextWindow: info.ContextWindow,
			MaxTokens:     info.MaxTokens,
			Cost: modelcatalog.Cost{
				Input:      info.Cost.Input,
				Output:     info.Cost.Output,
				CacheRead:  info.Cost.CacheRead,
				CacheWrite: info.Cost.CacheWrite,
			},
		})
	}
	catalog.MergeRuntime(runtime)
	catalog.MergeAuth(m.providerAuth)
	m.catalog = catalog
	m.catalogErr = nil
	m.refreshEnabledModels()
}

// refreshEnabledModels recomputes the enabled/pin maps the settings rows read.
func (m *Model) refreshEnabledModels() {
	if m.catalog == nil || m.settings == nil {
		m.enabledModels = nil
		m.modelPins = nil
		return
	}
	patterns, present, err := m.settings.EnabledModels()
	if err != nil {
		m.enabledModels = nil
		return
	}
	m.enabledModels, m.modelPins, _ = modelcatalog.EnabledSet(patterns, present, m.catalog.Models())
}

// Init starts the event pump, the startup handshake, and the idle heartbeat.
func (m *Model) Init() tea.Cmd {
	return tea.Batch(m.waitEvent(), m.handshake(), m.heartbeat())
}

// heartbeat keeps time-based UI state (toast expiry) honest while idle.
func (m *Model) heartbeat() tea.Cmd {
	return tea.Tick(heartbeatInterval, func(time.Time) tea.Msg { return heartbeatMsg{} })
}

func (m *Model) waitEvent() tea.Cmd {
	events := m.client.Events()
	client := m.client
	return func() tea.Msg {
		event, ok := <-events
		if !ok {
			return closedMsg{client: client}
		}
		return eventMsg{event: event}
	}
}

func (m *Model) handshake() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		msg := handshakeMsg{}
		response, err := client.DoOK(ctx, rpc.GetState())
		if err != nil {
			msg.err = err
			return msg
		}
		msg.state, _ = rpc.DecodeTyped[rpc.State](response)

		if response, err := client.DoOK(ctx, rpc.GetAvailableModels()); err == nil {
			payload, _ := rpc.DecodeTyped[rpc.ModelsPayload](response)
			msg.models = payload.Models
		}
		if response, err := client.DoOK(ctx, rpc.GetAvailableThinkingLevels()); err == nil {
			payload, _ := rpc.DecodeTyped[rpc.ThinkingLevelsPayload](response)
			msg.levels = payload.Levels
		}
		if response, err := client.DoOK(ctx, rpc.GetCommands()); err == nil {
			payload, _ := rpc.DecodeTyped[rpc.CommandsPayload](response)
			msg.commands = payload.Commands
		}
		if response, err := client.DoOK(ctx, rpc.GetSessionStats()); err == nil {
			msg.stats, _ = rpc.DecodeTyped[rpc.SessionStats](response)
		}
		if msg.state.MessageCount > 0 {
			if response, err := client.DoOK(ctx, rpc.GetMessages()); err == nil {
				payload, _ := rpc.DecodeTyped[rpc.MessagesPayload](response)
				msg.history = payload.Messages
			}
		}
		return msg
	}
}

// Update implements tea.Model.
func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.ready = true
		m.layout()
		return m, nil

	case handshakeMsg:
		return m.applyHandshake(msg)

	case eventMsg:
		return m.handleEvent(msg.event)

	case closedMsg:
		if msg.client != nil && m.client != nil && msg.client != m.client {
			// The old child exited after a project switch; its pump is stale.
			return m, nil
		}
		m.disconnected = true
		m.busy = false
		m.authFlow = ""
		m.activity.reset()
		m.layout()
		tail := strings.Join(m.client.StderrTail(), "\n")
		detail := "pi exited"
		if err := m.client.Err(); err != nil {
			detail += ": " + err.Error()
		}
		if tail != "" {
			detail += "\n" + tail
		}
		m.addError(detail)
		return m, nil

	case stateMsg:
		if m.state.SessionID != "" && msg.state.SessionID != "" && m.state.SessionID != msg.state.SessionID {
			m.sessionEpoch.Add(1)
			m.invalidateTitle()
			m.autoTitleAttempts = 0
			m.autoTitlePending = false
			m.resetSessionNameWatch()
		}
		if m.nameWatchValid && m.nameWatchPath == msg.state.SessionFile {
			// The file is the shared source of truth: pi's in-memory name can
			// lag behind a title written by the Web UI.
			msg.state.SessionName = m.nameWatchName
		}
		m.state = msg.state
		if msg.state.SessionName != "" {
			m.noteSessionName(msg.state.SessionName)
		}
		return m, nil

	case heartbeatMsg:
		if m.toast != "" && time.Now().After(m.toastUntil) {
			m.toast = ""
		}
		commands := []tea.Cmd{m.heartbeat()}
		if cmd := m.pollSessionName(); cmd != nil {
			commands = append(commands, cmd)
		}
		// Context grows during a run, but pi reports it only through
		// get_session_stats. Poll on the one-second heartbeat so the meter and
		// the statistics panel stay live instead of freezing at the last
		// settled turn. The in-flight guard keeps slow reads from piling up.
		if m.statsInFlight == 0 && (m.busy || m.statsPanelOpen()) {
			commands = append(commands, m.refreshStats())
		}
		return m, tea.Batch(commands...)

	case tickMsg:
		m.ticking = false
		m.frame++
		if m.stream.dirty {
			m.stream.dirty = false
			m.transcript.MarkDirty()
		}
		if m.activityActive() {
			return m, m.scheduleTick()
		}
		return m, nil

	case responseMsg:
		return m.applyResponse(msg)

	case abortMsg:
		if len(msg.restored) > 0 {
			m.composer.SetText(strings.Join(msg.restored, "\n"))
			m.completion.Refresh(m.composer.Value())
			// The restored draft can be much taller than the submitted prompt,
			// so the body must give the editor its rows back.
			m.layout()
		}
		if msg.err != nil {
			m.addError(msg.err.Error())
		}
		return m, nil

	case presetAppliedMsg:
		if msg.err != nil {
			m.addError("preset: " + msg.err.Error())
			return m, nil
		}
		if m.prefs != nil && m.prefs.ToolPreset() != msg.selection {
			_ = m.prefs.SetToolPreset(msg.selection)
		}
		return m, tea.Batch(m.loadEntries(), m.loadToolSnapshot())

	case reloadMsg:
		if msg.err != nil {
			m.addError("reload: " + msg.err.Error())
			return m, nil
		}
		m.reloadConfig()
		m.setToast("pi reloaded settings and instructions")
		if m.overlay != nil && m.overlay.action == "settings" {
			m.openSettingsOverlay()
		}
		return m, tea.Batch(m.refreshState(), m.refreshCommands(), m.loadEntries(), m.loadToolSnapshot(), m.loadProviderAuth())

	case commandsMsg:
		if msg.err != nil {
			return m, nil
		}
		m.commands = msg.commands
		m.bridgeReady = m.hasPiCommand("pie-tools")
		m.goalAvailable = m.hasPiCommand("goal")
		m.completion.SetItems(m.commandItems())
		commands := []tea.Cmd{m.loadProviderAuth()}
		if cmd := m.restoreSavedPreset(); cmd != nil {
			commands = append(commands, cmd)
		}
		return m, tea.Batch(commands...)

	case providerCheckMsg:
		m.setToast(providerCheckSummary(msg))
		return m, nil

	case catalogRefreshedMsg:
		if msg.err != nil {
			m.setToast("model catalog: " + msg.err.Error())
		} else {
			m.setToast("model catalog refreshed")
		}
		return m, nil

	case statsMsg:
		if msg.request == m.statsInFlight {
			m.statsInFlight = 0
		}
		if msg.err != nil {
			// A failed read must not blank the last good meter.
			return m, nil
		}
		if msg.request <= m.statsApplied {
			// An older read finished last; keep the newer numbers.
			return m, nil
		}
		m.statsApplied = msg.request
		m.stats = msg.stats
		return m, nil

	case sessionListMsg:
		if msg.err != nil {
			m.addError("scan sessions: " + msg.err.Error())
			return m, nil
		}
		if len(msg.entries) == 0 && m.sessionsAll {
			m.setToast("no sessions found")
			return m, nil
		}
		items := make([]pickerItem, 0, len(msg.entries)+1)
		for _, entry := range msg.entries {
			items = append(items, pickerItem{
				Value:  entry.Path,
				Label:  entry.Label(),
				Detail: fmt.Sprintf("%s · %s", shortenPath(entry.CWD), humanTime(entry.Modified)),
			})
		}
		if !m.sessionsAll {
			items = append(items, pickerItem{Value: sessionAllValue, Label: "Show all directories", Detail: "sessions from every project"})
		}
		m.openOverlay(newPickerOverlay("session", "Resume session", items))
		return m, nil

	case historyMsg:
		// A history load only happens after switch_session succeeded, so the
		// old session's title request is no longer valid even if loading the
		// messages failed.
		m.resetPresetRestore()
		m.sessionEpoch.Add(1)
		m.autoTitlePending = false
		m.autoTitleAttempts = 0
		m.resetSessionNameWatch()
		m.invalidateTitle()
		if msg.err != nil {
			m.addError("load messages: " + msg.err.Error())
			return m, nil
		}
		if msg.state != nil {
			m.state = *msg.state
		}
		m.loadHistory(msg.messages)
		if msg.state != nil {
			// Name the session from the history now, even if the attached turn
			// is still streaming; a failure retries when that turn settles.
			m.autoTitlePending = m.state.SessionName == ""
			if cmd := m.autoTitleFromHistory(msg.messages); cmd != nil {
				return m, cmd
			}
		}
		return m, nil

	case entriesMsg:
		if msg.err != nil {
			// Entries are best effort: the session still works without them.
			return m, nil
		}
		m.logEntries = msg.entries
		m.entriesLoaded = true
		m.selection, m.hasSelection = session.ReadToolSelection(m.logEntries)
		m.currentMode = session.ReadWorkMode(m.logEntries)
		m.goal, m.hasGoal = session.ReadGoal(m.logEntries)
		if m.overlay != nil && m.overlay.action == "goal" {
			m.openGoalPanel()
		}
		if cmd := m.restoreSavedPreset(); cmd != nil {
			return m, cmd
		}
		return m, nil

	case providerAuthMsg:
		if msg.err != nil {
			m.providerAuthErr = msg.err
			return m, nil
		}
		m.providerAuth = msg.providers
		m.providerAuthErr = nil
		m.reloadCatalog()
		m.refreshAuthPanels()
		return m, nil

	case openURLMsg:
		if msg.err != nil {
			m.setToast("open browser: " + msg.err.Error())
		}
		return m, nil

	case providerAuthCommandMsg:
		if msg.err != nil {
			if msg.action == "login" {
				m.authFlow = ""
			}
			m.addError(msg.err.Error())
		}
		return m, nil

	case availableModelsMsg:
		if msg.err != nil {
			return m, nil
		}
		m.models = msg.models
		m.reloadCatalog()
		return m, m.adoptPendingModel()

	case snapshotMsg:
		if msg.err != nil {
			if m.pendingContext {
				m.pendingContext = false
				m.addError("context: " + msg.err.Error())
			}
			return m, nil
		}
		m.toolSnapshot = &msg.snapshot
		if m.pendingContext {
			m.pendingContext = false
			m.showContextPanel()
		}
		return m, nil

	case contextViewMsg:
		if msg.err != nil {
			m.addError("view: " + msg.err.Error())
		}
		m.showContextPanel()
		return m, nil

	case forkMessagesMsg:
		return m.applyForkMessages(msg)

	case forkResultMsg:
		return m.applyForkResult(msg)

	case cloneResultMsg:
		return m.applyCloneResult(msg)

	case treeResultMsg:
		return m.applyTree(msg)

	case sessionSearchMsg:
		return m.applySessionSearch(msg)

	case projectsMsg:
		return m.applyProjects(msg)

	case projectSwitchedMsg:
		return m.applyProjectSwitch(msg)

	case mcpCheckMsg:
		return m.applyMCPCheck(msg)

	case mcpActionMsg:
		return m.applyMCPAction(msg)

	case pluginActionMsg:
		return m.applyPluginAction(msg)

	case skillActionMsg:
		return m.applySkillAction(msg)

	case skillSearchMsg:
		return m.applySkillSearch(msg)

	case skillEditMsg:
		if msg.err != nil {
			m.addError("edit skill: " + msg.err.Error())
		}
		return m, m.openSettingsAt("skills")

	case copiedMsg:
		if msg.err != nil {
			m.setToast("copy failed: " + msg.err.Error())
			return m, nil
		}
		if msg.lines > 1 {
			m.setToast(fmt.Sprintf("copied %d lines", msg.lines))
		} else {
			m.setToast(fmt.Sprintf("copied %d chars", msg.chars))
		}
		return m, nil

	case autoTitleRetryMsg:
		if msg.sessionID == "" || msg.sessionID != m.state.SessionID || m.state.SessionName != "" ||
			m.titleRunning || !m.autoTitlePending {
			return m, nil
		}
		m.autoTitlePending = false
		return m, m.startAutoTitle(nil)

	case sessionNameMsg:
		if msg.pollID != m.namePollID {
			// A newer poll owns namePollPending.
			return m, nil
		}
		m.namePollPending = false
		if msg.watchSeq != m.nameWatchSeq {
			// The watch was reset or a name arrived while this read was in
			// flight; its snapshot is stale.
			return m, nil
		}
		if msg.err != nil {
			return m, nil
		}
		if msg.path == "" || msg.path != m.state.SessionFile {
			return m, nil
		}
		if msg.sessionID != "" && msg.sessionID != m.state.SessionID {
			return m, nil
		}
		m.nameWatchPath = msg.path
		m.nameWatchOffset = msg.offset
		m.nameWatchPartial = msg.partial
		if !msg.found {
			return m, nil
		}
		m.nameWatchName = msg.name
		m.nameWatchValid = true
		if msg.name == m.state.SessionName {
			return m, nil
		}
		// Another client wrote a title. Adopt it before any in-flight auto
		// title can finish and overwrite it.
		m.noteSessionName(msg.name)
		m.autoTitlePending = false
		m.autoTitleAttempts = 0
		m.sessionEpoch.Add(1)
		m.invalidateTitle()
		return m, nil

	case titleMsg:
		if msg.requestID != 0 && msg.requestID != m.titleRequest {
			// A newer request owns titleRunning.
			return m, nil
		}
		m.invalidateTitle()
		if msg.sessionID != "" && msg.sessionID != m.state.SessionID {
			// The request belonged to a session the user already left.
			return m, nil
		}
		if msg.silent {
			// Auto-naming is best-effort: failures stay out of the transcript.
			if msg.err != nil {
				if m.state.SessionName == "" && m.autoTitleAttempts < maxAutoTitleAttempts {
					m.autoTitlePending = true
					if msg.sessionID != "" {
						return m, tea.Tick(3*time.Second, func(time.Time) tea.Msg {
							return autoTitleRetryMsg{sessionID: msg.sessionID}
						})
					}
				} else {
					m.autoTitlePending = false
				}
				return m, nil
			}
			m.autoTitlePending = false
			m.autoTitleAttempts = 0
			m.noteSessionName(msg.title)
			return m, nil
		}
		if msg.err != nil {
			m.addError("title: " + msg.err.Error())
			return m, nil
		}
		m.autoTitlePending = false
		m.autoTitleAttempts = 0
		m.noteSessionName(msg.title)
		m.setToast("title: " + msg.title)
		return m, nil

	case tea.KeyMsg:
		return m.handleKey(msg)

	case tea.MouseMsg:
		return m.handleMouse(msg)
	}

	return m, nil
}

func (m *Model) applyHandshake(msg handshakeMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.fatal = "could not talk to pi: " + msg.err.Error()
		m.addError(m.fatal)
		return m, tea.Quit
	}

	m.sessionEpoch.Add(1)
	m.state = msg.state
	m.invalidateStats()
	m.autoTitlePending = false
	m.autoTitleAttempts = 0
	m.resetSessionNameWatch()
	m.invalidateTitle()
	m.models = msg.models
	m.levels = msg.levels
	m.commands = msg.commands
	m.stats = msg.stats
	m.bridgeReady = m.hasPiCommand("pie-tools")
	m.goalAvailable = m.hasPiCommand("goal")
	m.reloadCatalog()
	m.completion.SetItems(m.commandItems())
	m.loadHistory(msg.history)
	if m.pendingNotice != "" {
		m.addNotice(m.pendingNotice)
		m.pendingNotice = ""
	}

	if m.state.IsStreaming {
		// Attach to a run that was already in flight when we started.
		m.busy = true
		m.activity.begin()
		m.layout()
		m.transcript.Add(newBlock(blockNotice, "attached to a running turn"))
		m.autoTitlePending = m.state.SessionName == ""
		commands := []tea.Cmd{m.scheduleTick(), m.loadEntries()}
		if m.bridgeReady {
			commands = append(commands, m.loadProviderAuth())
		}
		if cmd := m.autoTitleFromHistory(msg.history); cmd != nil {
			commands = append(commands, cmd)
		}
		return m, tea.Batch(commands...)
	}

	commands := []tea.Cmd{m.loadEntries()}
	if m.bridgeReady {
		commands = append(commands, m.loadProviderAuth())
	}
	if cmd := m.autoTitleFromHistory(msg.history); cmd != nil {
		commands = append(commands, cmd)
	}
	return m, tea.Batch(commands...)
}

// commandItems merges built-ins with the commands pi reported. A built-in alias
// that pi also uses is dropped: runSlash forwards that name to pi, so listing it
// as a client-side command would be a lie.
// hasPiCommand reports whether pi advertised an extension command.
func (m *Model) hasPiCommand(name string) bool {
	for _, command := range m.commands {
		if command.Name == name {
			return true
		}
	}
	return false
}

func (m *Model) commandItems() []completionItem {
	items := make([]completionItem, 0, len(builtinCommandTable)*2)
	seen := make(map[string]bool, len(builtinCommandTable)*2)
	for _, item := range builtinCommands() {
		if item.Alias != "" && m.piOwns(item.Value) {
			continue
		}
		seen[item.Value] = true
		items = append(items, item)
	}
	for _, command := range m.commands {
		value := "/" + command.Name
		if seen[value] {
			continue
		}
		seen[value] = true
		detail := command.Description
		if detail == "" {
			detail = command.Source
		} else if command.Source != "" {
			detail += " (" + command.Source + ")"
		}
		items = append(items, completionItem{Value: value, Detail: detail, Kind: command.Source})
	}
	return items
}

// layout recomputes pane sizes from the terminal size and editor height.
//
// The frame is exactly height lines: body + 1 status + an optional activity
// row + editor box + hint.
func (m *Model) layout() {
	if m.width == 0 || m.height == 0 {
		return
	}
	width := m.frameWidth()
	// The composer only carries a top and bottom rule now, so its content can
	// use the columns the side borders used to occupy.
	m.composer.SetWidth(width - 2)

	// On a very short terminal, shrink the editor instead of letting the frame
	// clip its bottom border.
	m.composer.SetMaxRows(m.height - 5 - m.activityRows())

	editor := m.composer.Height() + 3
	completion := 0
	if m.completion.visible && m.overlay == nil {
		completion = minInt(len(m.completion.filtered), 6) + 2
	}
	body := m.height - 1 - m.activityRows() - editor - completion
	if body < 1 {
		body = 1
	}
	m.body = body
	m.transcript.SetSize(width, body)
	if m.overlay != nil {
		m.overlay.Resize(width, m.body)
	}
}

// frameWidth is the width of the content column between the side gutters. On
// very narrow terminals the gutters collapse instead of crushing the layout.
func (m *Model) frameWidth() int {
	width := m.width - 2*frameGutter
	if width < minFrameWidth {
		return m.width
	}
	return width
}

// frameIndent is the number of blank columns rendered before the content.
func (m *Model) frameIndent() int { return (m.width - m.frameWidth()) / 2 }

func (m *Model) scheduleTick() tea.Cmd {
	if m.ticking {
		return nil
	}
	m.ticking = true
	return tea.Tick(tickInterval, func(time.Time) tea.Msg { return tickMsg{} })
}

// View implements tea.Model.
func (m *Model) View() string {
	if !m.ready {
		return m.styles.muted.Render("starting pie…")
	}

	lines := make([]string, 0, m.height)
	lines = append(lines, m.bodyLines()...)

	if len(lines) < m.height {
		lines = append(lines, m.renderStatus())
	}
	if m.activityRows() > 0 && len(lines) < m.height {
		lines = append(lines, m.renderActivity())
	}
	if m.completion.visible && m.overlay == nil && len(lines) < m.height {
		lines = append(lines, strings.Split(m.renderCompletion(), "\n")...)
	}
	if len(lines) < m.height {
		lines = append(lines, strings.Split(m.renderEditor(), "\n")...)
	}

	if len(lines) > m.height {
		lines = lines[:m.height]
	}
	for len(lines) < m.height {
		lines = append(lines, "")
	}

	// Inset the frame on both sides so it reads as a column instead of text
	// pinned to the terminal edge.
	width, indent := m.frameWidth(), m.frameIndent()
	if indent > 0 {
		pad := strings.Repeat(" ", indent)
		for i, line := range lines {
			if lipglossWidth(line) > width {
				line = truncateLine(line, width)
			}
			lines[i] = pad + line
		}
	}
	return strings.Join(lines, "\n")
}

// bodyLines renders exactly the transcript area height.
func (m *Model) bodyLines() []string {
	if m.overlay != nil {
		box := strings.Split(m.overlay.View(m.styles), "\n")
		top := (m.body - len(box)) / 2
		if top < 0 {
			top = 0
		}
		lines := make([]string, 0, m.body)
		for i := 0; i < top && len(lines) < m.body; i++ {
			lines = append(lines, "")
		}
		for _, line := range box {
			if len(lines) >= m.body {
				break
			}
			lines = append(lines, line)
		}
		for len(lines) < m.body {
			lines = append(lines, "")
		}
		return lines
	}

	lines := strings.Split(m.transcript.View(), "\n")
	if len(lines) > m.body {
		lines = lines[:m.body]
	}
	for len(lines) < m.body {
		lines = append(lines, "")
	}
	return lines
}

func (m *Model) renderStatus() string {
	var left []string

	if cwd := displayPath(m.opts.CWD); cwd != "" {
		left = append(left, m.styles.accent.Render(cwd))
	}
	if m.state.SessionName != "" {
		left = append(left, m.styles.muted.Render(m.state.SessionName))
	}
	if m.currentMode == "plan" {
		left = append(left, m.styles.accent.Render("plan"))
	}
	if goal := m.goalStatusSegment(); goal != "" {
		left = append(left, m.styles.muted.Render(goal))
	}

	if m.fatal != "" {
		left = append(left, m.styles.errorText.Render(m.fatal))
	} else if m.disconnected {
		left = append(left, m.styles.errorText.Render("pi disconnected · ctrl+c to exit"))
	}

	if queued := len(m.queue.Steering) + len(m.queue.FollowUp); queued > 0 {
		left = append(left, m.styles.notice.Render(fmt.Sprintf("%d queued", queued)))
	}

	keys := make([]string, 0, len(m.statuses))
	for key := range m.statuses {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if strings.HasPrefix(key, "preset") || strings.HasPrefix(m.statuses[key], "preset:") {
			continue
		}
		left = append(left, m.styles.muted.Render(m.statuses[key]))
	}
	for _, line := range m.widget {
		left = append(left, m.styles.muted.Render(line))
	}

	if m.toast != "" && time.Now().Before(m.toastUntil) {
		if !strings.HasPrefix(m.toast, "preset:") {
			left = append(left, m.styles.notice.Render(m.toast))
		}
	}

	var right string
	if m.stats.Tokens.Total > 0 || m.stats.ContextUsage != nil {
		// Show context used over the window limit ("200k / 256k"); fall
		// back to the session total when the model reports no usage.
		if usage := m.contextUsage(); usage != nil && usage.ContextWindow > 0 {
			right = fmt.Sprintf("%s / %s", formatTokens(usage.Tokens), formatTokens(usage.ContextWindow))
		} else {
			right = formatTokens(m.stats.Tokens.Total)
		}
		right = m.styles.muted.Render(right)
	}

	width := m.frameWidth()
	if right == "" {
		return truncateLine(strings.Join(left, m.styles.muted.Render(" · ")), width)
	}
	leftText := truncateLine(strings.Join(left, m.styles.muted.Render(" · ")), width-lipglossWidth(right)-1)
	gap := width - lipglossWidth(leftText) - lipglossWidth(right)
	if gap < 1 {
		gap = 1
	}
	return leftText + strings.Repeat(" ", gap) + right
}

func (m *Model) renderCompletion() string {
	var lines []string
	limit := minInt(len(m.completion.filtered), 6)
	start := 0
	if m.completion.cursor >= limit {
		start = m.completion.cursor - limit + 1
	}
	for i := start; i < start+limit && i < len(m.completion.filtered); i++ {
		item := m.completion.filtered[i]
		line := "  " + item.Value
		if item.Detail != "" {
			line += "  " + item.Detail
		}
		if i == m.completion.cursor {
			lines = append(lines, m.styles.compActive.Render("› "+item.Value)+m.styles.muted.Render("  "+item.Detail))
		} else {
			lines = append(lines, m.styles.muted.Render(line))
		}
	}
	box := m.styles.completion.Copy().Width(maxInt(20, m.frameWidth()-4)).Render(strings.Join(lines, "\n"))
	return box
}

func (m *Model) editorMeta() string {
	var parts []string
	if preset := m.presetLabel(m.currentPresetID()); preset != "" {
		parts = append(parts, preset)
	}
	model := "no model"
	if m.state.Model != nil {
		model = m.state.Model.Label()
	}
	parts = append(parts, model)
	if m.state.ThinkingLevel != "" {
		parts = append(parts, m.state.ThinkingLevel)
	}
	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, " · ")
}

func (m *Model) renderEditor() string {
	hint := "enter to send · ctrl+j newline · ctrl+p palette · /help"
	if !m.enterToSend {
		hint = "enter newline · alt+enter send · ctrl+p palette · /help"
	}
	if m.busy {
		hint = "enter to queue follow-up · ctrl+s to steer · esc to interrupt"
	}
	if m.disconnected {
		hint = "pi exited · ctrl+c to quit"
	}
	if m.currentMode == "plan" && !m.disconnected {
		hint = "plan mode · writes blocked · " + hint
	}

	style := m.styles.editorBox.Copy().Width(maxInt(20, m.frameWidth()))
	content := m.composer.View()
	box := style.Render(content)

	width := m.frameWidth()
	right := m.editorMeta()
	if right == "" {
		return box + "\n" + m.styles.editorHint.Render(truncateLine(hint, width))
	}

	rightStyled := m.styles.muted.Render(right)
	rightWidth := lipglossWidth(rightStyled)
	if rightWidth >= width {
		return box + "\n" + truncateLine(rightStyled, width)
	}

	leftAvail := width - rightWidth - 1
	leftStyled := m.styles.editorHint.Render(truncateLine(hint, leftAvail))
	gap := width - lipglossWidth(leftStyled) - rightWidth
	if gap < 1 {
		gap = 1
	}
	bottomLine := leftStyled + strings.Repeat(" ", gap) + rightStyled
	return box + "\n" + bottomLine
}

func (m *Model) setToast(text string) {
	m.toast = text
	m.toastUntil = time.Now().Add(toastDuration)
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
