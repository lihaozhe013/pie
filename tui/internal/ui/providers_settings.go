package ui

import (
	"fmt"
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/modelcatalog"
	"github.com/lihaozhe013/pie/tui/internal/providerusage"
)

// providersSettingsTab builds the Providers page. It owns credentials, default
// provider selection, compatible endpoints, and subscription usage; model
// selection and metadata stay on the Model settings page.
func (m *Model) providersSettingsTab() settingsTab {
	tab := settingsTab{
		ID:    "providers",
		Label: "Providers",
		Note:  "Credentials live in auth.json; models.json defines compatible endpoints.",
	}
	projectScope := m.projectScope("defaultProvider")

	if m.settings == nil {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "default-provider",
			Label:   "Default provider",
			Kind:    settingsInfo,
			Current: func() string { return "settings.json unavailable" },
		})
	} else {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "default-provider",
			Label: "Default provider",
			Help:  "Applies when pie starts; Pie applies it to its new sessions.",
			Kind:  settingsChoice,
			Current: func() string {
				provider, _ := m.settings.DefaultProvider()
				if provider == "" {
					return "auto"
				}
				return provider
			},
			Choices: m.providerChoices(true),
			Apply: func(value string) error {
				if value == "auto" {
					value = ""
				}
				return m.settings.SetDefaultProvider(value)
			},
		})
	}

	tab.Rows = append(tab.Rows, settingsRow{
		ID:      "provider-credentials",
		Label:   "Credentials",
		Kind:    settingsInfo,
		Current: m.providerCredentialSummary,
		Help:    "A provider can use auth.json, an environment variable, or a key from models.json.",
	})

	tab.Rows = append(tab.Rows,
		settingsRow{
			ID:    "provider-sign-in",
			Label: "Sign in to a provider",
			Kind:  settingsAction,
			Help:  "Lists every built-in provider, including ones with no credential yet.",
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				var command tea.Cmd
				m.openOverlayFromSettings(func() { command = m.openLoginPicker("") })
				return command
			},
		},
		settingsRow{
			ID:    "provider-sign-out",
			Label: "Sign out of a provider",
			Kind:  settingsAction,
			Help:  "Deletes a stored credential from auth.json.",
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				var command tea.Cmd
				m.openOverlayFromSettings(func() { command = m.openLogoutPicker() })
				return command
			},
		},
	)

	if m.providerAuth == nil {
		status := "reading from the bridge…"
		help := "The provider snapshot comes from the running pi and appears once it answers."
		if m.providerAuthErr != nil {
			status = "unavailable"
			help = m.providerAuthErr.Error()
		} else if !m.bridgeReady {
			status = "bridge unavailable"
			help = "Sign-in needs the bridge extension; restart pie with the embedded extension."
		}
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "provider-list-status",
			Label:   "Provider list",
			Kind:    settingsInfo,
			Current: func() string { return status },
			Help:    help,
		})
	}

	tab.Rows = append(tab.Rows,
		settingsRow{
			ID:    "add-provider",
			Label: "Add provider",
			Kind:  settingsAction,
			Help:  "Defines a compatible endpoint in models.json.",
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				m.addProvider()
				return nil
			},
		},
		settingsRow{
			ID:      "provider-usage",
			Label:   "Usage limits",
			Kind:    settingsAction,
			Current: m.usageProviderSummary,
			Help:    "Queries subscription windows and balances for providers that report them.",
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				m.openProviderUsageList()
				return nil
			},
		},
		settingsRow{
			ID:      "provider-project-scope",
			Label:   "Project overrides",
			Kind:    settingsInfo,
			Current: func() string { return projectScope },
			Help:    "A project .pi/settings.json key wins over the global value this panel edits.",
		},
	)

	if m.catalog != nil {
		for _, provider := range m.catalog.Providers {
			provider := provider
			tab.Rows = append(tab.Rows, settingsRow{
				ID:      "provider-" + provider.ID,
				Label:   "Provider: " + provider.Name,
				Kind:    settingsAction,
				Current: func() string { return providerCredentialLabel(provider) },
				Help:    providerSummary(provider),
				Run: func(m *Model, _ *settingsState) tea.Cmd {
					m.openProviderPanel(provider.ID)
					return nil
				},
			})
		}
	}

	return tab
}

// providerCredentialSummary counts providers with a usable credential.
func (m *Model) providerCredentialSummary() string {
	if m.catalog == nil {
		return "unknown"
	}
	configured := 0
	for _, provider := range m.catalog.Providers {
		if provider.CredentialType != "" || provider.APIKey != "" || (provider.Auth != nil && provider.Auth.Configured) {
			configured++
		}
	}
	return fmt.Sprintf("%d of %d configured", configured, len(m.catalog.Providers))
}

