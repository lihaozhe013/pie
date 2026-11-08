package ui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/lihaozhe013/pie/tui/internal/config"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

// settingsRowKind selects how one settings row is edited.
type settingsRowKind int

const (
	settingsInfo settingsRowKind = iota
	settingsToggle
	settingsChoice
	settingsText
	settingsAction
)

// settingsRow is one editable line of the settings panel.
type settingsRow struct {
	ID    string
	Label string
	Help  string
	Kind  settingsRowKind

	Current   func() string
	EditValue func() string
	Choices   []pickerItem
	Apply     func(string) error
	Bool      func() bool
	SetBool   func(bool) error
	Run       func(m *Model, s *settingsState) tea.Cmd
}

// settingsTab is one section of the panel.
type settingsTab struct {
	ID    string
	Label string
	Note  string
	Rows  []settingsRow
}

// settingsState survives a round trip through a picker or the instruction
// editor, so the cursor returns where the user left it.
type settingsState struct {
	title  string
	single bool
	action string
	tabs   []settingsTab
	active int
	row    int
	scroll int

	editing bool
	input   textinput.Model

	notice string
	err    string
}

func newSettingsState(m *Model) *settingsState {
	return newSettingsPanel("Settings", m.buildSettingsTabs())
}

func newSettingsPanel(title string, tabs []settingsTab) *settingsState {
	input := textinput.New()
	input.Prompt = ""
	input.CharLimit = 0
	return &settingsState{
		title:  title,
		single: len(tabs) <= 1,
		action: "settings",
		tabs:   tabs,
		input:  input,
	}
}

// rebuild refreshes the rows from disk while keeping the selected tab and row.
func (s *settingsState) rebuild(m *Model) {
	if s.single {
		// Sub-panels own their rows; rebuilding them from the main tab list
		// would replace the panel under the user.
		return
	}
	tabID := ""
	rowID := ""
	if s.active >= 0 && s.active < len(s.tabs) {
		tab := s.tabs[s.active]
		tabID = tab.ID
		if s.row >= 0 && s.row < len(tab.Rows) {
			rowID = tab.Rows[s.row].ID
		}
	}
	s.tabs = m.buildSettingsTabs()
	s.selectTab(tabID)
	if rowID != "" {
		for i, row := range s.currentTab().Rows {
			if row.ID == rowID {
				s.row = i
				break
			}
		}
	}
	s.clamp()
}

func (s *settingsState) currentTab() settingsTab {
	if s.active < 0 || s.active >= len(s.tabs) {
		if len(s.tabs) == 0 {
			return settingsTab{}
		}
		s.active = 0
	}
	return s.tabs[s.active]
}

func (s *settingsState) currentRow() *settingsRow {
	tab := s.currentTab()
	if s.row < 0 || s.row >= len(tab.Rows) {
		return nil
	}
	return &tab.Rows[s.row]
}

func (s *settingsState) selectTab(id string) {
	for i, tab := range s.tabs {
		if tab.ID == id {
			s.active = i
			s.row = 0
			s.scroll = 0
			return
		}
	}
	s.active = 0
	s.row = 0
	s.scroll = 0
}

func (s *settingsState) clamp() {
	tab := s.currentTab()
	if s.row >= len(tab.Rows) {
		s.row = maxInt(0, len(tab.Rows)-1)
	}
	if s.row < 0 {
		s.row = 0
	}
}

func (s *settingsState) move(delta int) {
	tab := s.currentTab()
	if len(tab.Rows) == 0 {
		return
	}
	s.row = (s.row + delta + len(tab.Rows)) % len(tab.Rows)
	s.err = ""
	s.notice = ""
}

func (s *settingsState) switchTab(delta int) {
	if len(s.tabs) == 0 {
		return
	}
	s.active = (s.active + delta + len(s.tabs)) % len(s.tabs)
	s.row = 0
	s.scroll = 0
	s.err = ""
	s.notice = ""
}

