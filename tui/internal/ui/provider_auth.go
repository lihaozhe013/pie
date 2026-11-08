package ui

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/config"
	"github.com/lihaozhe013/pie/tui/internal/modelcatalog"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

// authNotifyPrefix marks an extension notification that carries sign-in state.
// pi's RPC UI protocol has no richer channel, so the bridge sends one JSON line
// through notify and this client renders the overlay itself.
const authNotifyPrefix = "pie-auth "

// authNotify is one sign-in message from the bridge.
type authNotify struct {
	Provider     string `json:"provider"`
	Kind         string `json:"kind"`
	URL          string `json:"url"`
	Code         string `json:"code"`
	Message      string `json:"message"`
	Instructions string `json:"instructions"`
	OK           *bool  `json:"ok"`
	Cancelled    bool   `json:"cancelled"`
	SignedOut    bool   `json:"signedOut"`
}

// parseAuthNotify decodes a pie-auth notification, if the text is one.
func parseAuthNotify(message string) (authNotify, bool) {
	if !strings.HasPrefix(message, authNotifyPrefix) {
		return authNotify{}, false
	}
	var payload authNotify
	if err := json.Unmarshal([]byte(strings.TrimPrefix(message, authNotifyPrefix)), &payload); err != nil {
		return authNotify{}, false
	}
	if payload.Kind == "" {
		return authNotify{}, false
	}
	return payload, true
}

// loadProviderAuth asks the bridge for the provider and sign-in snapshot. The
// snapshot lists providers with no credential, which `get_available_models`
// cannot report because it only covers configured ones.
func (m *Model) loadProviderAuth() tea.Cmd {
	if !m.bridgeReady {
		return nil
	}
	client := m.client
	return func() tea.Msg {
		dir, err := os.MkdirTemp("", "pie-providers-*")
		if err != nil {
			return providerAuthMsg{err: err}
		}
		defer func() { _ = os.RemoveAll(dir) }()
		path := filepath.Join(dir, "providers.json")

		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if _, err := client.DoOK(ctx, rpc.Prompt("/pie-providers "+path)); err != nil {
			return providerAuthMsg{err: err}
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return providerAuthMsg{err: err}
		}
		providers, err := modelcatalog.ParseProviderAuth(data)
		if err != nil {
			return providerAuthMsg{err: err}
		}
		return providerAuthMsg{providers: providers}
	}
}

// refreshAvailableModels rereads the models the running pi can use. A sign-in
// changes that list, and the RPC reply carries no event of its own.
func (m *Model) refreshAvailableModels() tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		response, err := client.DoOK(ctx, rpc.GetAvailableModels())
		if err != nil {
			return availableModelsMsg{err: err}
		}
		payload, _ := rpc.DecodeTyped[rpc.ModelsPayload](response)
		return availableModelsMsg{models: payload.Models}
	}
}

// adoptPendingModel selects the new provider's first model when the session
// still has none, which is the state a first sign-in starts from.
func (m *Model) adoptPendingModel() tea.Cmd {
	providerID := m.pendingModelPick
	if providerID == "" {
		return nil
	}
	m.pendingModelPick = ""
	if m.state.Model != nil {
		return nil
	}
	for _, model := range m.models {
		if model.Provider != providerID {
			continue
		}
		return m.setModelByLabel(model.Label())
	}
	m.setToast("signed in; choose a model with /model")
	return nil
}

// providerLabel is the display name for a provider id.
func (m *Model) providerLabel(providerID string) string {
	if m.catalog != nil {
		if provider := m.catalog.Provider(providerID); provider != nil {
			if provider.Name != "" {
				return provider.Name
			}
			return providerID
		}
	}
	if auth := m.providerAuth[providerID]; auth != nil && auth.Name != "" {
		return auth.Name
	}
	return providerID
}

// startProviderLogin runs the bridge's sign-in command. The command returns
// before the flow finishes; progress and results arrive as pie-auth
// notifications, so the UI stays responsive during a browser login.
func (m *Model) startProviderLogin(providerID, authType string) tea.Cmd {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" {
		return nil
	}
	if !m.bridgeReady {
		m.setToast("provider sign-in needs the bridge extension; restart pie")
		return nil
	}
	if m.authFlow != "" {
		m.setToast("a sign-in is already running")
		return nil
	}
	if m.busy {
		m.setToast("wait for the current turn before signing in")
		return nil
	}
	m.authFlow = providerID
	m.setToast("signing in to " + m.providerLabel(providerID) + "…")

	command := "/pie-login " + providerID
	if authType == "oauth" || authType == "api_key" {
		command += " " + authType
	}
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, err := client.DoOK(ctx, rpc.Prompt(command))
		return providerAuthCommandMsg{action: "login", provider: providerID, err: err}
	}
}