// usageProviderSummary counts usage-capable providers and cached reports.
func (m *Model) usageProviderSummary() string {
	supported := 0
	for _, providerID := range providerusage.SupportedIDs {
		if m.catalog != nil && m.catalog.Provider(providerID) == nil {
			continue
		}
		supported++
	}
	checked := 0
	for _, providerID := range providerusage.SupportedIDs {
		if state := m.providerUsage[providerID]; state != nil && state.report != nil {
			checked++
		}
	}
	return fmt.Sprintf("%d providers · %d checked", supported, checked)
}

func providerCredentialLabel(provider *modelcatalog.Provider) string {
	if provider.CredentialType != "" {
		return provider.CredentialType
	}
	if provider.Auth != nil {
		return provider.Auth.Status()
	}
	if provider.APIKey != "" {
		return "models.json key"
	}
	return "no credential"
}

func providerSummary(provider *modelcatalog.Provider) string {
	parts := make([]string, 0, 2)
	switch {
	case provider.Auth != nil:
		parts = append(parts, provider.Auth.Status())
		if provider.Auth.HasOAuth() && provider.Auth.APIKeyLogin {
			parts = append(parts, "oauth or api key")
		} else if provider.Auth.HasOAuth() {
			parts = append(parts, "oauth")
		} else if provider.Auth.HasAPIKey() {
			parts = append(parts, "api key")
		}
	case provider.CredentialType != "":
		parts = append(parts, provider.CredentialType)
	case provider.APIKey != "":
		parts = append(parts, "models.json key")
	default:
		parts = append(parts, "no credential")
	}
	models := len(provider.Models)
	if models == 0 && provider.Auth != nil {
		models = provider.Auth.ModelCount
	}
	if models > 0 {
		parts = append(parts, fmt.Sprintf("%d models", models))
	}
	return strings.Join(parts, " · ")
}

// providerAuthHelp explains the sign-in methods of a provider, tolerating a
// missing snapshot.
func providerAuthHelp(auth *modelcatalog.ProviderAuth) string {
	if auth == nil {
		return "The provider snapshot from the running pi has not arrived yet."
	}
	return auth.Help()
}

// openProviderPanel shows one provider's credentials, usage, and models.
func (m *Model) openProviderPanel(providerID string) {
	provider := m.catalog.Provider(providerID)
	if provider == nil {
		m.setToast("provider not found")
		return
	}
	rows := []settingsRow{
		{
			ID:      "provider-id",
			Label:   "Provider id",
			Kind:    settingsInfo,
			Current: func() string { return provider.ID },
		},
		{
			ID:    "provider-edit",
			Label: "Edit provider",
			Kind:  settingsAction,
			Help:  "Change the display name, base URL, API, or credential.",
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				m.openProviderEditor(provider.ID, false)
				return nil
			},
		},
		{
			ID:    "provider-auth",
			Label: "Credential",
			Kind:  settingsInfo,
			Current: func() string {
				if provider.Auth != nil {
					return provider.Auth.Status()
				}
				if provider.CredentialType != "" {
					return provider.CredentialType
				}
				if provider.APIKey != "" {
					return "models.json key"
				}
				return "none"
			},
			Help: providerAuthHelp(provider.Auth),
		},
	}
	if auth := provider.Auth; auth != nil {
		if auth.HasOAuth() {
			rows = append(rows,
				settingsRow{
					ID:      "provider-oauth",
					Label:   "OAuth method",
					Kind:    settingsInfo,
					Current: func() string { return auth.OAuthName },
					Help:    "OAuth opens a browser page; a device code appears here when one is needed.",
				},
				settingsRow{
					ID:    "provider-login-oauth",
					Label: "Sign in with OAuth",
					Kind:  settingsAction,
					Help:  "Runs the provider's OAuth flow inside pi and stores the credential in auth.json.",
					Run: func(m *Model, _ *settingsState) tea.Cmd {
						return m.startProviderLogin(provider.ID, "oauth")
					},
				},
			)
		}
		if auth.APIKeyLogin {
			rows = append(rows, settingsRow{
				ID:    "provider-login-key",
				Label: "Sign in with API key",
				Kind:  settingsAction,
				Help:  "Asks for the provider's API key and stores it in auth.json.",
				Run: func(m *Model, _ *settingsState) tea.Cmd {
					return m.startProviderLogin(provider.ID, "api_key")
				},
			})
		}
		if m.authFlow == provider.ID {
			rows = append(rows, settingsRow{
				ID:    "provider-login-cancel",
				Label: "Cancel sign-in",
				Kind:  settingsAction,
				Help:  "Aborts the sign-in this provider is running.",
				Run: func(m *Model, _ *settingsState) tea.Cmd {
					return m.cancelProviderLogin(provider.ID)
				},
			})
		}
	}
	if provider.CredentialType != "" {
		rows = append(rows, settingsRow{
			ID:    "provider-logout",
			Label: "Sign out",
			Kind:  settingsAction,
			Help:  "Deletes the stored credential and refreshes the model list.",
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				return m.signOutProvider(provider.ID)
			},
		})
	}
	if providerusage.Supported(provider.ID) {
		rows = append(rows, settingsRow{
			ID:      "provider-usage",
			Label:   "Usage limits",
			Kind:    settingsAction,
			Current: func() string { return m.providerUsageSummary(provider.ID) },
			Help:    "Rate-limit windows and balances from the provider's own usage endpoint.",
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				return m.openProviderUsagePanel(provider.ID)
			},
		})
	}
	rows = append(rows,
		settingsRow{
			ID:      "provider-base",
			Label:   "Base URL",
			Kind:    settingsInfo,
			Current: func() string { return provider.BaseURL },
		},
		settingsRow{
			ID:      "provider-api",
			Label:   "API",
			Kind:    settingsInfo,
			Current: func() string { return provider.API },
		},
	)
	rows = append(rows, settingsRow{
		ID:    "provider-add-model",
		Label: "Add model",
		Kind:  settingsAction,
		Help:  "Adds a model entry to this provider in models.json.",
		Run: func(m *Model, _ *settingsState) tea.Cmd {
			m.openModelEditor(provider.ID, "", true)
			return nil
		},
	})
	for _, model := range provider.Models {
		model := model
		label := model.Name
		if label == "" {
			label = model.ID
		}
		rows = append(rows, settingsRow{
			ID:    "model-" + model.ID,
			Label: label,
			Kind:  settingsAction,
			Help:  modelSummary(model),
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				m.providerModelAction(provider.ID, model.ID)
				return nil
			},
		})
	}
	m.openProvidersPanel(provider.Name, rows)
	m.panelProvider = provider.ID
}

