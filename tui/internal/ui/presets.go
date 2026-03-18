package ui

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/config"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
	"github.com/lihaozhe013/pie/tui/internal/session"
)

// fallbackExtensionTools lists the extension tools pie ships or loads, used
// only when the bridge cannot publish the live inventory.
var fallbackExtensionTools = []string{
	"ask_user",
	"codemode",
	"tool_search",
	"get_goal",
	"update_goal",
	"goal_resume",
	"release_workflow",
	"get_background_activity",
}

// toolSnapshot is the JSON the bridge writes for /pie-publish.
type toolSnapshot struct {
	ActiveTools   []string       `json:"activeTools"`
	Tools         []snapshotTool `json:"tools"`
	SystemPrompt  string         `json:"systemPrompt"`
	WorkMode      string         `json:"workMode"`
	ToolSelection *struct {
		Tools          []string `json:"tools"`
		ExtensionTools string   `json:"extensionTools"`
	} `json:"toolSelection"`
}

type snapshotTool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Active      bool   `json:"active"`
}

// presetDraft is the mutable state of the preset editor.
type presetDraft struct {
	Preset        config.CustomPreset
	IsNew         bool
	confirmDelete bool
}

// currentPresetID resolves the session's tool selection to a preset selection.
func (m *Model) currentPresetID() string {
	var custom []config.CustomPreset
	if m.presetFile != nil {
		custom = m.presetFile.Presets()
	}
	var tools []string
	if m.hasSelection {
		tools = m.selection.Tools
	}
	return config.PresetForToolNames(tools, m.currentMode, custom)
}

// presetLabel is the human-readable name of a preset selection.
func (m *Model) presetLabel(selection string) string {
	if strings.HasPrefix(selection, config.CustomPresetPrefix) {
		id := strings.TrimPrefix(selection, config.CustomPresetPrefix)
		if m.presetFile != nil {
			if preset, ok := m.presetFile.Find(id); ok {
				return preset.Name
			}
		}
		return "custom preset"
	}
	if preset, ok := config.BuiltinPresetByID(selection); ok {
		return preset.Name
	}
	return selection
}

// presetTools returns the tool list a selection pins, and nil for configured.
func (m *Model) presetTools(selection string) ([]string, bool, bool) {
	var custom []config.CustomPreset
	if m.presetFile != nil {
		custom = m.presetFile.Presets()
	}
	tools, includeExtensions, ok := config.LookupSelection(selection, custom)
	return tools, includeExtensions, ok
}

func presetToolsSummary(tools []string) string {
	if tools == nil {
		return "follows settings.json"
	}
	if len(tools) == 0 {
		return "no coding tools"
	}
	return strings.Join(tools, ", ")
}

// presetItems builds the picker entries, marking the current preset.
func (m *Model) presetItems() []pickerItem {
	current := m.currentPresetID()
	items := make([]pickerItem, 0, len(config.BuiltinPresets)+4)
	for _, preset := range config.BuiltinPresets {
		detail := presetToolsSummary(preset.Tools)
		if preset.WorkMode != "" {
			detail += " · " + preset.WorkMode + " mode"
		}
		if current == preset.ID {
			detail += " · current"
		}
		items = append(items, pickerItem{Value: preset.ID, Label: preset.Name, Detail: detail})
	}
	if m.presetFile != nil {
		for _, preset := range m.presetFile.Presets() {
			detail := presetToolsSummary(preset.Tools)
			if !preset.IncludeExtensions {
				detail += " · selected extension tools"
			}
			selection := config.CustomPresetPrefix + preset.ID
			if current == selection {
				detail += " · current"
			}
			items = append(items, pickerItem{Value: selection, Label: preset.Name, Detail: detail})
		}
	}
	return items
}

func (m *Model) openPresetPicker() tea.Cmd {
	m.openOverlay(newPickerOverlay("preset", "Tool preset", m.presetItems()))
	return m.loadEntries()
}

// resolvePresetArg accepts a built-in id or name, a custom id or name, or a
// custom:<id> selection.
func (m *Model) resolvePresetArg(arg string) (string, bool) {
	needle := strings.ToLower(strings.TrimSpace(arg))
	if needle == "" {
		return "", false
	}
	for _, preset := range config.BuiltinPresets {
		if strings.ToLower(preset.ID) == needle || strings.ToLower(preset.Name) == needle {
			return preset.ID, true
		}
	}
	if m.presetFile == nil {
		return "", false
	}
	for _, preset := range m.presetFile.Presets() {
		id := strings.ToLower(preset.ID)
		name := strings.ToLower(preset.Name)
		if needle == id || needle == name || needle == config.CustomPresetPrefix+id {
			return config.CustomPresetPrefix + preset.ID, true
		}
	}
	return "", false
}

