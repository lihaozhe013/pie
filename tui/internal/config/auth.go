package config

import "fmt"

// Credential types stored in auth.json.
const (
	CredentialAPIKey = "api_key"
	CredentialOAuth  = "oauth"
)

// AuthFile is a snapshot of auth.json. Credentials are opaque objects: pi and
// pi-ai own their shape, so the client only reads the type and edits API keys.
type AuthFile struct {
	path string
	root *Value
}

// LoadAuth reads auth.json. A missing file reads as an empty object.
func LoadAuth(paths Paths) (*AuthFile, error) {
	doc, err := LoadObject(paths.Auth())
	if err != nil {
		return nil, err
	}
	return &AuthFile{path: paths.Auth(), root: doc.Root()}, nil
}

// Path returns the file path.
func (a *AuthFile) Path() string { return a.path }

// Root returns the current tree.
func (a *AuthFile) Root() *Value { return a.root }

// Credential returns the stored credential for a provider, or nil.
func (a *AuthFile) Credential(providerID string) *Value {
	return a.root.Get(providerID)
}

// Type returns the credential type ("api_key", "oauth"), or "" when the
// provider has no stored credential.
func (a *AuthFile) Type(providerID string) string {
	credential := a.Credential(providerID)
	if credential == nil || !credential.IsObject() {
		return ""
	}
	value, _ := credential.Get("type").AsString()
	return value
}

// Has reports whether a credential is stored for the provider.
func (a *AuthFile) Has(providerID string) bool {
	return a.Credential(providerID) != nil
}

// SetAPIKey stores an API key, replacing any credential for the provider.
func (a *AuthFile) SetAPIKey(providerID, key string) error {
	if providerID == "" {
		return fmt.Errorf("auth: empty provider id")
	}
	if key == "" {
		return a.Remove(providerID)
	}
	err := Update(a.path, func(root *Value) error {
		credential := NewObject()
		credential.SetString("type", CredentialAPIKey)
		credential.SetString("key", key)
		root.Set(providerID, credential)
		return nil
	})
	if err != nil {
		return err
	}
	return a.Reload()
}

// Remove deletes a provider's credential.
func (a *AuthFile) Remove(providerID string) error {
	err := Update(a.path, func(root *Value) error {
		root.Delete(providerID)
		return nil
	})
	if err != nil {
		return err
	}
	return a.Reload()
}

// Reload refreshes the snapshot.
func (a *AuthFile) Reload() error {
	doc, err := LoadObject(a.path)
	if err != nil {
		return err
	}
	a.root = doc.Root()
	return nil
}