// padRight pads a styled string to width without counting escape codes.
func padRight(s string, width int) string {
	gap := width - lipglossWidth(s)
	if gap <= 0 {
		return truncateLine(s, width)
	}
	return s + strings.Repeat(" ", gap)
}

// View renders the whole settings box.
func (s *settingsState) View(st styles, width, height int) string {
	boxWidth := width - 8
	if boxWidth > 96 {
		boxWidth = 96
	}
	if boxWidth < 44 {
		boxWidth = 44
	}
	railWidth := 18
	innerWidth := boxWidth - 4
	contentWidth := maxInt(12, innerWidth-railWidth-2)
	if s.single {
		railWidth = 0
		contentWidth = maxInt(12, innerWidth)
	} else if innerWidth < railWidth+12 {
		railWidth = maxInt(10, innerWidth/3)
		contentWidth = maxInt(12, innerWidth-railWidth-2)
	}

	rowsHeight := height - 8
	if s.editing {
		rowsHeight -= 2
	}
	if rowsHeight < 3 {
		rowsHeight = 3
	}
	tab := s.currentTab()

	if s.row < s.scroll {
		s.scroll = s.row
	}
	if s.row >= s.scroll+rowsHeight {
		s.scroll = s.row - rowsHeight + 1
	}

	// Left rail: one line per tab, padded to the rail width.
	rail := make([]string, 0, rowsHeight)
	if !s.single {
		for i := 0; i < rowsHeight; i++ {
			if i < len(s.tabs) {
				entry := s.tabs[i]
				prefix := "  "
				if i == s.active {
					prefix = "› "
					rail = append(rail, padRight(st.pickerSel.Render(prefix+entry.Label), railWidth))
				} else {
					rail = append(rail, padRight(st.muted.Render(prefix+entry.Label), railWidth))
				}
				continue
			}
			rail = append(rail, strings.Repeat(" ", railWidth))
		}
	}

	// Right pane: rows, then help and hints.
	detail := make([]string, 0, rowsHeight)
	for i := 0; i < rowsHeight; i++ {
		index := s.scroll + i
		if index >= len(tab.Rows) {
			detail = append(detail, "")
			continue
		}
		detail = append(detail, s.renderRow(st, tab.Rows[index], index == s.row, contentWidth))
	}

	lines := make([]string, 0, height)
	titleText := s.title
	if !s.single {
		titleText += "  ·  " + tab.Label
	}
	title := st.overlayHead.Render(titleText)
	lines = append(lines, padRight(title, innerWidth))
	for i := 0; i < rowsHeight; i++ {
		if s.single {
			lines = append(lines, detail[i])
			continue
		}
		lines = append(lines, rail[i]+"  "+detail[i])
	}

	help := tab.Note
	if row := s.currentRow(); row != nil && row.Help != "" {
		help = row.Help
	}
	lines = append(lines, "")
	lines = append(lines, st.overlayHint.Render(truncateLine(help, innerWidth)))

	if s.editing {
		s.input.Width = maxInt(10, contentWidth-2)
		lines = append(lines, "  "+s.input.View())
	}

	switch {
	case s.err != "":
		lines = append(lines, st.errorText.Render(truncateLine(s.err, innerWidth)))
	case s.notice != "":
		lines = append(lines, st.notice.Render(truncateLine(s.notice, innerWidth)))
	case s.editing:
		lines = append(lines, st.overlayHint.Render("enter save · esc cancel"))
	case s.single:
		lines = append(lines, st.overlayHint.Render("↑/↓ move · enter change · esc back"))
	default:
		lines = append(lines, st.overlayHint.Render("↑/↓ move · ←/→ tab · enter change · / search · r reload · esc close"))
	}

	box := st.overlayBox.Copy().Width(boxWidth).Render(strings.Join(lines, "\n"))
	return box
}