// applyPreset pins a tool set through the bridge and records the work mode.
func (m *Model) applyPreset(selection string) tea.Cmd {
	return m.applyPresetWithOptions(selection, false)
}

// applyPresetQuiet applies a preset without a toast, for the startup restore.
func (m *Model) applyPresetQuiet(selection string) tea.Cmd {
	return m.applyPresetWithOptions(selection, true)
}

func (m *Model) applyPresetWithOptions(selection string, quiet bool) tea.Cmd {
	if m.busy {
		if !quiet {
			m.setToast("wait for the current turn to finish")
		}
		return nil
	}
	if !m.bridgeReady {
		if !quiet {
			m.setToast("bridge extension unavailable; cannot change tools")
		}
		return nil
	}
	tools, includeExtensions, ok := m.presetTools(selection)
	if !ok {
		if !quiet {
			m.setToast("preset no longer exists")
		}
		return nil
	}

	targetMode := ""
	if selection == "plan" {
		targetMode = "plan"
	}
	client := m.client
	return func() tea.Msg {
		msg := presetAppliedMsg{selection: selection, quiet: quiet}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		if selection == "configured" {
			if _, err := client.DoOK(ctx, rpc.Prompt("/pie-tools configured")); err != nil {
				msg.err = err
				return msg
			}
		} else {
			policy := "all"
			if !includeExtensions {
				policy = "selected"
			}
			command := "/pie-tools " + policy
			if len(tools) > 0 {
				command += " " + strings.Join(tools, ",")
			}
			if _, err := client.DoOK(ctx, rpc.Prompt(command)); err != nil {
				msg.err = err
				return msg
			}
		}

		// The mode lives in its own entry; write it only when it changes, so a
		// repeated apply does not grow the session log.
		if entries, err := fetchEntries(ctx, client); err == nil {
			if session.ReadWorkMode(entries) != targetMode {
				modeArg := "none"
				if targetMode != "" {
					modeArg = targetMode
				}
				if _, err := client.DoOK(ctx, rpc.Prompt("/pie-mode "+modeArg)); err != nil {
					msg.err = err
					return msg
				}
			}
		}
		return msg
	}
}

// restoreSavedPreset reapplies the last preset chosen in the terminal when the
// session records none of its own. Presets live in the session log, so a fresh
// launch, /new, or a project switch keeps the tool set the person used last,
// while a resumed conversation keeps the selection it saved.
func (m *Model) restoreSavedPreset() tea.Cmd {
	if m.presetRestored || !m.entriesLoaded || m.prefs == nil {
		return nil
	}
	if m.state.MessageCount > 0 || m.hasSelection || m.currentMode != "" || m.busy {
		m.presetRestored = true
		return nil
	}
	if !m.bridgeReady {
		// commandsMsg retries once pi advertises the bridge.
		return nil
	}
	selection := m.prefs.ToolPreset()
	m.presetRestored = true
	if selection == "" || selection == "configured" {
		return nil
	}
	if _, _, ok := m.presetTools(selection); !ok {
		// The custom preset was deleted since it was saved.
		return nil
	}
	return m.applyPresetQuiet(selection)
}

// resetPresetRestore lets the saved preset apply to the next loaded session.
func (m *Model) resetPresetRestore() {
	m.presetRestored = false
	m.entriesLoaded = false
}

func fetchEntries(ctx context.Context, client Client) ([]session.LogEntry, error) {
	response, err := client.DoOK(ctx, rpc.GetEntries(""))
	if err != nil {
		return nil, err
	}
	var payload struct {
		Entries []session.LogEntry `json:"entries"`
	}
	if err := response.DecodeData(&payload); err != nil {
		return nil, err
	}
	return payload.Entries, nil
}

func (m *Model) loadEntries() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		entries, err := fetchEntries(ctx, client)
		return entriesMsg{entries: entries, err: err}
	}
}

