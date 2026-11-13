package ui

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/config"
	"github.com/lihaozhe013/pie/tui/internal/modelcatalog"
)

// catalogRefreshedMsg reports a `pi update --models` run.
type catalogRefreshedMsg struct {
	err    error
	output string
}

// modelsSettingsTabs builds the Model settings page. It owns model selection,
// enabling, reasoning, and context windows; provider credentials and endpoints
// live on the Providers page.
func (m *Model) modelsSettingsTabs() []settingsTab {
	defaults := settingsTab{
		ID:    "models-defaults",
		Label: "Defaults",
		Note:  "Applies when pie starts; Pie applies it to its new sessions.",
	}
	selection := settingsTab{
		ID:    "models-selection",
		Label: "Models",
		Note:  "The catalog comes from pi; models.json overrides model metadata.",
	}
	catalog := settingsTab{ID: "models-catalog", Label: "Catalog"}

	if m.settings == nil {
		reason := "settings.json is unavailable"
		if m.configErr != nil {
			reason += ": " + m.configErr.Error()
		}
		defaults.Rows = append(defaults.Rows, settingsRow{
			ID:      "models-settings-error",
			Label:   "Settings",
			Kind:    settingsInfo,
			Current: func() string { return reason },
		})
		return []settingsTab{defaults}
	}

	projectScope := m.projectScope("defaultModel", "defaultThinkingLevel", "enabledModels", "modelThinkingLevels")

	defaults.Rows = append(defaults.Rows,
		settingsRow{
			ID:    "default-model",
			Label: "Default model",
			Help:  "Applies when pie starts; Pie applies it to its new sessions. Picking a model also writes its provider.",
			Kind:  settingsChoice,
			Current: func() string {
				provider, _ := m.settings.DefaultProvider()
				model, _ := m.settings.DefaultModel()
				if model == "" {
					return "auto"
				}
				if provider != "" {
					return provider + "/" + model
				}
				return model
			},
			Choices: m.modelChoices(),
			Apply: func(value string) error {
				if value == "auto" {
					return m.settings.SetDefaultModel("")
				}
				provider, model := splitModelRef(value)
				if provider != "" {
					if err := m.settings.SetDefaultProvider(provider); err != nil {
						return err
					}
				}
				return m.settings.SetDefaultModel(model)
			},
		},
		settingsRow{
			ID:      "default-thinking",
			Label:   "Default thinking level",
			Help:    "Applies when pie starts; Pie applies it to its new sessions.",
			Kind:    settingsChoice,
			Current: func() string { level, _ := m.settings.DefaultThinkingLevel(); return level },
			Choices: thinkingLevelChoices(false),
			Apply:   m.settings.SetDefaultThinkingLevel,
		},
		settingsRow{
			ID:        "context-limit",
			Label:     "Context window limit",
			Help:      "Shared with Pie, which applies the cap to its sessions; pi itself keeps the native window in the terminal. Blank or 'none' removes the cap; the default is 350000.",
			Kind:      settingsText,
			Current:   m.contextLimitLabel,
			EditValue: m.contextLimitEditValue,
			Apply:     m.setContextLimit,
		},
		settingsRow{
			ID:      "project-scope",
			Label:   "Project overrides",
			Kind:    settingsInfo,
			Current: func() string { return projectScope },
			Help:    "A project .pi/settings.json key wins over the global value this page edits.",
		},
	)

	selection.Rows = append(selection.Rows,
		settingsRow{
			ID:    "enabled-summary",
			Label: "Enabled models",
			Kind:  settingsInfo,
			Current: func() string {
				if m.catalog == nil {
					return "unknown"
				}
				enabled := 0
				for _, on := range m.enabledModels {
					if on {
						enabled++
					}
				}
				patterns, present, _ := m.settings.EnabledModels()
				if !present {
					return fmt.Sprintf("all %d", len(m.catalog.Models()))
				}
				return fmt.Sprintf("%d of %d · %d patterns", enabled, len(m.catalog.Models()), len(patterns))
			},
		},
		settingsRow{
			ID:    "manage-enabled",
			Label: "Manage enabled models",
			Help:  "Turn individual models on or off; the pattern list is edited minimally.",
			Kind:  settingsAction,
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				m.openEnabledProvidersPanel()
				return nil
			},
		},
		settingsRow{
			ID:    "context-windows",
			Label: "Per-model context windows",
			Help:  "Override a model's native context window in models.json.",
			Kind:  settingsAction,
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				m.openContextProvidersPanel()
				return nil
			},
		},
		settingsRow{
			ID:    "thinking-levels",
			Label: "Per-model thinking levels",
			Help:  "Override the startup thinking level for individual models.",
			Kind:  settingsAction,
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				m.openThinkingProvidersPanel()
				return nil
			},
		},
	)

	if m.catalogErr != nil {
		catalog.Rows = append(catalog.Rows, settingsRow{
			ID:      "catalog-error",
			Label:   "Catalog",
			Kind:    settingsInfo,
			Current: func() string { return "unavailable: " + m.catalogErr.Error() },
		})
	} else if m.catalog != nil {
		catalog.Rows = append(catalog.Rows, settingsRow{
			ID:    "catalog-summary",
			Label: "Catalog",
			Kind:  settingsInfo,
			Current: func() string {
				return fmt.Sprintf("%d providers · %d models", len(m.catalog.Providers), len(m.catalog.Models()))
			},
		})
	}
	catalog.Rows = append(catalog.Rows, settingsRow{
		ID:    "refresh-catalog",
		Label: "Refresh model catalog",
		Help:  "Runs `pi update --models`; new models appear after it finishes.",
		Kind:  settingsAction,
		Run: func(m *Model, _ *settingsState) tea.Cmd {
			return m.refreshCatalog()
		},
	})

	return []settingsTab{defaults, selection, catalog}
}