func (s *settingsState) renderRow(st styles, row settingsRow, selected bool, width int) string {
	label := row.Label
	value := ""
	labelStyle := st.pickerItem
	valueStyle := st.muted
	switch row.Kind {
	case settingsInfo:
		labelStyle = st.muted
		if row.Current != nil {
			value = row.Current()
		}
	case settingsToggle:
		labelStyle = st.pickerItem
		on := row.Bool != nil && row.Bool()
		if on {
			value = "on"
			valueStyle = st.accent
		} else {
			value = "off"
		}
	case settingsChoice, settingsText:
		if row.Current != nil {
			value = row.Current()
		}
		if value == "" {
			value = "—"
		}
	case settingsAction:
		if row.Current != nil {
			value = row.Current()
		} else {
			value = "enter"
		}
	}

	if selected {
		labelStyle = st.pickerSel
	}
	prefix := "  "
	if selected {
		prefix = "› "
	}

	labelWidth := minInt(30, maxInt(12, width/2))
	labelText := truncateLine(prefix+label, labelWidth)
	labelText = padRight(labelText, labelWidth)
	available := width - labelWidth
	valueText := truncateLine(value, available)
	gap := available - lipglossWidth(valueText)
	if gap > 0 {
		valueText = strings.Repeat(" ", gap) + valueText
	}
	return labelStyle.Render(labelText) + valueStyle.Render(valueText)
}

// handleKey processes keys while the settings panel is open.
func (m *Model) handleSettingsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	s := m.settingsPanel
	if s == nil {
		m.closeOverlay()
		return m, nil
	}
	key := msg.String()

	if s.editing {
		switch key {
		case "enter":
			row := s.currentRow()
			value := s.input.Value()
			s.editing = false
			s.input.Blur()
			if row != nil && row.Apply != nil {
				if err := row.Apply(value); err != nil {
					s.err = err.Error()
				} else {
					s.notice = "saved"
				}
			}
			m.layout()
			return m, nil
		case "esc":
			s.editing = false
			s.input.Blur()
			s.err = ""
			m.layout()
			return m, nil
		case "ctrl+c":
			return m, tea.Quit
		}
		var cmd tea.Cmd
		s.input, cmd = s.input.Update(msg)
		return m, cmd
	}

	tab := s.currentTab()
	switch key {
	case "esc", "q":
		if m.overlay.action == "preset-editor" {
			m.presetDraft = nil
			return m, m.openSettingsAt("tools")
		}
		if m.overlay.action == "settings-panel" {
			tabID := m.panelTab
			if tabID == "" {
				tabID = "models"
			}
			return m, m.openSettingsAt(tabID)
		}
		if m.overlay.action == "skill-detail" {
			return m, m.openSettingsAt("skills")
		}
		if m.overlay.action == "package-detail" {
			return m, m.openSettingsAt("plugins")
		}
		if m.overlay.action == "mcp-detail" {
			return m, m.openSettingsAt("mcp")
		}
		m.closeOverlay()
		return m, nil
	case "ctrl+c":
		return m, tea.Quit
	case "up", "k":
		s.move(-1)
		return m, nil
	case "down", "j":
		s.move(1)
		return m, nil
	case "pgup":
		s.move(-5)
		return m, nil
	case "pgdown":
		s.move(5)
		return m, nil
	case "home", "g":
		s.row = 0
		return m, nil
	case "end", "G":
		s.row = maxInt(0, len(tab.Rows)-1)
		return m, nil
	case "left", "shift+tab", "h":
		s.switchTab(-1)
		return m, nil
	case "right", "tab", "l":
		s.switchTab(1)
		return m, nil
	case "r":
		m.reloadConfig()
		s.rebuild(m)
		s.notice = "reloaded from disk"
		return m, nil
	case "enter", " ":
		return m.activateSettingsRow()
	case "/":
		request := &rpc.ExtensionUIRequestEvent{Title: "Search settings", Method: "input", Placeholder: "theme, cache, provider"}
		overlay := newInputOverlay(request)
		overlay.action = "settings-search"
		m.openOverlay(overlay)
		return m, nil
	}
	return m, nil
}

