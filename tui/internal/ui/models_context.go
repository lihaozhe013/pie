package ui

import (
	"fmt"
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// openContextProvidersPanel lists providers for per-model context windows,
// the terminal counterpart of the input beside each model in Pie's enabled
// list. Values live in models.json modelOverrides.
func (m *Model) openContextProvidersPanel() {
	if m.catalog == nil || m.modelsFile == nil {
		m.setToast("model catalog unavailable")
		return
	}
	overrides := m.modelsFile.ContextWindowOverrides()
	rows := []settingsRow{{
		ID:    "context-count",
		Label: "Overrides",
		Kind:  settingsInfo,
		Current: func() string {
			return fmt.Sprintf("%d models", len(overrides))
		},
		Help: "A model with a larger native window than the global cap still shows the cap; this override changes the model itself.",
	}}
	for _, provider := range m.catalog.Providers {
		provider := provider
		rows = append(rows, settingsRow{
			ID:    "context-" + provider.ID,
			Label: provider.Name,
			Kind:  settingsAction,
			Help:  "Set or clear a context window for one of its models.",
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				m.openContextProviderPanel(provider.ID)
				return nil
			},
		})
	}
	m.openModelsPanel("Per-model context windows", rows)
}

func (m *Model) openContextProviderPanel(providerID string) {
	provider := m.catalog.Provider(providerID)
	if provider == nil || m.modelsFile == nil {
		m.setToast("provider not found")
		return
	}
	rows := make([]settingsRow, 0, len(provider.Models))
	for _, model := range provider.Models {
		model := model
		label := model.Name
		if label == "" {
			label = model.ID
		}
		window := m.modelsFile.ContextWindowOverrides()[model.Ref()]
		rows = append(rows, settingsRow{
			ID:    "context-" + model.ID,
			Label: label,
			Help:  fmt.Sprintf("%s · native %s", model.ID, formatTokens(model.ContextWindow)),
			Kind:  settingsText,
			Current: func() string {
				if window <= 0 {
					return "default"
				}
				return formatTokens(window)
			},
			EditValue: func() string {
				if window <= 0 {
					return ""
				}
				return strconv.Itoa(window)
			},
			Apply: func(value string) error {
				value = strings.TrimSpace(value)
				if value == "" || strings.EqualFold(value, "default") {
					if err := m.modelsFile.SetContextWindowOverride(providerID, model.ID, nil); err != nil {
						return err
					}
					window = 0
					m.reloadConfig()
					return nil
				}
				tokens, err := strconv.Atoi(value)
				if err != nil || tokens <= 0 {
					return fmt.Errorf("context window must be a positive token count")
				}
				if err := m.modelsFile.SetContextWindowOverride(providerID, model.ID, &tokens); err != nil {
					return err
				}
				window = tokens
				m.reloadConfig()
				return nil
			},
		})
	}
	m.openModelsPanel(provider.Name+" context windows", rows)
}
