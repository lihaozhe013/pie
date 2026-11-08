package ui

import (
	"fmt"
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/config"
)

// providerAPIs are the API ids pi accepts for a custom endpoint.
var providerAPIs = []string{
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"azure-openai-responses",
	"mistral-conversations",
	"bedrock-converse-stream",
	"openai-codex-responses",
}

// providerDraft is the mutable state of the provider editor.
type providerDraft struct {
	ID         string
	IsNew      bool
	Custom     bool
	Name       string
	BaseURL    string
	API        string
	APIKey     string
	confirmDel bool
}

// modelDraft is the mutable state of the model editor.
type modelDraft struct {
	ProviderID     string
	ID             string
	IsNew          bool
	Custom         bool
	Name           string
	ContextWindow  int
	MaxTokens      int
	Reasoning      bool
	Image          bool
	CostInput      float64
	CostOutput     float64
	CostCacheRead  float64
	CostCacheWrite float64
	Levels         map[string]*string
	confirmDel     bool
}

// providerDraftFrom copies a provider's current values into an editable draft.
func (m *Model) providerDraftFrom(providerID string, isNew bool) *providerDraft {
	draft := &providerDraft{ID: providerID, IsNew: isNew, Custom: isNew, API: "openai-completions"}
	provider := m.catalog.Provider(providerID)
	if provider != nil && !isNew {
		draft.Name = provider.Name
		draft.BaseURL = provider.BaseURL
		draft.API = provider.API
		draft.Custom = provider.Custom
		draft.APIKey = provider.APIKey
	}
	if m.modelsFile != nil {
		if entry := m.modelsFile.Provider(providerID); entry != nil {
			draft.Name = entry.Get("name").StringOr(draft.Name)
			draft.BaseURL = entry.Get("baseUrl").StringOr(draft.BaseURL)
			draft.API = entry.Get("api").StringOr(draft.API)
			draft.APIKey = entry.Get("apiKey").StringOr(draft.APIKey)
			// A models.json entry for a known provider is a proxy or override,
			// not a provider the user can delete.
			if provider == nil {
				draft.Custom = true
			}
		}
	}
	return draft
}