func (m *Model) activateSettingsRow() (tea.Model, tea.Cmd) {
	s := m.settingsPanel
	row := s.currentRow()
	if row == nil {
		return m, nil
	}
	s.err = ""
	s.notice = ""

	switch row.Kind {
	case settingsToggle:
		if row.SetBool == nil || row.Bool == nil {
			return m, nil
		}
		if err := row.SetBool(!row.Bool()); err != nil {
			s.err = err.Error()
		}
		return m, nil
	case settingsText:
		if row.Apply == nil {
			return m, nil
		}
		s.editing = true
		value := ""
		if row.EditValue != nil {
			value = row.EditValue()
		} else if row.Current != nil {
			value = row.Current()
			if value == "—" {
				value = ""
			}
		}
		s.input.SetValue(value)
		s.input.CursorEnd()
		s.input.Focus()
		m.layout()
		return m, nil
	case settingsChoice:
		if len(row.Choices) == 0 || row.Apply == nil {
			return m, nil
		}
		m.pendingSettingsRow = row
		current := ""
		if row.Current != nil {
			current = row.Current()
		}
		items := make([]pickerItem, 0, len(row.Choices))
		for _, choice := range row.Choices {
			label := choice.Label
			if label == "" {
				label = choice.Value
			}
			if choice.Value == current {
				label += "  ·"
			}
			items = append(items, pickerItem{Value: choice.Value, Label: label, Detail: choice.Detail})
		}
		m.openOverlay(newPickerOverlay("settings-choice", row.Label, items))
		return m, nil
	case settingsAction:
		if row.Run != nil {
			return m, row.Run(m, s)
		}
	}
	return m, nil
}

func (m *Model) applySettingChoice(value string) tea.Cmd {
	row := m.pendingSettingsRow
	m.pendingSettingsRow = nil
	if row == nil {
		return nil
	}
	if err := row.Apply(value); err != nil {
		if m.settingsPanel != nil {
			m.settingsPanel.err = err.Error()
		}
	} else if m.settingsPanel != nil {
		m.settingsPanel.notice = "saved"
	}
	m.openSettingsOverlay()
	return nil
}

// openSettings reloads the shared files and opens the panel.
func (m *Model) openSettings() tea.Cmd {
	m.reloadConfig()
	// A single-tab panel (goal, a detail view) is not the settings home.
	if m.settingsPanel != nil && m.settingsPanel.single {
		m.settingsPanel = nil
	}
	m.panelProvider = ""
	m.panelUsageProvider = ""
	m.openSettingsOverlay()
	return tea.Batch(m.loadEntries(), m.loadToolSnapshot())
}

func (m *Model) openSettingsOverlay() {
	if m.settingsPanel == nil {
		m.settingsPanel = newSettingsState(m)
	} else if m.settingsPanel.single {
		// A detail panel survives a round trip through a picker.
		m.openOverlay(&overlay{kind: overlaySettings, action: m.settingsPanel.action, settings: m.settingsPanel})
		return
	} else {
		m.settingsPanel.rebuild(m)
	}
	action := m.settingsPanel.action
	if action == "" {
		action = "settings"
	}
	m.openOverlay(&overlay{kind: overlaySettings, action: action, settings: m.settingsPanel})
}

// editGlobalInstructions opens the multi-line editor over the settings panel.
func (m *Model) editGlobalInstructions(s *settingsState) tea.Cmd {
	text, err := config.ReadInstructions(m.paths)
	if err != nil {
		s.err = "read AGENTS.md: " + err.Error()
		return nil
	}
	request := &rpc.ExtensionUIRequestEvent{
		Title:   "Global instructions",
		Method:  "editor",
		Prefill: text,
		Message: m.paths.Agents() + "\nSaved text applies to new pi runs; use reload to apply now.",
	}
	editor := newEditorOverlay(request)
	editor.action = "settings-agents"
	m.openOverlay(editor)
	return nil
}

