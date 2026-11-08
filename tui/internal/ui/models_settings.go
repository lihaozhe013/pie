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

// modelsSettingsTab is Settings › Models. It owns model selection, enabling,
// reasoning, and context windows; provider credentials and endpoints live in
// Settings › Providers.
func (m *Model) modelsSettingsTab() settingsTab {
	tab := settingsTab{
		ID:    "models",
		Label: "Models",
		Note:  "The catalog comes from pi; models.json overrides model metadata.",
	}
	if m.settings == nil {
		reason := "settings.json is unavailable"
		if m.configErr != nil {
			reason += ": " + m.configErr.Error()
		}
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "models-settings-error",
			Label:   "Settings",
			Kind:    settingsInfo,
			Current: func() string { return reason },
		})
		return tab
	}
	projectScope := m.projectScope("defaultModel", "defaultThinkingLevel", "enabledModels", "modelThinkingLevels")

	if m.catalogErr != nil {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "catalog-error",
			Label:   "Catalog",
			Kind:    settingsInfo,
			Current: func() string { return "unavailable: " + m.catalogErr.Error() },
		})
	} else if m.catalog != nil {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "catalog-summary",
			Label: "Catalog",
			Kind:  settingsInfo,
			Current: func() string {
				return fmt.Sprintf("%d providers · %d models", len(m.catalog.Providers), len(m.catalog.Models()))
			},
		})
	}

	tab.Rows = append(tab.Rows, settingsRow{
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
	})

	tab.Rows = append(tab.Rows, settingsRow{
		ID:      "default-thinking",
		Label:   "Default thinking level",
		Help:    "Applies when pie starts; Pie applies it to its new sessions.",
		Kind:    settingsChoice,
		Current: func() string { level, _ := m.settings.DefaultThinkingLevel(); return level },
		Choices: thinkingLevelChoices(false),
		Apply:   m.settings.SetDefaultThinkingLevel,
	})

	tab.Rows = append(tab.Rows, settingsRow{
		ID:        "context-limit",
		Label:     "Context window limit",
		Help:      "Shared with Pie, which applies the cap to its sessions; pi itself keeps the native window in the terminal. Blank or 'none' removes the cap; the default is 350000.",
		Kind:      settingsText,
		Current:   m.contextLimitLabel,
		EditValue: m.contextLimitEditValue,
		Apply:     m.setContextLimit,
	})

	tab.Rows = append(tab.Rows, settingsRow{
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
	})

	tab.Rows = append(tab.Rows,
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
		settingsRow{
			ID:      "project-scope",
			Label:   "Project overrides",
			Kind:    settingsInfo,
			Current: func() string { return projectScope },
			Help:    "A project .pi/settings.json key wins over the global value this panel edits.",
		},
		settingsRow{
			ID:    "refresh-catalog",
			Label: "Refresh model catalog",
			Help:  "Runs `pi update --models`; new models appear after it finishes.",
			Kind:  settingsAction,
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				return m.refreshCatalog()
			},
		},
	)

	return tab
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

// openEnabledProvidersPanel lists providers with their enabled counts.
func (m *Model) openEnabledProvidersPanel() {
	if m.catalog == nil {
		m.setToast("model catalog unavailable")
		return
	}
	rows := []settingsRow{
		{
			ID:      "enabled-count",
			Label:   "Enabled",
			Kind:    settingsInfo,
			Current: func() string { return fmt.Sprintf("%d of %d models", m.enabledCount(), len(m.catalog.Models())) },
		},
		{
			ID:    "enable-all",
			Label: "Enable all models",
			Kind:  settingsAction,
			Help:  "Removes enabledModels so every model, including future ones, is enabled.",
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				if err := m.settings.ClearEnabledModels(); err != nil {
					m.setToast(err.Error())
					return nil
				}
				m.refreshEnabledModels()
				m.setToast("all models enabled")
				return nil
			},
		},
		{
			ID:    "disable-all",
			Label: "Disable all but one",
			Kind:  settingsAction,
			Help:  "Keeps one model enabled so a session can still start.",
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				patterns, _ := modelcatalog.SetAllDisabled(m.catalog.Models())
				if err := m.settings.SetEnabledModels(patterns); err != nil {
					m.setToast(err.Error())
					return nil
				}
				m.refreshEnabledModels()
				m.setToast("kept one model enabled")
				return nil
			},
		},
	}
	for _, provider := range m.catalog.Providers {
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
				return fmt.Sprintf("%d/%d", m.providerEnabledCount(provider), len(provider.Models))
			},
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				m.openEnabledProviderPanel(provider.ID)
				return nil
			},
		})
	}
	m.openModelsPanel("Enabled models", rows)
}

func (m *Model) openEnabledProviderPanel(providerID string) {
	provider := m.catalog.Provider(providerID)
	if provider == nil {
		m.setToast("provider not found")
		return
	}
	rows := []settingsRow{{
		ID:    "enable-provider",
		Label: "Enable all in " + provider.Name,
		Kind:  settingsAction,
		Run: func(m *Model, _ *settingsState) tea.Cmd {
			for _, model := range provider.Models {
				if err := m.setModelEnabled(model.Ref(), true); err != nil {
					m.setToast(err.Error())
					return nil
				}
			}
			return nil
		},
	}}
	for _, model := range provider.Models {
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
			Bool:  func() bool { return m.enabledModels[model.Ref()] },
			SetBool: func(on bool) error {
				return m.setModelEnabled(model.Ref(), on)
			},
		})
	}
	m.openModelsPanel(provider.Name, rows)
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
	rows := []settingsRow{{
		ID:    "thinking-count",
		Label: "Overrides",
		Kind:  settingsInfo,
		Current: func() string {
			levels, _ := m.settings.ModelThinkingLevels()
			return fmt.Sprintf("%d models", len(levels))
		},
	}}
	for _, provider := range m.catalog.Providers {
		if len(provider.Models) == 0 {
			continue
		}
		provider := provider
		rows = append(rows, settingsRow{
			ID:    "thinking-" + provider.ID,
			Label: provider.Name,
			Kind:  settingsAction,
			Help:  "Set a startup thinking level for one of its models.",
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				m.openThinkingProviderPanel(provider.ID)
				return nil
			},
		})
	}
	m.openModelsPanel("Per-model thinking levels", rows)
}

func (m *Model) openThinkingProviderPanel(providerID string) {
	provider := m.catalog.Provider(providerID)
	if provider == nil {
		m.setToast("provider not found")
		return
	}
	levels := providerThinkingLevels(m)
	rows := make([]settingsRow, 0, len(provider.Models))
	for _, model := range provider.Models {
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
					if err := m.settings.ClearModelThinkingLevel(model.Ref()); err != nil {
						return err
					}
				} else if err := m.settings.SetModelThinkingLevel(model.Ref(), value); err != nil {
					return err
				}
				levels = providerThinkingLevels(m)
				return nil
			},
		})
	}
	m.openModelsPanel(provider.Name+" thinking levels", rows)
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