// startProviderLogout removes the stored credential through the bridge, which
// also updates the running session's model availability.
func (m *Model) startProviderLogout(providerID string) tea.Cmd {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" {
		return nil
	}
	if !m.bridgeReady {
		m.setToast("provider sign-out needs the bridge extension; restart pie")
		return nil
	}
	if m.authFlow != "" {
		m.setToast("finish the running sign-in first")
		return nil
	}
	m.setToast("signing out of " + m.providerLabel(providerID) + "…")

	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, err := client.DoOK(ctx, rpc.Prompt("/pie-logout "+providerID))
		return providerAuthCommandMsg{action: "logout", provider: providerID, err: err}
	}
}

// cancelProviderLogin aborts the flow the bridge is running for a provider.
func (m *Model) cancelProviderLogin(providerID string) tea.Cmd {
	client := m.client
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, err := client.DoOK(ctx, rpc.Prompt("/pie-auth-cancel "+providerID))
		return providerAuthCommandMsg{action: "cancel", provider: providerID, err: err}
	}
}

// loginItems lists every provider and sign-in method as picker rows. The value
// encodes "provider|method" so a dual-auth provider appears twice.
func (m *Model) loginItems() []pickerItem {
	if m.catalog == nil {
		return nil
	}
	providers := append([]*modelcatalog.Provider(nil), m.catalog.Providers...)
	sort.SliceStable(providers, func(i, j int) bool { return providers[i].Name < providers[j].Name })

	items := make([]pickerItem, 0, len(providers))
	for _, provider := range providers {
		auth := provider.Auth
		if auth == nil {
			continue
		}
		if auth.HasOAuth() {
			detail := auth.OAuthLabel
			if detail == "" {
				detail = "oauth"
				if auth.OAuthSub {
					detail = "oauth subscription"
				}
			}
			if auth.Configured {
				detail += " · configured"
			}
			items = append(items, pickerItem{
				Value:  provider.ID + "|oauth",
				Label:  provider.Name + " · OAuth",
				Detail: detail,
			})
		}
		if auth.APIKeyLogin {
			detail := "api key"
			if auth.Configured {
				detail += " · configured"
			}
			items = append(items, pickerItem{
				Value:  provider.ID + "|api_key",
				Label:  provider.Name + " · API key",
				Detail: detail,
			})
		}
	}
	return items
}

// logoutItems lists providers with a stored credential.
func (m *Model) logoutItems() []pickerItem {
	if m.catalog == nil {
		return nil
	}
	providers := append([]*modelcatalog.Provider(nil), m.catalog.Providers...)
	sort.SliceStable(providers, func(i, j int) bool { return providers[i].Name < providers[j].Name })

	items := make([]pickerItem, 0, len(providers))
	for _, provider := range providers {
		if provider.CredentialType == "" {
			continue
		}
		items = append(items, pickerItem{
			Value:  provider.ID,
			Label:  provider.Name,
			Detail: provider.CredentialType,
		})
	}
	return items
}

// openLoginPicker opens the provider/method picker, or starts a named provider
// directly.
func (m *Model) openLoginPicker(argument string) tea.Cmd {
	if !m.bridgeReady {
		m.setToast("provider sign-in needs the bridge extension; restart pie")
		return nil
	}
	if m.providerAuth == nil {
		if m.providerAuthErr != nil {
			m.setToast("provider list: " + m.providerAuthErr.Error())
		} else {
			m.setToast("reading the provider list…")
		}
		return m.loadProviderAuth()
	}
	if target := strings.TrimSpace(argument); target != "" {
		providerID, authType, ok := m.resolveLoginTarget(target)
		if !ok {
			m.setToast("unknown provider: " + target)
			return nil
		}
		return m.startProviderLogin(providerID, authType)
	}
	items := m.loginItems()
	if len(items) == 0 {
		m.setToast("no provider offers sign-in")
		return nil
	}
	m.openOverlay(newPickerOverlay("login", "Sign in to a provider", items))
	return nil
}