func (m *Model) contextLimitLabel() string {
	if m.modelSettings == nil {
		return "unavailable"
	}
	limit, capped := m.modelSettings.ContextWindowLimit()
	if !capped {
		return "no cap"
	}
	return strconv.Itoa(limit)
}

func (m *Model) contextLimitEditValue() string {
	if m.modelSettings == nil {
		return ""
	}
	if !m.modelSettings.ContextWindowConfigured() {
		return strconv.Itoa(config.DefaultContextWindowLimit)
	}
	limit, capped := m.modelSettings.ContextWindowLimit()
	if !capped {
		return "none"
	}
	return strconv.Itoa(limit)
}

func (m *Model) setContextLimit(value string) error {
	if m.modelSettings == nil {
		return fmt.Errorf("pie-model-settings.json unavailable")
	}
	text := strings.TrimSpace(value)
	if text == "" || strings.EqualFold(text, "none") {
		return m.modelSettings.SetContextWindowLimit(nil)
	}
	text = strings.ReplaceAll(text, ",", "")
	limit, err := strconv.Atoi(text)
	if err != nil || limit <= 0 {
		return fmt.Errorf("context window limit must be a positive number or 'none'")
	}
	return m.modelSettings.SetContextWindowLimit(&limit)
}

func (m *Model) providerChoices(includeAuto bool) []pickerItem {
	items := make([]pickerItem, 0, len(m.catalogProviders())+1)
	if includeAuto {
		items = append(items, pickerItem{Value: "auto", Label: "auto", Detail: "pi decides"})
	}
	for _, provider := range m.catalogProviders() {
		items = append(items, pickerItem{Value: provider.ID, Label: provider.Name, Detail: provider.ID})
	}
	return items
}

func (m *Model) catalogProviders() []*modelcatalog.Provider {
	if m.catalog == nil {
		return nil
	}
	return m.catalog.Providers
}

func (m *Model) modelChoices() []pickerItem {
	items := []pickerItem{{Value: "auto", Label: "auto", Detail: "pi decides"}}
	if m.catalog == nil {
		return items
	}
	for _, model := range m.catalog.SortedModels() {
		label := model.Name
		if label == "" {
			label = model.ID
		}
		items = append(items, pickerItem{
			Value:  model.Ref(),
			Label:  label,
			Detail: model.ProviderID + "/" + model.ID,
		})
	}
	return items
}

func thinkingLevelChoices(includeDefault bool) []pickerItem {
	items := make([]pickerItem, 0, len(config.ThinkingLevels)+1)
	if includeDefault {
		items = append(items, pickerItem{Value: "", Label: "(default)", Detail: "use the session default"})
	}
	for _, level := range config.ThinkingLevels {
		items = append(items, pickerItem{Value: level, Label: level})
	}
	return items
}

func splitModelRef(ref string) (string, string) {
	index := strings.Index(ref, "/")
	if index <= 0 {
		return "", ref
	}
	return ref[:index], ref[index+1:]
}

// openModelsPanel opens a model-focused sub-panel above the Models tab.
func (m *Model) openModelsPanel(title string, rows []settingsRow) {
	m.openSettingsPanelAt("models", title, rows)
}

func (m *Model) pushModelsPanel(title string, build func(*Model) []settingsTab) {
	state := m.pushSettingsPanel(pageModels, title, build)
	m.showPage(state)
}