// openProviderEditor shows the editable form for one provider.
func (m *Model) openProviderEditor(providerID string, isNew bool) {
	draft := m.providerDraftFrom(providerID, isNew)
	idRow := settingsRow{
		ID:      "provider-id",
		Label:   "Provider id",
		Kind:    settingsInfo,
		Current: func() string { return draft.ID },
	}
	if draft.IsNew {
		idRow.Kind = settingsText
		idRow.Help = "Letters, digits, dashes, and underscores."
		idRow.EditValue = func() string { return draft.ID }
		idRow.Apply = func(value string) error {
			value = strings.TrimSpace(value)
			if value == "" || strings.ContainsAny(value, " /\\") {
				return fmt.Errorf("provider id must not be empty or contain spaces")
			}
			draft.ID = value
			return nil
		}
	}
	rows := []settingsRow{
		idRow,
		{
			ID:        "provider-name",
			Label:     "Name",
			Kind:      settingsText,
			Current:   func() string { return draft.Name },
			EditValue: func() string { return draft.Name },
			Apply: func(value string) error {
				draft.Name = strings.TrimSpace(value)
				return nil
			},
		},
		{
			ID:        "provider-base",
			Label:     "Base URL",
			Help:      "A built-in provider with only a base URL is routed through a proxy; its models and auth stay unchanged.",
			Kind:      settingsText,
			Current:   func() string { return draft.BaseURL },
			EditValue: func() string { return draft.BaseURL },
			Apply: func(value string) error {
				draft.BaseURL = strings.TrimSpace(value)
				return nil
			},
		},
		{
			ID:    "provider-api",
			Label: "API",
			Kind:  settingsChoice,
			Current: func() string {
				if draft.API == "" {
					return "inherit"
				}
				return draft.API
			},
			Choices: apiChoices(),
			Apply: func(value string) error {
				if value == "inherit" {
					draft.API = ""
					return nil
				}
				draft.API = value
				return nil
			},
		},
		{
			ID:      "provider-apikey",
			Label:   "API key",
			Help:    "Stored in auth.json for pi's own providers and in models.json for custom ones.",
			Kind:    settingsText,
			Current: func() string { return maskSecret(draft.APIKey) },
			EditValue: func() string {
				if draft.Custom {
					return draft.APIKey
				}
				return ""
			},
			Apply: func(value string) error {
				value = strings.TrimSpace(value)
				if value == "" {
					return nil
				}
				if draft.Custom {
					draft.APIKey = value
					return nil
				}
				auth, err := config.LoadAuth(m.paths)
				if err != nil {
					return err
				}
				if err := auth.SetAPIKey(draft.ID, value); err != nil {
					return err
				}
				m.reloadConfig()
				return nil
			},
		},
	}

	if !draft.IsNew {
		rows = append(rows, settingsRow{
			ID:    "provider-check",
			Label: "Check readiness",
			Kind:  settingsAction,
			Help:  "Runs `pi auth check` without leaving the session.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				m.setToast("checking " + draft.ID + "…")
				return m.checkProvider(draft.ID)
			},
		})
		rows = append(rows, settingsRow{
			ID:    "provider-remove-credential",
			Label: "Sign out",
			Kind:  settingsAction,
			Help:  "Deletes the stored API key or OAuth credential for this provider.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				if m.bridgeReady {
					s.notice = "signing out…"
					return m.startProviderLogout(draft.ID)
				}
				auth, err := config.LoadAuth(m.paths)
				if err != nil {
					s.err = err.Error()
					return nil
				}
				if err := auth.Remove(draft.ID); err != nil {
					s.err = err.Error()
					return nil
				}
				m.reloadConfig()
				s.notice = "credential removed"
				return nil
			},
		})
	}

	rows = append(rows, settingsRow{
		ID:    "provider-save",
		Label: "Save provider",
		Kind:  settingsAction,
		Help:  "Writes the provider to models.json; pi reads it when it reloads models.",
		Run: func(m *Model, s *settingsState) tea.Cmd {
			if err := m.saveProviderDraft(draft); err != nil {
				s.err = err.Error()
				return nil
			}
			m.reloadConfig()
			m.openProviderPanel(draft.ID)
			if m.settingsPanel != nil {
				m.settingsPanel.notice = "provider saved"
			}
			return nil
		},
	})

	if !draft.IsNew {
		rows = append(rows, settingsRow{
			ID:    "provider-add-model",
			Label: "Add model",
			Kind:  settingsAction,
			Help:  "Adds a model entry to this provider in models.json.",
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				m.openModelEditor(draft.ID, "", true)
				return nil
			},
		})
	}

	if draft.Custom && !draft.IsNew {
		rows = append(rows, settingsRow{
			ID:    "provider-delete",
			Label: "Delete provider",
			Kind:  settingsAction,
			Help:  "Press enter twice to delete this custom provider.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				if !draft.confirmDel {
					draft.confirmDel = true
					s.notice = "press enter again to delete"
					return nil
				}
				if err := m.deleteProvider(draft.ID); err != nil {
					s.err = err.Error()
					return nil
				}
				m.reloadConfig()
				cmd := m.openSettingsAt("models")
				if m.settingsPanel != nil {
					m.settingsPanel.notice = "provider deleted"
				}
				return cmd
			},
		})
	}

	m.openModelsPanel("Provider: "+providerLabel(draft), rows)
}

func providerLabel(draft *providerDraft) string {
	if draft.Name != "" {
		return draft.Name
	}
	if draft.ID != "" {
		return draft.ID
	}
	return "new"
}

func apiChoices() []pickerItem {
	items := []pickerItem{{Value: "inherit", Label: "inherit", Detail: "use the provider default"}}
	for _, api := range providerAPIs {
		items = append(items, pickerItem{Value: api, Label: api})
	}
	return items
}

func maskSecret(secret string) string {
	if secret == "" {
		return ""
	}
	if strings.HasPrefix(secret, "$") || strings.HasPrefix(secret, "!") {
		return secret
	}
	if len(secret) <= 4 {
		return "••••"
	}
	return "••••" + secret[len(secret)-4:]
}