// resolveLoginTarget accepts "provider", "provider/oauth", or
// "provider/api_key" and matches the display name too.
func (m *Model) resolveLoginTarget(target string) (string, string, bool) {
	authType := ""
	if index := strings.LastIndex(target, "/"); index > 0 {
		switch target[index+1:] {
		case "oauth", "api_key":
			authType = target[index+1:]
			target = target[:index]
		}
	}
	if m.catalog == nil {
		return "", "", false
	}
	for _, provider := range m.catalog.Providers {
		if provider.Auth == nil {
			continue
		}
		if strings.EqualFold(provider.ID, target) || (provider.Name != "" && strings.EqualFold(provider.Name, target)) {
			return provider.ID, authType, true
		}
	}
	return "", "", false
}

// openLogoutPicker lists providers with a stored credential.
func (m *Model) openLogoutPicker() tea.Cmd {
	if !m.bridgeReady {
		m.setToast("provider sign-out needs the bridge extension; restart pie")
		return nil
	}
	items := m.logoutItems()
	if len(items) == 0 {
		m.setToast("no stored provider credentials")
		return nil
	}
	m.openOverlay(newPickerOverlay("logout", "Sign out of a provider", items))
	return nil
}

// openOverlayFromSettings opens a picker that returns to the panel it left.
func (m *Model) openOverlayFromSettings(open func()) {
	previous := m.overlay
	open()
	if previous == nil || m.overlay == nil || m.overlay == previous {
		return
	}
	m.overlay.returnTo = previous
}

// refreshAuthPanels rebuilds an open Providers panel so it shows the
// credential state a sign-in just changed.
func (m *Model) refreshAuthPanels() {
	if m.settingsPanel == nil || m.overlay == nil {
		return
	}
	switch m.overlay.action {
	case "settings":
		if !m.settingsPanel.single {
			m.openSettingsOverlay()
		}
	case "settings-panel":
		if m.panelProvider != "" {
			m.openProviderPanel(m.panelProvider)
		}
	}
}

// signOutProvider removes a stored credential, with the bridge when the
// running pi can do it and directly from auth.json otherwise.
func (m *Model) signOutProvider(providerID string) tea.Cmd {
	if m.bridgeReady {
		return m.startProviderLogout(providerID)
	}
	auth, err := config.LoadAuth(m.paths)
	if err != nil {
		m.setToast(err.Error())
		return nil
	}
	if err := auth.Remove(providerID); err != nil {
		m.setToast(err.Error())
		return nil
	}
	m.reloadConfig()
	delete(m.providerUsage, providerID)
	m.setToast(m.providerLabel(providerID) + ": signed out")
	return m.loadProviderAuth()
}

// applyAuthNotify folds one sign-in message into the UI.
func (m *Model) applyAuthNotify(payload authNotify) tea.Cmd {
	providerID := payload.Provider
	switch payload.Kind {
	case "url":
		m.openAuthOverlay(providerID, payload.URL, "", payload.Instructions)
		m.setToast("sign in to " + m.providerLabel(providerID) + ": finish in the browser")
		return nil
	case "device":
		m.openAuthOverlay(providerID, payload.URL, payload.Code, "")
		host := displayHost(payload.URL)
		if host == "" {
			host = "the provider's page"
		}
		m.setToast("sign in to " + m.providerLabel(providerID) + ": enter the code at " + host)
		return nil
	case "info", "progress":
		if payload.Message != "" {
			m.setToast(payload.Message)
		}
		return nil
	case "done":
		return m.finishAuthFlow(payload)
	default:
		return nil
	}
}

// finishAuthFlow clears the pending sign-in and refreshes everything it
// changed: the credential file, the provider snapshot, and the model list.
func (m *Model) finishAuthFlow(payload authNotify) tea.Cmd {
	providerID := payload.Provider
	if m.authFlow == providerID {
		m.authFlow = ""
	}
	m.clearAuthDialogs()

	ok := payload.OK != nil && *payload.OK
	if !ok {
		if payload.Cancelled {
			m.setToast(payload.Message)
			return nil
		}
		message := payload.Message
		if message == "" {
			message = "sign-in failed"
		}
		m.addError("provider sign-in: " + message)
		return nil
	}

	m.reloadConfig()
	delete(m.providerUsage, providerID)
	message := payload.Message
	if message == "" {
		if payload.SignedOut {
			message = "signed out"
		} else {
			message = "signed in"
		}
	}
	m.setToast(m.providerLabel(providerID) + ": " + message)

	commands := make([]tea.Cmd, 0, 3)
	commands = append(commands, m.refreshState(), m.loadProviderAuth(), m.refreshAvailableModels())
	if payload.SignedOut {
		return tea.Batch(commands...)
	}
	m.pendingModelPick = providerID
	return tea.Batch(commands...)
}

