package modelcatalog

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// ProviderAuth is the sign-in surface of one provider, as the bridge
// extension's /pie-providers snapshot reports it. Credentials stay in
// auth.json; this only describes which methods exist and whether one is
// already configured.
type ProviderAuth struct {
	ID   string
	Name string

	// APIKeyName is the display name of the API-key method. APIKeyLogin is
	// false for ambient-only methods, which cannot be set from a dialog.
	APIKeyName  string
	APIKeyLogin bool

	// OAuthName is the display name of the OAuth method, and OAuthSub marks a
	// subscription-backed account rather than a metered API key.
	OAuthName  string
	OAuthSub   bool
	OAuthLabel string
	ModelCount int

	Configured  bool
	Source      string
	SourceLabel string
}

// HasOAuth reports whether the provider offers an OAuth sign-in.
func (a *ProviderAuth) HasOAuth() bool { return a != nil && a.OAuthName != "" }

// HasAPIKey reports whether the provider declares an API-key method.
func (a *ProviderAuth) HasAPIKey() bool { return a != nil && a.APIKeyName != "" }

// Help describes the provider's sign-in methods for a settings row.
func (a *ProviderAuth) Help() string {
	if a == nil {
		return ""
	}
	methods := make([]string, 0, 2)
	if a.OAuthName != "" {
		methods = append(methods, "oauth: "+a.OAuthName)
	}
	if a.APIKeyName != "" {
		methods = append(methods, "api key: "+a.APIKeyName)
	}
	if len(methods) == 0 {
		return "This provider reads its credential from the environment or models.json."
	}
	return "Available: " + strings.Join(methods, "; ") + "."
}

// Status is the one-line configuration state for the provider list.
func (a *ProviderAuth) Status() string {
	if a == nil {
		return "unknown"
	}
	if !a.Configured {
		return "not configured"
	}
	switch a.Source {
	case "stored":
		return "credential stored"
	case "runtime":
		return "session credential"
	case "environment":
		if a.SourceLabel != "" {
			return "environment (" + a.SourceLabel + ")"
		}
		return "environment"
	case "fallback":
		return "configured"
	case "models_json_key":
		return "models.json key"
	case "models_json_command":
		return "models.json command"
	}
	return "configured"
}

// providerAuthFile mirrors the JSON /pie-providers writes. Unknown fields are
// ignored so a newer bridge can add them without breaking this client.
type providerAuthFile struct {
	Version   int `json:"version"`
	Providers []struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		APIKey *struct {
			Name  string `json:"name"`
			Login bool   `json:"login"`
		} `json:"apiKey"`
		OAuth *struct {
			Name         string `json:"name"`
			Subscription bool   `json:"subscription"`
			LoginLabel   string `json:"loginLabel"`
		} `json:"oauth"`
		Status *struct {
			Configured bool   `json:"configured"`
			Source     string `json:"source"`
			Label      string `json:"label"`
		} `json:"status"`
		ModelCount int `json:"modelCount"`
	} `json:"providers"`
}

// ParseProviderAuth converts a /pie-providers snapshot into provider metadata.
func ParseProviderAuth(data []byte) (map[string]*ProviderAuth, error) {
	var file providerAuthFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("provider snapshot: %w", err)
	}
	providers := make(map[string]*ProviderAuth, len(file.Providers))
	for _, row := range file.Providers {
		if row.ID == "" {
			continue
		}
		auth := &ProviderAuth{
			ID:         row.ID,
			Name:       row.Name,
			ModelCount: row.ModelCount,
		}
		if row.APIKey != nil {
			auth.APIKeyName = row.APIKey.Name
			auth.APIKeyLogin = row.APIKey.Login
		}
		if row.OAuth != nil {
			auth.OAuthName = row.OAuth.Name
			auth.OAuthSub = row.OAuth.Subscription
			auth.OAuthLabel = row.OAuth.LoginLabel
		}
		if row.Status != nil {
			auth.Configured = row.Status.Configured
			auth.Source = row.Status.Source
			auth.SourceLabel = row.Status.Label
		}
		providers[row.ID] = auth
	}
	return providers, nil
}

// MergeAuth attaches auth metadata to the catalog and appends providers only
// the runtime knows about, so the Models panel can offer a sign-in before any
// credential exists. Existing providers keep their catalog position.
func (c *Catalog) MergeAuth(providers map[string]*ProviderAuth) {
	if len(providers) == 0 {
		return
	}
	missing := make([]string, 0, len(providers))
	for id, auth := range providers {
		if auth == nil {
			continue
		}
		if provider := c.byID[id]; provider != nil {
			provider.Auth = auth
			if auth.Name != "" && (provider.Name == "" || provider.Name == provider.ID) {
				provider.Name = auth.Name
			}
			continue
		}
		missing = append(missing, id)
	}
	sort.Strings(missing)
	for _, id := range missing {
		auth := providers[id]
		provider := c.ensureProvider(id)
		if auth.Name != "" {
			provider.Name = auth.Name
		}
		provider.Auth = auth
	}
}