// saveProviderDraft writes the draft into models.json.
func (m *Model) saveProviderDraft(draft *providerDraft) error {
	if m.modelsFile == nil {
		return fmt.Errorf("models.json unavailable")
	}
	if draft.IsNew {
		if strings.TrimSpace(draft.ID) == "" {
			return fmt.Errorf("provider id is required")
		}
		if m.catalog.Provider(draft.ID) != nil {
			return fmt.Errorf("provider %q already exists", draft.ID)
		}
	}
	entry := config.NewObject()
	if existing := m.modelsFile.Provider(draft.ID); existing != nil {
		entry = existing.Clone()
	}
	if draft.IsNew {
		entry.Set("models", config.NewArray())
	}
	setOrDelete := func(key, value string) {
		if strings.TrimSpace(value) == "" {
			entry.Delete(key)
			return
		}
		entry.SetString(key, value)
	}
	setOrDelete("name", draft.Name)
	setOrDelete("baseUrl", draft.BaseURL)
	setOrDelete("api", draft.API)
	if draft.Custom {
		setOrDelete("apiKey", draft.APIKey)
	}
	if !draft.IsNew && entry.Len() == 0 {
		return nil
	}
	return m.modelsFile.SetProvider(draft.ID, entry)
}

func (m *Model) deleteProvider(id string) error {
	if m.modelsFile == nil {
		return fmt.Errorf("models.json unavailable")
	}
	return m.modelsFile.DeleteProvider(id)
}

// modelDraftFrom copies a catalog model into an editable draft. A catalog model
// that is not a models.json entry is presented as an override draft.
func (m *Model) modelDraftFrom(providerID, modelID string, isNew bool) *modelDraft {
	draft := &modelDraft{
		ProviderID: providerID,
		ID:         modelID,
		IsNew:      isNew,
		Levels:     map[string]*string{},
	}
	if isNew {
		return draft
	}
	model := m.catalog.Model(providerID + "/" + modelID)
	if model != nil {
		draft.Name = model.Name
		draft.ContextWindow = model.ContextWindow
		draft.MaxTokens = model.MaxTokens
		draft.Reasoning = model.Reasoning
		draft.Image = model.SupportsImage()
		draft.CostInput = model.Cost.Input
		draft.CostOutput = model.Cost.Output
		draft.CostCacheRead = model.Cost.CacheRead
		draft.CostCacheWrite = model.Cost.CacheWrite
		draft.Custom = model.Custom
		for level, value := range model.ThinkingLevelMap {
			draft.Levels[level] = value
		}
	}
	draft.IsNew = false
	return draft
}

