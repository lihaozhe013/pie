package ui

import (
	tea "github.com/charmbracelet/bubbletea"
)

// Page identifiers. The Settings home keeps client and pi preferences; every
// other page owns one domain and is opened by its own command.
const (
	pageSettings  = "settings"
	pageModels    = "models"
	pageProviders = "providers"
	pageSkills    = "skills"
	pageMCP       = "mcp"
	pagePlugins   = "plugins"
)

// isPageID reports whether id names a top-level page instead of a category on
// the Settings home.
func isPageID(id string) bool {
	switch id {
	case pageModels, pageProviders, pageSkills, pageMCP, pagePlugins:
		return true
	}
	return false
}

// manageModelsValue is the model picker's route to the Model settings page,
// where models are enabled or disabled.
const manageModelsValue = "\x00model-settings"

// isPageCommand reports whether a slash command opens a domain page.
func isPageCommand(name string) bool {
	switch name {
	case "/model-settings", "/providers", "/skills", "/mcp", "/plugins":
		return true
	}
	return false
}

// buildPage assembles one page from the current configuration.
func (m *Model) buildPage(id string) settingsPage {
	switch id {
	case pageModels:
		return settingsPage{ID: id, Title: "Model settings", Mode: pageSections, Tabs: m.modelsSettingsTabs()}
	case pageProviders:
		return settingsPage{ID: id, Title: "Providers", Mode: pageSections, Tabs: []settingsTab{m.providersSettingsTab()}}
	case pageSkills:
		return settingsPage{ID: id, Title: "Skills", Mode: pageSections, Tabs: []settingsTab{m.skillsSettingsTab()}}
	case pageMCP:
		return settingsPage{ID: id, Title: "MCP", Mode: pageSections, Tabs: []settingsTab{m.mcpSettingsTab()}}
	case pagePlugins:
		return settingsPage{ID: id, Title: "Plugins", Mode: pageSections, Tabs: []settingsTab{m.pluginsSettingsTab()}}
	}
	return settingsPage{
		ID:    pageSettings,
		Title: "Settings",
		Mode:  pageCategories,
		Tabs: []settingsTab{
			m.generalSettingsTab(),
			m.instructionsSettingsTab(),
			m.toolsSettingsTab(),
		},
	}
}

// openSettings reloads the shared files and opens the Settings home.
func (m *Model) openSettings() tea.Cmd {
	return m.openPage(pageSettings)
}

// openPage reloads the shared files and opens one top-level page. Reopening the
// page that is already loaded keeps its filter and cursor.
func (m *Model) openPage(id string) tea.Cmd {
	m.reloadConfig()
	m.presetDraft = nil
	if m.settingsPanel != nil && !m.settingsPanel.detail && m.settingsPanel.page.ID == id {
		m.settingsPanel.rebuild(m)
		m.showPage(m.settingsPanel)
		return tea.Batch(m.loadEntries(), m.loadToolSnapshot())
	}
	m.showPage(newPageState(m.buildPage(id)))
	return tea.Batch(m.loadEntries(), m.loadToolSnapshot())
}

// openSettingsAt opens a page by id, or a Settings category when id names one.
// It is the single entry point the drill-down panels use to go back, so a
// provider detail returns to Providers and a preset editor to Tools.
func (m *Model) openSettingsAt(id string) tea.Cmd {
	if isPageID(id) {
		return m.openPage(id)
	}
	m.reloadConfig()
	m.presetDraft = nil
	state := newPageState(m.buildPage(pageSettings))
	state.selectTab(id)
	m.showPage(state)
	return tea.Batch(m.loadEntries(), m.loadToolSnapshot())
}

// showPage installs a page state as the open settings overlay.
func (m *Model) showPage(state *settingsState) {
	m.settingsPanel = state
	m.panelProvider = state.providerID
	m.panelUsageProvider = state.usageProviderID
	action := state.action
	if action == "" {
		if state.detail {
			action = "settings-panel"
		} else {
			action = "page-" + state.page.ID
		}
	}
	m.openOverlay(&overlay{kind: overlaySettings, action: action, settings: state})
}

// openSettingsOverlay reopens the panel that is already loaded. A picker or a
// sign-in step returns through here, so the page keeps its filter and cursor.
func (m *Model) openSettingsOverlay() {
	if m.settingsPanel == nil {
		m.settingsPanel = newPageState(m.buildPage(pageSettings))
	} else {
		m.settingsPanel.rebuild(m)
	}
	state := m.settingsPanel
	action := state.action
	if action == "" {
		if state.detail {
			action = "settings-panel"
		} else {
			action = "page-" + state.page.ID
		}
	}
	m.openOverlay(&overlay{kind: overlaySettings, action: action, settings: state})
}

// pushSettingsPanel creates a drill-down panel whose parent is the currently open
// settings panel, so esc unwinds one level instead of jumping back to the root.
func (m *Model) pushSettingsPanel(fallbackID, title string, build func(*Model) []settingsTab) *settingsState {
	var tabs []settingsTab
	if build != nil {
		tabs = build(m)
	}
	state := newSettingsPanel(title, tabs)
	state.build = build
	if m.overlay != nil && m.overlay.kind == overlaySettings && m.settingsPanel != nil {
		state.parent = m.settingsPanel
	}
	state.back = func(mm *Model) tea.Cmd {
		return mm.popSettingsPanel(fallbackID)
	}
	return state
}

// popSettingsPanel pops the current settings panel, returning to its parent
// with cursor, scroll position, and filter preserved, or falls back to fallbackID.
func (m *Model) popSettingsPanel(fallbackID string) tea.Cmd {
	m.reloadConfig()
	if m.settingsPanel != nil && m.settingsPanel.parent != nil {
		parent := m.settingsPanel.parent
		parent.rebuild(m)
		m.showPage(parent)
		return tea.Batch(m.loadEntries(), m.loadToolSnapshot())
	}
	if fallbackID != "" {
		return m.openSettingsAt(fallbackID)
	}
	m.closeOverlay()
	return nil
}

// openSettingsPanelAt opens a drill-down panel that returns to parentID when
// the user presses esc.
func (m *Model) openSettingsPanelAt(parentID, title string, rows []settingsRow) {
	state := m.pushSettingsPanel(parentID, title, nil)
	state.tabs = []settingsTab{{
		ID:    "panel",
		Label: title,
		Rows:  rows,
	}}
	state.clampSelection()
	m.showPage(state)
}