func (m *Model) openModelPanel(providerID, modelID string) {
	provider := m.catalog.Provider(providerID)
	if provider == nil {
		m.setToast("provider not found")
		return
	}
	var model *modelcatalog.Model
	for _, candidate := range provider.Models {
		if candidate.ID == modelID {
			model = candidate
			break
		}
	}
	if model == nil {
		m.setToast("model not found")
		return
	}
	rows := []settingsRow{
		{
			ID:      "model-id",
			Label:   "Model id",
			Kind:    settingsInfo,
			Current: func() string { return model.ID },
		},
		{
			ID:      "model-name",
			Label:   "Name",
			Kind:    settingsInfo,
			Current: func() string { return model.Name },
		},
		{
			ID:      "model-context",
			Label:   "Context window",
			Kind:    settingsInfo,
			Current: func() string { return strconv.Itoa(model.ContextWindow) },
		},
		{
			ID:      "model-max",
			Label:   "Max output tokens",
			Kind:    settingsInfo,
			Current: func() string { return strconv.Itoa(model.MaxTokens) },
		},
		{
			ID:      "model-reasoning",
			Label:   "Reasoning",
			Kind:    settingsInfo,
			Current: func() string { return onOff(model.Reasoning) },
		},
		{
			ID:      "model-cost",
			Label:   "Cost / M tokens",
			Kind:    settingsInfo,
			Current: func() string { return modelCostSummary(model) },
		},
	}
	m.openProvidersPanel(model.ID, rows)
}

func modelSummary(model *modelcatalog.Model) string {
	parts := []string{fmt.Sprintf("ctx %d", model.ContextWindow)}
	if model.Reasoning {
		parts = append(parts, "reasoning")
	}
	if model.SupportsImage() {
		parts = append(parts, "image")
	}
	if model.Custom {
		parts = append(parts, "models.json")
	} else if model.Override {
		parts = append(parts, "override")
	}
	return strings.Join(parts, " · ")
}

func modelCostSummary(model *modelcatalog.Model) string {
	if model.Cost == (modelcatalog.Cost{}) {
		return "unset"
	}
	return fmt.Sprintf("in %.2f · out %.2f · cache %.2f/%.2f",
		model.Cost.Input, model.Cost.Output, model.Cost.CacheRead, model.Cost.CacheWrite)
}

// openProvidersPanel opens a provider-focused sub-panel above Providers.
func (m *Model) openProvidersPanel(title string, rows []settingsRow) {
	m.openSettingsPanelAt("providers", title, rows)
}
