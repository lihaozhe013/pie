// Package modelcatalog merges the model metadata pi ships and caches with the
// user's models.json, so the Models settings tab lists the same providers and
// models the agent uses.
package modelcatalog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/lihaozhe013/pie/tui/internal/config"
)

// Cost is per-million-token pricing in US dollars.
type Cost struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
}

// Model is one model a provider offers.
type Model struct {
	ProviderID       string
	ID               string
	Name             string
	API              string
	BaseURL          string
	Reasoning        bool
	Input            []string
	ContextWindow    int
	MaxTokens        int
	Cost             Cost
	ThinkingLevelMap map[string]*string
	// Custom marks a model defined in models.json rather than the catalog.
	Custom bool
	// Override marks a catalog model whose metadata models.json changes.
	Override bool
}

// Ref is the provider/model reference pi settings use.
func (m *Model) Ref() string { return m.ProviderID + "/" + m.ID }

// Provider is one provider and its models.
type Provider struct {
	ID             string
	Name           string
	BaseURL        string
	API            string
	APIKey         string
	OAuth          string
	Custom         bool
	CredentialType string
	Models         []*Model
}

// Catalog is the merged provider and model list.
type Catalog struct {
	Providers []*Provider
	byID      map[string]*Provider
	byRef     map[string]*Model
}

// Load reads models-store.json, models.json, and auth.json. Any of them being
// missing or unreadable degrades to the other sources; only a missing agent
// directory is an error.
func Load(paths config.Paths) (*Catalog, error) {
	c := &Catalog{byID: map[string]*Provider{}, byRef: map[string]*Model{}}

	storePath := filepath.Join(paths.Dir, "models-store.json")
	if data, err := os.ReadFile(storePath); err == nil {
		if root, parseErr := config.Parse(data); parseErr == nil {
			c.mergeStore(root)
		}
	}

	models, err := config.LoadModels(paths)
	if err != nil {
		return nil, err
	}
	c.mergeModelsFile(models)

	if auth, err := config.LoadAuth(paths); err == nil && auth.Root().IsObject() {
		for _, id := range auth.Root().Keys() {
			if provider := c.byID[id]; provider != nil {
				provider.CredentialType = auth.Type(id)
			}
		}
	}
	return c, nil
}

// Provider returns a provider by id.
func (c *Catalog) Provider(id string) *Provider { return c.byID[id] }

// Model returns a model by its provider/model reference.
func (c *Catalog) Model(ref string) *Model { return c.byRef[ref] }

// Models returns every model in display order.
func (c *Catalog) Models() []*Model {
	var out []*Model
	for _, provider := range c.Providers {
		out = append(out, provider.Models...)
	}
	return out
}

func (c *Catalog) ensureProvider(id string) *Provider {
	if provider := c.byID[id]; provider != nil {
		return provider
	}
	provider := &Provider{ID: id, Name: id}
	c.byID[id] = provider
	c.Providers = append(c.Providers, provider)
	return provider
}

func (c *Catalog) addModel(provider *Provider, model *Model) *Model {
	if existing := c.byRef[model.Ref()]; existing != nil {
		if existing.ProviderID == provider.ID {
			return existing
		}
	}
	model.ProviderID = provider.ID
	provider.Models = append(provider.Models, model)
	c.byRef[model.Ref()] = model
	return model
}

// mergeStore parses models-store.json, whose top level is the provider map.
// Some pi versions wrap it in {"providers": {...}}, so both are accepted.
func (c *Catalog) mergeStore(root *config.Value) {
	if !root.IsObject() {
		return
	}
	providers := root
	if wrapped := root.Get("providers"); wrapped != nil && wrapped.IsObject() {
		providers = wrapped
	}
	for _, id := range providers.Keys() {
		entry := providers.Get(id)
		if entry == nil || !entry.IsObject() {
			continue
		}
		provider := c.ensureProvider(id)
		provider.Name = entry.Get("name").StringOr(id)
		provider.BaseURL = entry.Get("baseUrl").StringOr(provider.BaseURL)
		provider.API = entry.Get("api").StringOr(provider.API)
		models := entry.Get("models")
		if models == nil || !models.IsArray() {
			continue
		}
		for _, raw := range models.Items() {
			model := parseModel(raw)
			if model.ID == "" {
				continue
			}
			if existing := c.byRef[model.Ref()]; existing != nil {
				continue
			}
			c.addModel(provider, model)
		}
	}
}