// openEnabledProvidersPanel lists providers with their enabled counts.
func (m *Model) openEnabledProvidersPanel() {
	if m.catalog == nil {
		m.setToast("model catalog unavailable")
		return
	}
	build := func(mm *Model) []settingsTab {
		if mm.catalog == nil {
			return nil
		}
		rows := []settingsRow{
			{
				ID:      "enabled-count",
				Label:   "Enabled",
				Kind:    settingsInfo,
				Current: func() string { return fmt.Sprintf("%d of %d models", mm.enabledCount(), len(mm.catalog.Models())) },
			},
			{
				ID:    "enable-all",
				Label: "Enable all models",
				Kind:  settingsAction,
				Help:  "Removes enabledModels so every model, including future ones, is enabled.",
				Run: func(mm2 *Model, _ *settingsState) tea.Cmd {
					if err := mm2.settings.ClearEnabledModels(); err != nil {
						mm2.setToast(err.Error())
						return nil
					}
					mm2.refreshEnabledModels()
					mm2.setToast("all models enabled")
					return nil
				},
			},
			{
				ID:    "disable-all",
				Label: "Disable all but one",
				Kind:  settingsAction,
				Help:  "Keeps one model enabled so a session can still start.",
				Run: func(mm2 *Model, _ *settingsState) tea.Cmd {
					patterns, _ := modelcatalog.SetAllDisabled(mm2.catalog.Models())
					if err := mm2.settings.SetEnabledModels(patterns); err != nil {
						mm2.setToast(err.Error())
						return nil
					}
					mm2.refreshEnabledModels()
					mm2.setToast("kept one model enabled")
					return nil
				},
			},
		}
		for _, provider := range mm.catalog.Providers {
			if len(provider.Models) == 0 {
				continue
			}
			provider := provider
			rows = append(rows, settingsRow{
				ID:    "enabled-" + provider.ID,
				Label: provider.Name,
				Kind:  settingsAction,
				Help:  "Turn this provider's models on or off.",
				Current: func() string {
					return fmt.Sprintf("%d/%d", mm.providerEnabledCount(provider), len(provider.Models))
				},
				Run: func(mm2 *Model, _ *settingsState) tea.Cmd {
					mm2.openEnabledProviderPanel(provider.ID)
					return nil
				},
			})
		}
		return []settingsTab{{ID: "panel", Label: "Enabled models", Rows: rows}}
	}
	m.pushModelsPanel("Enabled models", build)
}

func (m *Model) openEnabledProviderPanel(providerID string) {
	provider := m.catalog.Provider(providerID)
	if provider == nil {
		m.setToast("provider not found")
		return
	}
	build := func(mm *Model) []settingsTab {
		currProv := mm.catalog.Provider(providerID)
		if currProv == nil {
			return nil
		}
		rows := []settingsRow{{
			ID:    "enable-provider",
			Label: "Enable all in " + currProv.Name,
			Kind:  settingsAction,
			Run: func(mm2 *Model, _ *settingsState) tea.Cmd {
				for _, model := range currProv.Models {
					if err := mm2.setModelEnabled(model.Ref(), true); err != nil {
						mm2.setToast(err.Error())
						return nil
					}
				}
				return nil
			},
		}}
		for _, model := range currProv.Models {
			model := model
			label := model.Name
			if label == "" {
				label = model.ID
			}
			rows = append(rows, settingsRow{
				ID:    "model-" + model.ID,
				Label: label,
				Help:  model.ID,
				Kind:  settingsToggle,
				Bool:  func() bool { return mm.enabledModels[model.Ref()] },
				SetBool: func(on bool) error {
					return mm.setModelEnabled(model.Ref(), on)
				},
			})
		}
		return []settingsTab{{ID: "panel", Label: currProv.Name, Rows: rows}}
	}
	m.pushModelsPanel(provider.Name, build)
}

func (m *Model) setModelEnabled(ref string, on bool) error {
	if m.catalog == nil || m.settings == nil {
		return fmt.Errorf("catalog unavailable")
	}
	patterns, present, err := m.settings.EnabledModels()
	if err != nil {
		return err
	}
	next, nextSet := modelcatalog.SetEnabled(patterns, present, m.catalog.Models(), ref, on)
	if !nextSet {
		if err := m.settings.ClearEnabledModels(); err != nil {
			return err
		}
	} else if err := m.settings.SetEnabledModels(next); err != nil {
		return err
	}
	m.refreshEnabledModels()
	return nil
}