// buildSettingsTabs assembles every tab. Tabs land in this list as their phase
// is implemented; until then they explain what will appear.
func (m *Model) buildSettingsTabs() []settingsTab {
	return []settingsTab{
		m.generalSettingsTab(),
		m.instructionsSettingsTab(),
		m.appearanceSettingsTab(),
		m.modelsSettingsTab(),
		m.providersSettingsTab(),
		m.toolsSettingsTab(),
		m.skillsSettingsTab(),
		m.pluginsSettingsTab(),
		m.mcpSettingsTab(),
	}
}

func (m *Model) generalSettingsTab() settingsTab {
	tab := settingsTab{ID: "general", Label: "General", Note: "Shared settings are written to pi's files immediately."}

	if m.settings == nil {
		reason := "settings.json could not be read"
		if m.configErr != nil {
			reason += ": " + m.configErr.Error()
		}
		tab.Rows = append(tab.Rows, settingsRow{ID: "settings-error", Label: "settings.json", Kind: settingsInfo, Current: func() string { return reason }})
	} else {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "cache-notices",
			Label: "Cache-miss notices",
			Help:  "Show pi's notices for cache misses, warming, compaction, and provider recovery.",
			Kind:  settingsToggle,
			Bool: func() bool {
				on, _ := m.settings.ShowCacheMissNotices()
				return on
			},
			SetBool: m.settings.SetShowCacheMissNotices,
		})
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "session-dir",
			Label: "Session directory",
			Help:  "Where pi stores session files. Blank uses the agent directory. Restart pie to apply.",
			Kind:  settingsText,
			Current: func() string {
				dir, ok, err := m.settings.SessionDir()
				if err != nil || !ok {
					return "(default)"
				}
				return dir
			},
			EditValue: func() string {
				dir, ok, err := m.settings.SessionDir()
				if err != nil || !ok {
					return ""
				}
				return dir
			},
			Apply: m.settings.SetSessionDir,
		})
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "agent-dir",
			Label:   "Agent directory",
			Kind:    settingsInfo,
			Current: func() string { return m.paths.Dir },
		})
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "settings-path",
			Label:   "Settings file",
			Kind:    settingsInfo,
			Current: func() string { return m.paths.Settings() },
		})
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "bridge",
			Label: "Bridge extension",
			Help:  "Loaded from the pie state directory; enables hot tool switching and reload.",
			Kind:  settingsInfo,
			Current: func() string {
				if m.bridgeReady {
					return "ready"
				}
				return "unavailable"
			},
		})
	}

	if m.prefs != nil {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "show-thinking",
			Label: "Thinking blocks",
			Help:  "Show reasoning blocks in the transcript (also ctrl+t).",
			Kind:  settingsToggle,
			Bool:  m.prefs.ShowThinking,
			SetBool: func(on bool) error {
				if err := m.prefs.SetShowThinking(on); err != nil {
					return err
				}
				m.showThinking = on
				m.applyThinkingVisibility()
				return nil
			},
		})
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "goal-enabled",
			Label: "Goal controls",
			Help:  "Requires the goal package: " + goalInstallHint + ". Install it, restart pie, then enable this.",
			Kind:  settingsToggle,
			Bool:  func() bool { return m.goalEnabled },
			SetBool: func(on bool) error {
				if on && !m.goalAvailable {
					return fmt.Errorf("the goal package is not installed; run: %s and restart", goalInstallHint)
				}
				if err := m.prefs.SetGoalEnabled(on); err != nil {
					return err
				}
				m.goalEnabled = on
				return nil
			},
		})
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "expand-tools",
			Label: "Expand tool output",
			Help:  "Show every tool body in full; when off, long outputs fold (also ctrl+o).",
			Kind:  settingsToggle,
			Bool:  m.prefs.ExpandTools,
			SetBool: func(on bool) error {
				if err := m.prefs.SetExpandTools(on); err != nil {
					return err
				}
				m.expanded = on
				m.applyExpansion()
				return nil
			},
		})
	}

	tab.Rows = append(tab.Rows, settingsRow{
		ID:    "reload-pi",
		Label: "Reload pi",
		Help:  "Rereads settings.json, AGENTS.md, and instructions through the bridge without restarting the session.",
		Kind:  settingsAction,
		Run: func(m *Model, s *settingsState) tea.Cmd {
			return m.reloadPi()
		},
	})
	return tab
}