// loadToolSnapshot asks the bridge for the live tool inventory. It is skipped
// when the bridge is unavailable; the editor then lists the static fallback.
func (m *Model) loadToolSnapshot() tea.Cmd {
	if !m.bridgeReady {
		return nil
	}
	client := m.client
	return func() tea.Msg {
		dir, err := os.MkdirTemp("", "pie-snapshot-*")
		if err != nil {
			return snapshotMsg{err: err}
		}
		defer func() { _ = os.RemoveAll(dir) }()
		path := filepath.Join(dir, "snapshot.json")

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := client.DoOK(ctx, rpc.Prompt("/pie-publish "+path)); err != nil {
			return snapshotMsg{err: err}
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return snapshotMsg{err: err}
		}
		var snapshot toolSnapshot
		if err := json.Unmarshal(data, &snapshot); err != nil {
			return snapshotMsg{err: err}
		}
		return snapshotMsg{snapshot: snapshot}
	}
}

// toolCatalog is the set of tools the preset editor offers: the built-in
// coding tools plus every tool the bridge reported.
func (m *Model) toolCatalog() []string {
	names := append([]string(nil), config.CanonicalCodingTools...)
	if m.toolSnapshot != nil && len(m.toolSnapshot.Tools) > 0 {
		for _, tool := range m.toolSnapshot.Tools {
			if tool.Name != "" {
				names = append(names, tool.Name)
			}
		}
	} else {
		names = append(names, fallbackExtensionTools...)
	}
	return config.SortToolNames(names)
}

func containsTool(tools []string, name string) bool {
	for _, tool := range tools {
		if tool == name {
			return true
		}
	}
	return false
}

func toggleTool(tools []string, name string, on bool) []string {
	if on {
		if containsTool(tools, name) {
			return tools
		}
		return append(tools, name)
	}
	out := tools[:0]
	for _, tool := range tools {
		if tool != name {
			out = append(out, tool)
		}
	}
	return out
}