// clearAuthDialogs drops the dialogs a finished flow left open. A login races
// a manual code prompt against its callback server, so the losing prompt can
// still be on screen when the flow ends.
func (m *Model) clearAuthDialogs() {
	m.pendingAuthStep = nil
	m.dialogs = nil
	if m.overlay == nil {
		return
	}
	if m.overlay.kind == overlayAuth {
		m.closeOverlay()
		return
	}
	if m.overlay.requestID != "" {
		m.closeOverlay()
	}
}

// openAuthOverlay shows an authorization URL or a device code. When the user
// started from a settings panel, dismissing returns there.
func (m *Model) openAuthOverlay(providerID, rawURL, code, instructions string) {
	title := "Sign in to " + m.providerLabel(providerID)
	if m.overlay != nil && m.overlay.kind == overlayAuth {
		m.overlay.title = title
		m.overlay.authProvider = providerID
		m.overlay.authURL = rawURL
		m.overlay.authCode = code
		m.overlay.message = instructions
		return
	}
	var previous *overlay
	if m.overlay != nil && m.overlay.kind == overlaySettings {
		previous = m.overlay
	}
	step := &overlay{
		kind:         overlayAuth,
		action:       "auth",
		title:        title,
		message:      instructions,
		authProvider: providerID,
		authURL:      rawURL,
		authCode:     code,
		returnTo:     previous,
	}
	// A dialog must keep its request id, or the flow it belongs to waits
	// forever; show the sign-in step when it closes instead.
	if m.overlay != nil && m.overlay.requestID != "" {
		m.pendingAuthStep = step
		return
	}
	m.openOverlay(step)
}

// openAuthURL launches the URL from the auth overlay in the platform browser.
func (m *Model) openAuthURL() tea.Cmd {
	o := m.overlay
	if o == nil || o.authURL == "" {
		m.setToast("no sign-in URL to open")
		return nil
	}
	return openURLCmd(o.authURL)
}

// copyAuthValue copies the device code when there is one, else the URL.
func (m *Model) copyAuthValue() tea.Cmd {
	o := m.overlay
	if o == nil {
		return nil
	}
	value := o.authCode
	if value == "" {
		value = o.authURL
	}
	if value == "" {
		m.setToast("nothing to copy")
		return nil
	}
	if m.copyFn == nil {
		m.setToast("clipboard unavailable; press o to open the page")
		return nil
	}
	return m.copySelection(value)
}

// openURLMsg reports one attempt to launch the platform browser.
type openURLMsg struct {
	url string
	err error
}

// openURLCmd opens an http(s) URL outside the terminal. The browser is
// started, not waited for; a terminal that has no opener reports the error.
func openURLCmd(rawURL string) tea.Cmd {
	return func() tea.Msg {
		parsed, err := url.Parse(rawURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return openURLMsg{url: rawURL, err: errors.New("refusing to open a non-http URL")}
		}
		name, args := browserCommand(rawURL)
		command := exec.Command(name, args...)
		if err := command.Start(); err != nil {
			return openURLMsg{url: rawURL, err: err}
		}
		go func() { _ = command.Wait() }()
		return openURLMsg{url: rawURL}
	}
}

// browserCommand is the platform's default opener.
func browserCommand(rawURL string) (string, []string) {
	switch runtime.GOOS {
	case "darwin":
		return "open", []string{rawURL}
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler", rawURL}
	}
	if os.Getenv("WSL_DISTRO_NAME") != "" || os.Getenv("WSL_INTEROP") != "" {
		return "wslview", []string{rawURL}
	}
	return "xdg-open", []string{rawURL}
}

// displayHost shortens a URL to its host for toast text.
func displayHost(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return rawURL
	}
	return parsed.Host
}