func (m *Model) instructionsSettingsTab() settingsTab {
	tab := settingsTab{
		ID:    "instructions",
		Label: "Instructions",
		Note:  "The global AGENTS.md applies to every project.",
	}
	size := "missing"
	if text, err := config.ReadInstructions(m.paths); err == nil {
		if strings.TrimSpace(text) == "" {
			size = "empty"
		} else {
			size = fmt.Sprintf("%d characters", len([]rune(text)))
		}
	} else {
		size = "unreadable: " + err.Error()
	}
	tab.Rows = append(tab.Rows,
		settingsRow{
			ID:    "edit-agents",
			Label: "Edit AGENTS.md",
			Help:  "Opens the multi-line editor. ctrl+s saves; esc returns here.",
			Kind:  settingsAction,
			Run:   func(m *Model, s *settingsState) tea.Cmd { return m.editGlobalInstructions(s) },
		},
		settingsRow{
			ID:      "agents-path",
			Label:   "File",
			Kind:    settingsInfo,
			Current: func() string { return m.paths.Agents() },
		},
		settingsRow{
			ID:      "agents-size",
			Label:   "Size",
			Kind:    settingsInfo,
			Current: func() string { return size },
		},
	)
	return tab
}

func (m *Model) appearanceSettingsTab() settingsTab {
	tab := settingsTab{
		ID:    "appearance",
		Label: "Appearance",
		Note:  "Terminal font, size, and width follow your terminal; colors follow the theme.",
	}
	choices := make([]pickerItem, 0, len(themeOptions))
	for _, option := range themeOptions {
		detail := option.Scheme
		if detail == "" {
			detail = "follows the terminal"
		}
		choices = append(choices, pickerItem{Value: option.ID, Label: option.Label, Detail: detail})
	}
	current := "auto"
	if m.prefs != nil {
		current = m.prefs.Theme()
	}
	if m.prefs != nil {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "enter-sends",
			Label: "Enter sends",
			Help:  "When off, enter inserts a newline and alt+enter sends.",
			Kind:  settingsToggle,
			Bool:  func() bool { return m.enterToSend },
			SetBool: func(on bool) error {
				if err := m.prefs.SetEnterToSend(on); err != nil {
					return err
				}
				m.enterToSend = on
				return nil
			},
		})
	}
	tab.Rows = append(tab.Rows, settingsRow{
		ID:      "theme",
		Label:   "Theme",
		Help:    "Paint the transcript and chrome with pie's palette.",
		Kind:    settingsChoice,
		Current: func() string { return ThemeLabel(current) },
		Choices: choices,
		Apply: func(value string) error {
			if m.prefs == nil {
				return fmt.Errorf("preferences are unavailable")
			}
			if err := m.prefs.SetTheme(value); err != nil {
				return err
			}
			current = value
			m.applyTheme(value)
			return nil
		},
	})
	return tab
}

// applyTheme rebuilds the style set and pushes it into the cached renderers.
func (m *Model) applyTheme(id string) {
	m.styles = newStyles(themeFor(id))
	m.transcript.SetStyles(m.styles)
	m.composer.SetStyles(m.styles)
	m.layout()
}

// openSettingsPanelAt opens a single-tab sub-panel that returns to tabID when
// the user presses esc.
func (m *Model) openSettingsPanelAt(tabID, title string, rows []settingsRow) {
	state := newSettingsPanel(title, []settingsTab{{
		ID:    "panel",
		Label: title,
		Rows:  rows,
	}})
	state.action = "settings-panel"
	m.settingsPanel = state
	m.panelTab = tabID
	m.panelProvider = ""
	m.panelUsageProvider = ""
	m.openOverlay(&overlay{kind: overlaySettings, action: "settings-panel", settings: state})
}