// openModelEditor shows the editable form for a custom model. Catalog models
// without a models.json entry keep the read-only panel: replacing them would
// drop metadata the form does not show.
func (m *Model) openModelEditor(providerID, modelID string, isNew bool) {
	model := m.catalog.Model(providerID + "/" + modelID)
	if !isNew && (model == nil || !model.Custom) {
		m.openModelPanel(providerID, modelID)
		return
	}
	draft := m.modelDraftFrom(providerID, modelID, isNew)
	rows := []settingsRow{
		{
			ID:      "model-provider",
			Label:   "Provider",
			Kind:    settingsInfo,
			Current: func() string { return draft.ProviderID },
		},
	}

	if draft.IsNew {
		rows = append(rows, settingsRow{
			ID:        "model-id",
			Label:     "Model id",
			Kind:      settingsText,
			Current:   func() string { return draft.ID },
			EditValue: func() string { return draft.ID },
			Apply: func(value string) error {
				draft.ID = strings.TrimSpace(value)
				return nil
			},
		})
	} else {
		rows = append(rows, settingsRow{
			ID:      "model-id",
			Label:   "Model id",
			Kind:    settingsInfo,
			Current: func() string { return draft.ID },
		})
	}

	rows = append(rows,
		settingsRow{
			ID:        "model-name",
			Label:     "Name",
			Kind:      settingsText,
			Current:   func() string { return draft.Name },
			EditValue: func() string { return draft.Name },
			Apply: func(value string) error {
				draft.Name = strings.TrimSpace(value)
				return nil
			},
		},
		settingsRow{
			ID:        "model-context",
			Label:     "Context window",
			Kind:      settingsText,
			Current:   func() string { return strconv.Itoa(draft.ContextWindow) },
			EditValue: func() string { return strconv.Itoa(draft.ContextWindow) },
			Apply: func(value string) error {
				n, err := positiveInt(value, "context window")
				if err != nil {
					return err
				}
				draft.ContextWindow = n
				return nil
			},
		},
		settingsRow{
			ID:        "model-max",
			Label:     "Max output tokens",
			Kind:      settingsText,
			Current:   func() string { return strconv.Itoa(draft.MaxTokens) },
			EditValue: func() string { return strconv.Itoa(draft.MaxTokens) },
			Apply: func(value string) error {
				n, err := positiveInt(value, "max output tokens")
				if err != nil {
					return err
				}
				draft.MaxTokens = n
				return nil
			},
		},
		settingsRow{
			ID:      "model-reasoning",
			Label:   "Reasoning",
			Kind:    settingsToggle,
			Bool:    func() bool { return draft.Reasoning },
			SetBool: func(on bool) error { draft.Reasoning = on; return nil },
		},
		settingsRow{
			ID:      "model-image",
			Label:   "Image input",
			Kind:    settingsToggle,
			Bool:    func() bool { return draft.Image },
			SetBool: func(on bool) error { draft.Image = on; return nil },
		},
		settingsRow{
			ID:        "model-cost-input",
			Label:     "Cost input /M",
			Kind:      settingsText,
			Current:   func() string { return formatCost(draft.CostInput) },
			EditValue: func() string { return formatCost(draft.CostInput) },
			Apply: func(value string) error {
				f, err := parseCost(value)
				if err != nil {
					return err
				}
				draft.CostInput = f
				return nil
			},
		},
		settingsRow{
			ID:        "model-cost-output",
			Label:     "Cost output /M",
			Kind:      settingsText,
			Current:   func() string { return formatCost(draft.CostOutput) },
			EditValue: func() string { return formatCost(draft.CostOutput) },
			Apply: func(value string) error {
				f, err := parseCost(value)
				if err != nil {
					return err
				}
				draft.CostOutput = f
				return nil
			},
		},
		settingsRow{
			ID:        "model-cost-cache-read",
			Label:     "Cost cache read /M",
			Kind:      settingsText,
			Current:   func() string { return formatCost(draft.CostCacheRead) },
			EditValue: func() string { return formatCost(draft.CostCacheRead) },
			Apply: func(value string) error {
				f, err := parseCost(value)
				if err != nil {
					return err
				}
				draft.CostCacheRead = f
				return nil
			},
		},
		settingsRow{
			ID:        "model-cost-cache-write",
			Label:     "Cost cache write /M",
			Kind:      settingsText,
			Current:   func() string { return formatCost(draft.CostCacheWrite) },
			EditValue: func() string { return formatCost(draft.CostCacheWrite) },
			Apply: func(value string) error {
				f, err := parseCost(value)
				if err != nil {
					return err
				}
				draft.CostCacheWrite = f
				return nil
			},
		},
		settingsRow{
			ID:    "model-levels",
			Label: "Thinking level map",
			Kind:  settingsAction,
			Help:  "Map pi levels to provider values; blank inherits, '-' marks unsupported.",
			Run: func(m *Model, _ *settingsState) tea.Cmd {
				m.openThinkingMapEditor(draft)
				return nil
			},
		},
		settingsRow{
			ID:    "model-save",
			Label: "Save model",
			Kind:  settingsAction,
			Help:  "Writes the model to models.json.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				if err := m.saveModelDraft(draft); err != nil {
					s.err = err.Error()
					return nil
				}
				m.reloadConfig()
				m.openProviderPanel(draft.ProviderID)
				if m.settingsPanel != nil {
					m.settingsPanel.notice = "model saved"
				}
				return nil
			},
		},
	)

	if !draft.IsNew {
		rows = append(rows, settingsRow{
			ID:    "model-delete",
			Label: "Delete model",
			Kind:  settingsAction,
			Help:  "Press enter twice to remove this model from models.json.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				if !draft.confirmDel {
					draft.confirmDel = true
					s.notice = "press enter again to delete"
					return nil
				}
				if err := m.deleteModel(draft.ProviderID, draft.ID); err != nil {
					s.err = err.Error()
					return nil
				}
				m.reloadConfig()
				m.openProviderPanel(draft.ProviderID)
				if m.settingsPanel != nil {
					m.settingsPanel.notice = "model deleted"
				}
				return nil
			},
		})
	}

	m.openModelsPanel("Model: "+draft.ID, rows)
}

