package config

import "strings"

// ModelsFile is a snapshot of models.json. pi owns the file; the Models panel
// reads it, merges it over the catalog, and writes only the entries the user
// edits.
type ModelsFile struct {
	path string
	root *Value
}

// LoadModels reads models.json. A missing file reads as {"providers": {}}.
func LoadModels(paths Paths) (*ModelsFile, error) {
	doc, err := LoadObject(paths.Models())
	if err != nil {
		return nil, err
	}
	root := doc.Root()
	if !root.Has("providers") {
		root.Set("providers", NewObject())
	}
	return &ModelsFile{path: paths.Models(), root: root}, nil
}

// Path returns the file path.
func (m *ModelsFile) Path() string { return m.path }

// Root returns the current tree.
func (m *ModelsFile) Root() *Value { return m.root }

// ProviderIDs lists the custom providers in file order.
func (m *ModelsFile) ProviderIDs() []string {
	return m.root.GetPath("providers").Keys()
}

// Provider returns one custom provider entry.
func (m *ModelsFile) Provider(id string) *Value {
	return m.root.GetPath("providers", id)
}

// Update applies fn to a freshly loaded models.json and writes it back with
// partial cost groups completed with zeros, as pie does.
func (m *ModelsFile) Update(fn func(root *Value) error) error {
	err := Update(m.path, func(root *Value) error {
		if !root.Has("providers") || !root.Get("providers").IsObject() {
			root.Set("providers", NewObject())
		}
		if err := fn(root); err != nil {
			return err
		}
		normalizeModelsCosts(root)
		return nil
	})
	if err != nil {
		return err
	}
	return m.Reload()
}

// Reload refreshes the snapshot.
func (m *ModelsFile) Reload() error {
	doc, err := LoadObject(m.path)
	if err != nil {
		return err
	}
	m.root = doc.Root()
	return nil
}

// SetProvider writes a provider entry (creating it) and returns after reload.
func (m *ModelsFile) SetProvider(id string, provider *Value) error {
	if id == "" {
		return errEmpty("provider id")
	}
	return m.Update(func(root *Value) error {
		EnsureProviders(root).Set(id, provider.Clone())
		return nil
	})
}

// DeleteProvider removes a provider entry.
func (m *ModelsFile) DeleteProvider(id string) error {
	return m.Update(func(root *Value) error {
		EnsureProviders(root).Delete(id)
		return nil
	})
}

// SetModel writes one model under a provider, replacing a model with the same
// id or appending it.
func (m *ModelsFile) SetModel(providerID string, model *Value) error {
	if providerID == "" {
		return errEmpty("provider id")
	}
	id, _ := model.Get("id").AsString()
	if strings.TrimSpace(id) == "" {
		return errEmpty("model id")
	}
	return m.Update(func(root *Value) error {
		provider := EnsureProvider(root, providerID)
		UpsertModel(provider, model.Clone())
		return nil
	})
}

// DeleteModel removes a model from a provider.
func (m *ModelsFile) DeleteModel(providerID, modelID string) error {
	return m.Update(func(root *Value) error {
		provider := EnsureProviders(root).Get(providerID)
		if provider == nil || !provider.IsObject() {
			return nil
		}
		DeleteModel(provider, modelID)
		return nil
	})
}

// SetModelOverride writes a modelOverrides entry.
func (m *ModelsFile) SetModelOverride(providerID, modelID string, override *Value) error {
	return m.Update(func(root *Value) error {
		provider := EnsureProvider(root, providerID)
		overrides := provider.Get("modelOverrides")
		if overrides == nil || !overrides.IsObject() {
			overrides = NewObject()
			provider.Set("modelOverrides", overrides)
		}
		overrides.Set(modelID, override.Clone())
		return nil
	})
}

// DeleteModelOverride removes a modelOverrides entry.
func (m *ModelsFile) DeleteModelOverride(providerID, modelID string) error {
	return m.Update(func(root *Value) error {
		provider := EnsureProviders(root).Get(providerID)
		if provider == nil || !provider.IsObject() {
			return nil
		}
		if overrides := provider.Get("modelOverrides"); overrides != nil && overrides.IsObject() {
			overrides.Delete(modelID)
			if overrides.Len() == 0 {
				provider.Delete("modelOverrides")
			}
		}
		return nil
	})
}

// EnsureProviders returns the providers object, creating it when missing.
func EnsureProviders(root *Value) *Value {
	providers := root.Get("providers")
	if providers == nil || !providers.IsObject() {
		providers = NewObject()
		root.Set("providers", providers)
	}
	return providers
}

// EnsureProvider returns one provider object, creating it when missing.
func EnsureProvider(root *Value, id string) *Value {
	providers := EnsureProviders(root)
	provider := providers.Get(id)
	if provider == nil || !provider.IsObject() {
		provider = NewObject()
		providers.Set(id, provider)
	}
	return provider
}