// toolsSettingsTab lists the presets and the current selection.
func (m *Model) toolsSettingsTab() settingsTab {
	tab := settingsTab{
		ID:    "tools",
		Label: "Tools",
		Note:  "Presets pin a tool set on this session; the configured preset follows settings.json.",
	}

	tab.Rows = append(tab.Rows, settingsRow{
		ID:    "current-preset",
		Label: "Current",
		Kind:  settingsInfo,
		Current: func() string {
			id := m.currentPresetID()
			tools, _, _ := m.presetTools(id)
			return m.presetLabel(id) + " · " + presetToolsSummary(tools)
		},
	})

	if m.settings != nil {
		tab.Rows = append(tab.Rows,
			settingsRow{
				ID:    "codemode-preference",
				Label: "Code mode",
				Kind:  settingsChoice,
				Help:  "Automatic activates codemode when an MCP server exposes codemode tools; Always starts every session with it.",
				Current: func() string {
					preference, err := m.settings.CodemodePreference()
					if err != nil {
						return "invalid"
					}
					return preference
				},
				Choices: []pickerItem{
					{Value: "automatic", Label: "automatic", Detail: "activate on the first codemode server"},
					{Value: "always", Label: "always", Detail: "start sessions with +codemode"},
				},
				Apply: m.settings.SetCodemodePreference,
			},
			settingsRow{
				ID:    "codemode-mode",
				Label: "Code mode tools",
				Kind:  settingsChoice,
				Help:  "On keeps the normal tools beside codemode; Only routes built-in tools through codemode.",
				Current: func() string {
					mode, err := m.settings.CodemodeMode()
					if err != nil {
						return "invalid"
					}
					return mode
				},
				Choices: []pickerItem{
					{Value: "on", Label: "on", Detail: "codemode plus the built-in tools"},
					{Value: "only", Label: "only", Detail: "codemode is the only coding tool"},
				},
				Apply: m.settings.SetCodemodeMode,
			},
			settingsRow{
				ID:    "codemode-budget",
				Label: "Inline result budget",
				Kind:  settingsText,
				Help:  "Characters of a codemode result returned inline; blank uses pi's default.",
				Current: func() string {
					budget, ok, err := m.settings.CodemodeInlineBudget()
					if err != nil || !ok {
						return "default"
					}
					return fmt.Sprintf("%d", budget)
				},
				EditValue: func() string {
					budget, ok, err := m.settings.CodemodeInlineBudget()
					if err != nil || !ok {
						return ""
					}
					return fmt.Sprintf("%d", budget)
				},
				Apply: func(value string) error {
					value = strings.TrimSpace(value)
					if value == "" || strings.EqualFold(value, "default") {
						return m.settings.SetCodemodeInlineBudget(nil)
					}
					budget, err := strconv.Atoi(value)
					if err != nil || budget < 0 || budget > config.CodemodeInlineBudgetMax {
						return fmt.Errorf("budget must be 0..%d", config.CodemodeInlineBudgetMax)
					}
					return m.settings.SetCodemodeInlineBudget(&budget)
				},
			},
		)
	}

	if m.settings != nil && runtime.GOOS == "windows" {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "powershell-tool",
			Label: "PowerShell tool",
			Kind:  settingsToggle,
			Help:  "Replaces bash with powershell in the resolved default tools.",
			Bool: func() bool {
				enabled, err := m.settings.PowerShellEnabled(runtime.GOOS)
				return err == nil && enabled
			},
			SetBool: func(on bool) error { return m.settings.SetPowerShellEnabled(on) },
		})
	}

	if m.presetFile != nil && m.presetFile.Invalid() != nil {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "presets-invalid",
			Label: "Preset file",
			Kind:  settingsInfo,
			Current: func() string {
				return "invalid: " + m.presetFile.Invalid().Error()
			},
			Help: "Saving from the editor replaces it and keeps a .corrupt-* backup.",
		})
	}

	for _, preset := range config.BuiltinPresets {
		preset := preset
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "apply-" + preset.ID,
			Label: "Apply: " + preset.Name,
			Kind:  settingsAction,
			Help:  preset.Description,
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				return m.applyPreset(preset.ID)
			},
		})
	}

	if m.presetFile != nil {
		for _, preset := range m.presetFile.Presets() {
			preset := preset
			tab.Rows = append(tab.Rows, settingsRow{
				ID:    "edit-" + preset.ID,
				Label: "Edit: " + preset.Name,
				Kind:  settingsAction,
				Help:  presetToolsSummary(preset.Tools),
				Run: func(m *Model, _ *settingsState) tea.Cmd {
					m.openPresetEditor(&presetDraft{Preset: preset})
					return nil
				},
			})
		}
	}

	tab.Rows = append(tab.Rows, settingsRow{
		ID:    "new-preset",
		Label: "New preset",
		Kind:  settingsAction,
		Help:  "Combine coding and extension tools; stored beside pi's files.",
		Run: func(m *Model, _ *settingsState) tea.Cmd {
			m.openPresetEditor(&presetDraft{
				Preset: config.CustomPreset{IncludeExtensions: true, Tools: []string{"read"}},
				IsNew:  true,
			})
			return nil
		},
	})

	return tab
}

