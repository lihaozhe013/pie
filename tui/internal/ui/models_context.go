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
	build := func(mm *Model) []settingsTab {
		if mm.catalog == nil || mm.modelsFile == nil {
			return nil
		}
		overrides := mm.modelsFile.ContextWindowOverrides()
		rows := []settingsRow{{
			ID:    "context-count",
			Label: "Overrides",
			Kind:  settingsInfo,
			Current: func() string {
				return fmt.Sprintf("%d models", len(overrides))
			},
			Help: "A model with a larger native window than the global cap still shows the cap; this override changes the model itself.",
		}}
		for _, provider := range mm.catalog.Providers {
			if len(provider.Models) == 0 {
				continue
			}
			provider := provider
			rows = append(rows, settingsRow{
				ID:    "context-" + provider.ID,
				Label: provider.Name,
				Kind:  settingsAction,
				Help:  "Set or clear a context window for one of its models.",
				Run: func(mm2 *Model, _ *settingsState) tea.Cmd {
					mm2.openContextProviderPanel(provider.ID)
					return nil
				},
			})
		}
		return []settingsTab{{ID: "panel", Label: "Per-model context windows", Rows: rows}}
	}
	m.pushModelsPanel("Per-model context windows", build)
}

func (m *Model) openContextProviderPanel(providerID string) {
	provider := m.catalog.Provider(providerID)
	if provider == nil || m.modelsFile == nil {
		m.setToast("provider not found")
		return
	}
	build := func(mm *Model) []settingsTab {
		currProv := mm.catalog.Provider(providerID)
		if currProv == nil || mm.modelsFile == nil {
			return nil
		}
		overrides := mm.modelsFile.ContextWindowOverrides()
		rows := make([]settingsRow, 0, len(currProv.Models))
		for _, model := range currProv.Models {
			model := model
			label := model.Name
			if label == "" {
				label = model.ID
			}
			window := overrides[model.Ref()]
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
						if err := mm.modelsFile.SetContextWindowOverride(providerID, model.ID, nil); err != nil {
							return err
						}
						window = 0
						mm.reloadConfig()
						return nil
					}
					tokens, err := strconv.Atoi(value)
					if err != nil || tokens <= 0 {
						return fmt.Errorf("context window must be a positive token count")
					}
					if err := mm.modelsFile.SetContextWindowOverride(providerID, model.ID, &tokens); err != nil {
						return err
					}
					window = tokens
					mm.reloadConfig()
					return nil
				},
			})
		}
		return []settingsTab{{ID: "panel", Label: currProv.Name + " context windows", Rows: rows}}
	}
	m.pushModelsPanel(provider.Name+" context windows", build)
}