func (c *Catalog) mergeModelsFile(file *config.ModelsFile) {
	providers := file.Root().Get("providers")
	if providers == nil || !providers.IsObject() {
		return
	}
	for _, id := range providers.Keys() {
		entry := providers.Get(id)
		if entry == nil || !entry.IsObject() {
			continue
		}
		known := c.byID[id] != nil
		provider := c.ensureProvider(id)
		provider.Custom = !known
		provider.Name = entry.Get("name").StringOr(provider.Name)
		provider.BaseURL = entry.Get("baseUrl").StringOr(provider.BaseURL)
		provider.API = entry.Get("api").StringOr(provider.API)
		provider.APIKey = entry.Get("apiKey").StringOr(provider.APIKey)
		provider.OAuth = entry.Get("oauth").StringOr(provider.OAuth)

		if models := entry.Get("models"); models != nil && models.IsArray() {
			for _, raw := range models.Items() {
				model := parseModel(raw)
				if model.ID == "" {
					continue
				}
				model.ProviderID = id
				model.Custom = true
				if existing := c.byRef[model.Ref()]; existing != nil {
					mergeModel(existing, model)
					existing.Custom = true
					continue
				}
				c.addModel(provider, model)
			}
		}

		if overrides := entry.Get("modelOverrides"); overrides != nil && overrides.IsObject() {
			for _, modelID := range overrides.Keys() {
				target := c.byRef[id+"/"+modelID]
				if target == nil {
					continue
				}
				mergeModel(target, parseModel(overrides.Get(modelID)))
				target.Override = true
			}
		}
	}
}

// MergeRuntime folds the models the running pi reports over the file catalog.
// The runtime is authoritative for values it reports; the catalog keeps the
// fields the RPC payload omits, such as thinking-level maps.
func (c *Catalog) MergeRuntime(models []Model) {
	for i := range models {
		model := models[i]
		if model.ProviderID == "" || model.ID == "" {
			continue
		}
		provider := c.ensureProvider(model.ProviderID)
		existing := c.byRef[model.Ref()]
		if existing == nil {
			c.addModel(provider, &model)
			continue
		}
		if model.Name != "" {
			existing.Name = model.Name
		}
		if model.API != "" {
			existing.API = model.API
		}
		if model.BaseURL != "" {
			existing.BaseURL = model.BaseURL
		}
		if model.ContextWindow > 0 {
			existing.ContextWindow = model.ContextWindow
		}
		if model.MaxTokens > 0 {
			existing.MaxTokens = model.MaxTokens
		}
		if model.Cost != (Cost{}) {
			existing.Cost = model.Cost
		}
		if model.Input != nil {
			existing.Input = model.Input
		}
		existing.Reasoning = existing.Reasoning || model.Reasoning
	}
}

func parseModel(raw *config.Value) *Model {
	model := &Model{}
	if raw == nil || !raw.IsObject() {
		return model
	}
	model.ID = raw.Get("id").StringOr("")
	model.Name = raw.Get("name").StringOr("")
	model.API = raw.Get("api").StringOr("")
	model.BaseURL = raw.Get("baseUrl").StringOr("")
	model.Reasoning = raw.Get("reasoning").BoolOr(false)
	if input, ok := raw.Get("input").AsStrings(); ok {
		model.Input = input
	}
	if n, ok := raw.Get("contextWindow").AsInt(); ok {
		model.ContextWindow = n
	}
	if n, ok := raw.Get("maxTokens").AsInt(); ok {
		model.MaxTokens = n
	}
	if cost := raw.Get("cost"); cost != nil && cost.IsObject() {
		model.Cost = Cost{
			Input:      floatOr(cost.Get("input")),
			Output:     floatOr(cost.Get("output")),
			CacheRead:  floatOr(cost.Get("cacheRead")),
			CacheWrite: floatOr(cost.Get("cacheWrite")),
		}
	}
	if levels := raw.Get("thinkingLevelMap"); levels != nil && levels.IsObject() {
		model.ThinkingLevelMap = map[string]*string{}
		for _, level := range levels.Keys() {
			value := levels.Get(level)
			if text, ok := value.AsString(); ok {
				copied := text
				model.ThinkingLevelMap[level] = &copied
			} else {
				model.ThinkingLevelMap[level] = nil
			}
		}
	}
	return model
}