func (m *Model) enabledCount() int {
	count := 0
	for _, on := range m.enabledModels {
		if on {
			count++
		}
	}
	return count
}

func (m *Model) providerEnabledCount(provider *modelcatalog.Provider) int {
	count := 0
	for _, model := range provider.Models {
		if m.enabledModels[model.Ref()] {
			count++
		}
	}
	return count
}

// projectScope names the project settings keys that shadow a panel.
func (m *Model) projectScope(keys ...string) string {
	if m.opts.CWD == "" {
		return "global only"
	}
	project := m.projectSettings()
	if project == nil {
		return "none"
	}
	var shadowed []string
	for _, key := range keys {
		if project.Root().Has(key) {
			shadowed = append(shadowed, key)
		}
	}
	if len(shadowed) == 0 {
		return "none"
	}
	return "project shadows " + strings.Join(shadowed, ", ")
}

// openThinkingProvidersPanel lists providers for per-model level overrides.
func (m *Model) openThinkingProvidersPanel() {
	if m.catalog == nil {
		m.setToast("model catalog unavailable")
		return
	}
	build := func(mm *Model) []settingsTab {
		if mm.catalog == nil {
			return nil
		}
		rows := []settingsRow{{
			ID:    "thinking-count",
			Label: "Overrides",
			Kind:  settingsInfo,
			Current: func() string {
				levels, _ := mm.settings.ModelThinkingLevels()
				return fmt.Sprintf("%d models", len(levels))
			},
		}}
		for _, provider := range mm.catalog.Providers {
			if len(provider.Models) == 0 {
				continue
			}
			provider := provider
			rows = append(rows, settingsRow{
				ID:    "thinking-" + provider.ID,
				Label: provider.Name,
				Kind:  settingsAction,
				Help:  "Set a startup thinking level for one of its models.",
				Run: func(mm2 *Model, _ *settingsState) tea.Cmd {
					mm2.openThinkingProviderPanel(provider.ID)
					return nil
				},
			})
		}
		return []settingsTab{{ID: "panel", Label: "Per-model thinking levels", Rows: rows}}
	}
	m.pushModelsPanel("Per-model thinking levels", build)
}

func (m *Model) openThinkingProviderPanel(providerID string) {
	provider := m.catalog.Provider(providerID)
	if provider == nil {
		m.setToast("provider not found")
		return
	}
	build := func(mm *Model) []settingsTab {
		currProv := mm.catalog.Provider(providerID)
		if currProv == nil {
			return nil
		}
		levels := providerThinkingLevels(mm)
		rows := make([]settingsRow, 0, len(currProv.Models))
		for _, model := range currProv.Models {
			model := model
			label := model.Name
			if label == "" {
				label = model.ID
			}
			rows = append(rows, settingsRow{
				ID:    "level-" + model.ID,
				Label: label,
				Help:  model.ID + " · supported: " + supportedLevels(model),
				Kind:  settingsChoice,
				Current: func() string {
					override := levels[model.Ref()]
					if override == "" {
						return "default"
					}
					return override
				},
				Choices: thinkingLevelChoices(true),
				Apply: func(value string) error {
					if value == "" {
						if err := mm.settings.ClearModelThinkingLevel(model.Ref()); err != nil {
							return err
						}
					} else if err := mm.settings.SetModelThinkingLevel(model.Ref(), value); err != nil {
						return err
					}
					levels = providerThinkingLevels(mm)
					return nil
				},
			})
		}
		return []settingsTab{{ID: "panel", Label: currProv.Name + " thinking levels", Rows: rows}}
	}
	m.pushModelsPanel(provider.Name+" thinking levels", build)
}

func providerThinkingLevels(m *Model) map[string]string {
	levels, _ := m.settings.ModelThinkingLevels()
	if levels == nil {
		levels = map[string]string{}
	}
	return levels
}

func supportedLevels(model *modelcatalog.Model) string {
	if !model.Reasoning {
		return "off"
	}
	var levels []string
	for _, level := range config.ThinkingLevels {
		if model.SupportsThinkingLevel(level) {
			levels = append(levels, level)
		}
	}
	if len(levels) == 0 {
		return "none"
	}
	return strings.Join(levels, ", ")
}

// refreshCatalog runs `pi update --models` outside the RPC child.
func (m *Model) refreshCatalog() tea.Cmd {
	bin := m.opts.PiBin
	if bin == "" {
		bin = "pi"
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, bin, "update", "--models")
		output, err := command.CombinedOutput()
		return catalogRefreshedMsg{err: err, output: strings.TrimSpace(string(output))}
	}
}