// presetTabs builds the single-tab editor for one draft.
func (m *Model) presetTabs(draft *presetDraft) []settingsTab {
	label := draft.Preset.Name
	if strings.TrimSpace(label) == "" {
		label = "New"
	}
	tab := settingsTab{ID: "preset", Label: label, Note: "Saved to " + m.paths.Presets()}

	tab.Rows = append(tab.Rows, settingsRow{
		ID:    "name",
		Label: "Name",
		Kind:  settingsText,
		Current: func() string {
			if strings.TrimSpace(draft.Preset.Name) == "" {
				return "(untitled)"
			}
			return draft.Preset.Name
		},
		EditValue: func() string { return draft.Preset.Name },
		Apply: func(value string) error {
			draft.Preset.Name = value
			return nil
		},
	})

	tab.Rows = append(tab.Rows, settingsRow{
		ID:    "include-extensions",
		Label: "Keep extension tools",
		Help:  "When off, only the tools selected below are active, including installed extension tools.",
		Kind:  settingsToggle,
		Bool:  func() bool { return draft.Preset.IncludeExtensions },
		SetBool: func(on bool) error {
			draft.Preset.IncludeExtensions = on
			return nil
		},
	})

	for _, name := range m.toolCatalog() {
		name := name
		if name == "powershell" {
			continue
		}
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "tool-" + name,
			Label: "  " + name,
			Kind:  settingsToggle,
			Bool:  func() bool { return containsTool(draft.Preset.Tools, name) },
			SetBool: func(on bool) error {
				draft.Preset.Tools = toggleTool(draft.Preset.Tools, name, on)
				return nil
			},
		})
	}

	tab.Rows = append(tab.Rows, settingsRow{
		ID:    "save-preset",
		Label: "Save",
		Kind:  settingsAction,
		Help:  "Writes pie-tool-presets.json; the web UI sees it immediately.",
		Run: func(m *Model, s *settingsState) tea.Cmd {
			if err := m.savePresetDraft(draft); err != nil {
				s.err = err.Error()
				return nil
			}
			cmd := m.openSettingsAt("tools")
			if m.settingsPanel != nil {
				m.settingsPanel.notice = "preset saved"
			}
			return cmd
		},
	})

	if !draft.IsNew {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "apply-preset",
			Label: "Save and apply",
			Kind:  settingsAction,
			Help:  "Pin this preset on the current session.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				if err := m.savePresetDraft(draft); err != nil {
					s.err = err.Error()
					return nil
				}
				selection := config.CustomPresetPrefix + draft.Preset.ID
				m.openSettingsAt("tools")
				return m.applyPreset(selection)
			},
		})
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "delete-preset",
			Label: "Delete",
			Kind:  settingsAction,
			Help:  "Press enter twice to delete this preset.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				if !draft.confirmDelete {
					draft.confirmDelete = true
					s.notice = "press enter again to delete"
					return nil
				}
				if err := m.deletePresetDraft(draft); err != nil {
					s.err = err.Error()
					return nil
				}
				cmd := m.openSettingsAt("tools")
				if m.settingsPanel != nil {
					m.settingsPanel.notice = "preset deleted"
				}
				return cmd
			},
		})
	}

	tab.Rows = append(tab.Rows, settingsRow{
		ID:    "cancel-preset",
		Label: "Cancel",
		Kind:  settingsAction,
		Run: func(m *Model, _ *settingsState) tea.Cmd {
			m.presetDraft = nil
			return m.openSettingsAt("tools")
		},
	})

	return []settingsTab{tab}
}

func (m *Model) openPresetEditor(draft *presetDraft) {
	m.presetDraft = draft
	name := strings.TrimSpace(draft.Preset.Name)
	title := "New tool preset"
	if !draft.IsNew {
		title = "Tool preset: " + name
	}
	state := newSettingsPanel(title, m.presetTabs(draft))
	state.action = "preset-editor"
	m.settingsPanel = state
	m.openOverlay(&overlay{kind: overlaySettings, action: "preset-editor", settings: state})
}

// openSettingsAt rebuilds the main settings panel and selects a tab.
func (m *Model) openSettingsAt(tabID string) tea.Cmd {
	m.reloadConfig()
	m.presetDraft = nil
	m.settingsPanel = nil
	m.openSettingsOverlay()
	if m.settingsPanel != nil {
		m.settingsPanel.selectTab(tabID)
	}
	return tea.Batch(m.loadEntries(), m.loadToolSnapshot())
}

func (m *Model) savePresetDraft(draft *presetDraft) error {
	if m.presetFile == nil {
		return fmt.Errorf("preset file unavailable")
	}
	presets := m.presetFile.Presets()
	updated := draft.Preset
	updated.Name = strings.TrimSpace(updated.Name)
	updated.Tools = config.SortToolNames(updated.Tools)

	if draft.IsNew {
		updated.ID = config.NewPresetID()
		presets = append(presets, updated)
	} else {
		found := false
		for i := range presets {
			if presets[i].ID == updated.ID {
				presets[i] = updated
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("preset no longer exists")
		}
	}
	if err := m.presetFile.Save(presets); err != nil {
		return err
	}
	draft.Preset = updated
	draft.IsNew = false
	draft.confirmDelete = false
	m.reloadConfig()
	return nil
}

func (m *Model) deletePresetDraft(draft *presetDraft) error {
	if m.presetFile == nil {
		return fmt.Errorf("preset file unavailable")
	}
	presets := m.presetFile.Presets()
	out := presets[:0]
	found := false
	for _, preset := range presets {
		if preset.ID == draft.Preset.ID {
			found = true
			continue
		}
		out = append(out, preset)
	}
	if !found {
		return fmt.Errorf("preset no longer exists")
	}
	if err := m.presetFile.Save(out); err != nil {
		return err
	}
	if m.prefs != nil && m.prefs.ToolPreset() == config.CustomPresetPrefix+draft.Preset.ID {
		// Do not leave a saved selection pointing at a preset that is gone.
		_ = m.prefs.SetToolPreset("configured")
	}
	m.reloadConfig()
	return nil
}