// mergeModel copies the fields a models.json entry sets over target. Zero
// values and empty strings mean "not set", matching how pi merges entries.
func mergeModel(target, source *Model) {
	if source.Name != "" {
		target.Name = source.Name
	}
	if source.API != "" {
		target.API = source.API
	}
	if source.BaseURL != "" {
		target.BaseURL = source.BaseURL
	}
	if source.Reasoning {
		target.Reasoning = true
	}
	if source.Input != nil {
		target.Input = source.Input
	}
	if source.ContextWindow > 0 {
		target.ContextWindow = source.ContextWindow
	}
	if source.MaxTokens > 0 {
		target.MaxTokens = source.MaxTokens
	}
	if source.Cost != (Cost{}) {
		target.Cost = source.Cost
	}
	if source.ThinkingLevelMap != nil {
		target.ThinkingLevelMap = source.ThinkingLevelMap
	}
}

func floatOr(value *config.Value) float64 {
	f, _ := value.AsFloat()
	return f
}

// SupportsImage reports whether the model accepts image input.
func (m *Model) SupportsImage() bool {
	for _, input := range m.Input {
		if input == "image" {
			return true
		}
	}
	return false
}

// SupportsThinkingLevel reports whether pi can select the level for the model.
func (m *Model) SupportsThinkingLevel(level string) bool {
	if level == "off" {
		return true
	}
	if !m.Reasoning {
		return false
	}
	if m.ThinkingLevelMap != nil {
		if value, ok := m.ThinkingLevelMap[level]; ok {
			return value != nil
		}
	}
	switch level {
	case "xhigh", "max":
		return false
	default:
		return true
	}
}

// ProviderOptions lists provider ids in display order.
func (c *Catalog) ProviderOptions() []string {
	ids := make([]string, 0, len(c.Providers))
	for _, provider := range c.Providers {
		ids = append(ids, provider.ID)
	}
	return ids
}

// SortedModels returns models ordered by name for pickers.
func (c *Catalog) SortedModels() []*Model {
	models := c.Models()
	sort.SliceStable(models, func(i, j int) bool {
		if models[i].ProviderID != models[j].ProviderID {
			return models[i].ProviderID < models[j].ProviderID
		}
		left := models[i].Name
		if left == "" {
			left = models[i].ID
		}
		right := models[j].Name
		if right == "" {
			right = models[j].ID
		}
		return strings.ToLower(left) < strings.ToLower(right)
	})
	return models
}

// ParseRuntime converts one get_available_models entry.
func ParseRuntime(data json.RawMessage) (Model, error) {
	var payload struct {
		ID            string   `json:"id"`
		Name          string   `json:"name"`
		API           string   `json:"api"`
		Provider      string   `json:"provider"`
		BaseURL       string   `json:"baseUrl"`
		Reasoning     bool     `json:"reasoning"`
		Input         []string `json:"input"`
		ContextWindow int      `json:"contextWindow"`
		MaxTokens     int      `json:"maxTokens"`
		Cost          struct {
			Input      float64 `json:"input"`
			Output     float64 `json:"output"`
			CacheRead  float64 `json:"cacheRead"`
			CacheWrite float64 `json:"cacheWrite"`
		} `json:"cost"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return Model{}, err
	}
	if payload.ID == "" || payload.Provider == "" {
		return Model{}, fmt.Errorf("model entry is missing id or provider")
	}
	return Model{
		ID:            payload.ID,
		Name:          payload.Name,
		API:           payload.API,
		ProviderID:    payload.Provider,
		BaseURL:       payload.BaseURL,
		Reasoning:     payload.Reasoning,
		Input:         payload.Input,
		ContextWindow: payload.ContextWindow,
		MaxTokens:     payload.MaxTokens,
		Cost: Cost{
			Input:      payload.Cost.Input,
			Output:     payload.Cost.Output,
			CacheRead:  payload.Cost.CacheRead,
			CacheWrite: payload.Cost.CacheWrite,
		},
	}, nil
}

// RuntimeModels converts a get_available_models payload.
func RuntimeModels(raw json.RawMessage) ([]Model, error) {
	var payload struct {
		Models []json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	out := make([]Model, 0, len(payload.Models))
	for _, entry := range payload.Models {
		model, err := ParseRuntime(entry)
		if err != nil {
			continue
		}
		out = append(out, model)
	}
	return out, nil
}