// FindModel returns the models[] entry with id.
func FindModel(provider *Value, id string) *Value {
	if provider == nil || !provider.IsObject() {
		return nil
	}
	models := provider.Get("models")
	if models == nil || !models.IsArray() {
		return nil
	}
	for _, model := range models.Items() {
		if model.IsObject() && model.Get("id").StringOr("") == id {
			return model
		}
	}
	return nil
}

// UpsertModel replaces the model with the same id or appends it.
func UpsertModel(provider *Value, model *Value) {
	models := provider.Get("models")
	if models == nil || !models.IsArray() {
		models = NewArray()
		provider.Set("models", models)
	}
	id := model.Get("id").StringOr("")
	for i, existing := range models.Items() {
		if existing.IsObject() && existing.Get("id").StringOr("") == id {
			models.items[i] = model
			return
		}
	}
	models.Append(model)
}

// DeleteModel removes the model with id, reporting whether it existed.
func DeleteModel(provider *Value, id string) bool {
	models := provider.Get("models")
	if models == nil || !models.IsArray() {
		return false
	}
	out := models.items[:0]
	found := false
	for _, model := range models.items {
		if model.IsObject() && model.Get("id").StringOr("") == id {
			found = true
			continue
		}
		out = append(out, model)
	}
	models.items = out
	return found
}

var modelCostKeys = []string{"input", "output", "cacheRead", "cacheWrite"}

// normalizeModelsCosts completes partial cost objects with zero and drops an
// empty one, matching pie's models.json writer.
func normalizeModelsCosts(root *Value) {
	providers := root.Get("providers")
	if providers == nil || !providers.IsObject() {
		return
	}
	for _, providerID := range providers.Keys() {
		provider := providers.Get(providerID)
		if provider == nil || !provider.IsObject() {
			continue
		}
		models := provider.Get("models")
		if models == nil || !models.IsArray() {
			continue
		}
		for _, model := range models.Items() {
			if !model.IsObject() || !model.Has("cost") {
				continue
			}
			cost := model.Get("cost")
			if !cost.IsObject() {
				model.Delete("cost")
				continue
			}
			provided := 0
			for _, key := range modelCostKeys {
				if cost.Has(key) {
					provided++
				}
			}
			if provided == 0 {
				model.Delete("cost")
				continue
			}
			for _, key := range modelCostKeys {
				if _, ok := cost.Get(key).AsFloat(); !ok {
					cost.SetNumber(key, 0)
				}
			}
		}
	}
}

func errEmpty(what string) error {
	return &emptyError{what: what}
}

type emptyError struct{ what string }

func (e *emptyError) Error() string { return e.what + " is required" }

// SetContextWindowOverride writes or clears one model's contextWindow override,
// keeping every other key in the same overrides entry and removing empty
// objects so an untouched models.json stays clean.
func (m *ModelsFile) SetContextWindowOverride(providerID, modelID string, window *int) error {
	if providerID == "" || modelID == "" {
		return errEmpty("provider and model ids")
	}
	if window != nil && *window <= 0 {
		return &TypeError{Path: m.path, Key: "contextWindow", Expected: "a positive token count", Got: KindNumber}
	}
	return m.Update(func(root *Value) error {
		provider := EnsureProvider(root, providerID)
		overrides := provider.Get("modelOverrides")
		if overrides == nil || !overrides.IsObject() {
			if window == nil {
				return nil
			}
			overrides = NewObject()
			provider.Set("modelOverrides", overrides)
		}
		entry := overrides.Get(modelID)
		if entry == nil || !entry.IsObject() {
			if window == nil {
				return nil
			}
			entry = NewObject()
			overrides.Set(modelID, entry)
		}
		if window == nil {
			entry.Delete("contextWindow")
			if entry.Len() == 0 {
				overrides.Delete(modelID)
			}
			if overrides.Len() == 0 {
				provider.Delete("modelOverrides")
			}
			return nil
		}
		entry.SetNumber("contextWindow", float64(*window))
		return nil
	})
}

// ContextWindowOverrides lists providerID/modelID keys that set a context
// window in modelOverrides.
func (m *ModelsFile) ContextWindowOverrides() map[string]int {
	out := map[string]int{}
	for _, providerID := range m.ProviderIDs() {
		overrides := m.Provider(providerID).Get("modelOverrides")
		if overrides == nil || !overrides.IsObject() {
			continue
		}
		for _, modelID := range overrides.Keys() {
			value := overrides.Get(modelID).Get("contextWindow")
			if window, ok := value.AsInt(); ok && window > 0 {
				out[providerID+"/"+modelID] = window
			}
		}
	}
	return out
}