// openThinkingMapEditor edits one model's thinkingLevelMap entries.
func (m *Model) openThinkingMapEditor(draft *modelDraft) {
	rows := make([]settingsRow, 0, len(config.ThinkingLevels)+1)
	rows = append(rows, settingsRow{
		ID:      "levels-note",
		Label:   "Format",
		Kind:    settingsInfo,
		Current: func() string { return "blank = default, - = unsupported" },
	})
	for _, level := range config.ThinkingLevels {
		level := level
		rows = append(rows, settingsRow{
			ID:    "level-" + level,
			Label: level,
			Kind:  settingsText,
			Current: func() string {
				value, ok := draft.Levels[level]
				if !ok {
					return "default"
				}
				if value == nil {
					return "unsupported"
				}
				return *value
			},
			EditValue: func() string {
				value, ok := draft.Levels[level]
				if !ok || value == nil {
					return ""
				}
				return *value
			},
			Apply: func(value string) error {
				value = strings.TrimSpace(value)
				switch value {
				case "":
					delete(draft.Levels, level)
				case "-":
					draft.Levels[level] = nil
				default:
					copied := value
					draft.Levels[level] = &copied
				}
				return nil
			},
		})
	}
	m.openModelsPanel("Thinking map: "+draft.ID, rows)
}

func (m *Model) saveModelDraft(draft *modelDraft) error {
	if m.modelsFile == nil {
		return fmt.Errorf("models.json unavailable")
	}
	if strings.TrimSpace(draft.ID) == "" {
		return fmt.Errorf("model id is required")
	}
	entry := config.NewObject()
	if existing := config.FindModel(m.modelsFile.Provider(draft.ProviderID), draft.ID); existing != nil {
		entry = existing.Clone()
	}
	entry.SetString("id", draft.ID)
	if draft.Name != "" {
		entry.SetString("name", draft.Name)
	} else {
		entry.Delete("name")
	}
	if draft.ContextWindow > 0 {
		entry.SetNumber("contextWindow", float64(draft.ContextWindow))
	} else {
		entry.Delete("contextWindow")
	}
	if draft.MaxTokens > 0 {
		entry.SetNumber("maxTokens", float64(draft.MaxTokens))
	} else {
		entry.Delete("maxTokens")
	}
	if draft.Reasoning {
		entry.SetBool("reasoning", true)
	} else {
		entry.Delete("reasoning")
	}
	if draft.Image {
		entry.SetStrings("input", []string{"text", "image"})
	} else {
		entry.Delete("input")
	}
	cost := config.NewObject()
	cost.SetNumber("input", draft.CostInput)
	cost.SetNumber("output", draft.CostOutput)
	cost.SetNumber("cacheRead", draft.CostCacheRead)
	cost.SetNumber("cacheWrite", draft.CostCacheWrite)
	entry.Set("cost", cost)
	if len(draft.Levels) > 0 {
		levels := config.NewObject()
		for level, value := range draft.Levels {
			if value == nil {
				levels.Set(level, config.NewNull())
			} else {
				levels.SetString(level, *value)
			}
		}
		entry.Set("thinkingLevelMap", levels)
	} else {
		entry.Delete("thinkingLevelMap")
	}
	return m.modelsFile.SetModel(draft.ProviderID, entry)
}

func (m *Model) deleteModel(providerID, modelID string) error {
	if m.modelsFile == nil {
		return fmt.Errorf("models.json unavailable")
	}
	return m.modelsFile.DeleteModel(providerID, modelID)
}

func positiveInt(value, what string) (int, error) {
	n, err := strconv.Atoi(strings.TrimSpace(strings.ReplaceAll(value, ",", "")))
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s must be a number", what)
	}
	return n, nil
}

func parseCost(value string) (float64, error) {
	f, err := strconv.ParseFloat(strings.TrimSpace(strings.ReplaceAll(value, ",", "")), 64)
	if err != nil || f < 0 {
		return 0, fmt.Errorf("cost must be a non-negative number")
	}
	return f, nil
}

func formatCost(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// Add provider action, used by the Models tab.
func (m *Model) addProvider() {
	m.openProviderEditor("", true)
}

// providerModelAction opens the editor for a custom model and the read-only
// panel for a catalog model.
func (m *Model) providerModelAction(providerID, modelID string) {
	model := m.catalog.Model(providerID + "/" + modelID)
	if model != nil && model.Custom {
		m.openModelEditor(providerID, modelID, false)
		return
	}
	m.openModelPanel(providerID, modelID)
}
