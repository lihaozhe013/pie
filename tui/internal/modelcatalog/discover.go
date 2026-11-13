package modelcatalog

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lihaozhe013/pie/tui/internal/config"
)

// DiscoveredModel is one model returned by a provider's model list endpoint.
type DiscoveredModel struct {
	ID               string
	Name             string
	Reasoning        bool
	ThinkingLevelMap map[string]*string
	ContextWindow    int
	MaxTokens        int
}

// ToConfigValue converts a discovered model into a Value suitable for models.json.
func (d DiscoveredModel) ToConfigValue() *config.Value {
	val := config.NewObject()
	val.SetString("id", d.ID)
	if d.Name != "" && d.Name != d.ID {
		val.SetString("name", d.Name)
	}
	if d.Reasoning {
		val.SetBool("reasoning", true)
	}
	if len(d.ThinkingLevelMap) > 0 {
		levelsObj := config.NewObject()
		for lvl, mapped := range d.ThinkingLevelMap {
			if mapped == nil {
				levelsObj.Set(lvl, config.NewNull())
			} else {
				levelsObj.SetString(lvl, *mapped)
			}
		}
		val.Set("thinkingLevelMap", levelsObj)
	}
	if d.ContextWindow > 0 {
		val.SetNumber("contextWindow", float64(d.ContextWindow))
	}
	if d.MaxTokens > 0 {
		val.SetNumber("maxTokens", float64(d.MaxTokens))
	}
	return val
}

// DiscoveryConfig holds the endpoint parameters to discover models for a provider.
type DiscoveryConfig struct {
	ProviderID string
	BaseURL    string
	API        string
	APIKey     string
	Headers    map[string]string
}

var envVarPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

// ResolveAPIKey resolves a provider's effective API key from literal strings,
// $ENV_VAR references, !shell commands, auth.json, or environment variables.
func ResolveAPIKey(providerID, rawKey string, paths config.Paths) string {
	rawKey = strings.TrimSpace(rawKey)
	if rawKey != "" {
		if strings.HasPrefix(rawKey, "$") {
			return strings.TrimSpace(os.Getenv(rawKey[1:]))
		}
		if strings.HasPrefix(rawKey, "!") {
			cmdStr := strings.TrimSpace(rawKey[1:])
			if cmdStr != "" {
				var cmd *exec.Cmd
				if runtime.GOOS == "windows" {
					cmd = exec.Command("cmd", "/c", cmdStr)
				} else {
					cmd = exec.Command("sh", "-c", cmdStr)
				}
				if out, err := cmd.Output(); err == nil {
					return strings.TrimSpace(string(out))
				}
			}
			return ""
		}
		if envVarPattern.MatchString(rawKey) {
			if envVal := os.Getenv(rawKey); envVal != "" {
				return envVal
			}
		}
		return rawKey
	}

	if auth, err := config.LoadAuth(paths); err == nil && auth != nil {
		if cred := auth.Credential(providerID); cred != nil && cred.IsObject() {
			if k, ok := cred.Get("key").AsString(); ok && strings.TrimSpace(k) != "" {
				return strings.TrimSpace(k)
			}
			if token, ok := cred.Get("access_token").AsString(); ok && strings.TrimSpace(token) != "" {
				return strings.TrimSpace(token)
			}
		}
	}

	envName := strings.ToUpper(strings.ReplaceAll(providerID, "-", "_")) + "_API_KEY"
	if envVal := os.Getenv(envName); envVal != "" {
		return strings.TrimSpace(envVal)
	}

	return ""
}

var versionRegex = regexp.MustCompile(`(?i)/v\d+(?:beta)?$`)

// BuildModelsListURL constructs the protocol-correct model list URL from a base URL and API type,
// matching the behavior of pie's web UI model discovery.
func BuildModelsListURL(baseURL, api string) (*url.URL, error) {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return nil, fmt.Errorf("base URL is required")
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("invalid base URL: %w", err)
	}

	trimmedPath := strings.TrimRight(u.Path, "/")
	lowerPath := strings.ToLower(trimmedPath)

	if !strings.HasSuffix(lowerPath, "/models") {
		path := trimmedPath
		if api == "anthropic-messages" && !versionRegex.MatchString(path) {
			path += "/v1"
		}
		if api == "google-generative-ai" && !versionRegex.MatchString(path) {
			path += "/v1beta"
		}
		u.Path = strings.ReplaceAll(path+"/models", "//", "/")
	}

	q := u.Query()
	if api == "anthropic-messages" && !q.Has("limit") {
		q.Set("limit", "1000")
		u.RawQuery = q.Encode()
	}
	if api == "google-generative-ai" && !q.Has("pageSize") {
		q.Set("pageSize", "1000")
		u.RawQuery = q.Encode()
	}

	return u, nil
}

// BuildHeaders constructs the HTTP request headers for model discovery.
func BuildHeaders(api, apiKey string, configured map[string]string) http.Header {
	headers := make(http.Header)
	for k, v := range configured {
		v = strings.TrimSpace(v)
		if strings.HasPrefix(v, "$") {
			v = strings.TrimSpace(os.Getenv(v[1:]))
		}
		headers.Set(k, v)
	}
	if headers.Get("Accept") == "" {
		headers.Set("Accept", "application/json")
	}
	if apiKey == "" {
		return headers
	}
	switch api {
	case "anthropic-messages":
		if headers.Get("x-api-key") == "" {
			headers.Set("x-api-key", apiKey)
		}
		if headers.Get("anthropic-version") == "" {
			headers.Set("anthropic-version", "2023-06-01")
		}
	case "google-generative-ai":
		if headers.Get("x-goog-api-key") == "" {
			headers.Set("x-goog-api-key", apiKey)
		}
	default:
		if headers.Get("Authorization") == "" {
			headers.Set("Authorization", "Bearer "+apiKey)
		}
	}
	return headers
}

// DiscoverModels queries a provider endpoint and parses available models.
func DiscoverModels(ctx context.Context, cfg DiscoveryConfig, paths config.Paths) ([]DiscoveredModel, error) {
	baseURL := strings.TrimSpace(cfg.BaseURL)
	if baseURL == "" {
		return nil, fmt.Errorf("base URL is required")
	}
	api := cfg.API
	if api == "" {
		api = "openai-completions"
	}
	apiKey := ResolveAPIKey(cfg.ProviderID, cfg.APIKey, paths)

	endpoint, err := BuildModelsListURL(baseURL, api)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header = BuildHeaders(api, apiKey, cfg.Headers)

	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch models: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := strings.TrimSpace(string(bodyBytes))
		if len(msg) > 300 {
			msg = msg[:300] + "…"
		}
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("upstream error (%d): %s", resp.StatusCode, msg)
	}

	return ParseDiscoveredModels(bodyBytes)
}

func cleanString(v any) string {
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func firstPositiveInt(m map[string]any, fields []string) int {
	for _, f := range fields {
		val, exists := m[f]
		if !exists {
			continue
		}
		switch v := val.(type) {
		case float64:
			if v > 0 && v == float64(int(v)) {
				return int(v)
			}
		case int:
			if v > 0 {
				return v
			}
		case string:
			if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 {
				return n
			}
		}
	}
	return 0
}

func thinkingLevelMapFromEfforts(m map[string]any) map[string]*string {
	var list []string
	for _, f := range []string{"supported_efforts", "supportedEfforts"} {
		if rawList, ok := m[f].([]any); ok {
			for _, item := range rawList {
				if s, ok := item.(string); ok && s != "" {
					list = append(list, s)
				}
			}
			break
		}
	}
	if len(list) == 0 {
		return nil
	}
	advertised := make(map[string]bool, len(list))
	for _, s := range list {
		advertised[s] = true
	}
	hasKnown := false
	for _, l := range config.ThinkingLevels {
		if advertised[l] {
			hasKnown = true
			break
		}
	}
	if !hasKnown {
		return nil
	}

	levelMap := make(map[string]*string)
	for _, l := range config.ThinkingLevels {
		if !advertised[l] {
			levelMap[l] = nil
		} else if l == "xhigh" || l == "max" {
			val := l
			levelMap[l] = &val
		}
	}
	return levelMap
}

func modelFromValue(item any) *DiscoveredModel {
	if str, ok := item.(string); ok {
		id := strings.TrimSpace(str)
		if id != "" {
			return &DiscoveredModel{ID: id}
		}
		return nil
	}
	m, ok := item.(map[string]any)
	if !ok {
		return nil
	}

	rawID := cleanString(m["id"])
	if rawID == "" {
		rawID = cleanString(m["model"])
	}
	if rawID == "" {
		rawID = cleanString(m["name"])
	}
	if rawID == "" {
		return nil
	}
	id := strings.TrimPrefix(rawID, "models/")
	if id == "" {
		return nil
	}

	displayName := cleanString(m["display_name"])
	if displayName == "" {
		displayName = cleanString(m["displayName"])
	}
	if displayName == "" && (cleanString(m["id"]) != "" || cleanString(m["model"]) != "") {
		displayName = cleanString(m["name"])
	}

	var name string
	if displayName != "" && displayName != id {
		name = displayName
	}

	discovered := &DiscoveredModel{
		ID:   id,
		Name: name,
	}

	for _, f := range []string{"supports_reasoning", "supportsReasoning", "reasoning", "thinking"} {
		if b, ok := m[f].(bool); ok && b {
			discovered.Reasoning = true
			break
		}
	}

	if discovered.Reasoning {
		discovered.ThinkingLevelMap = thinkingLevelMapFromEfforts(m)
	}

	discovered.ContextWindow = firstPositiveInt(m, []string{
		"context_length",
		"contextLength",
		"context_window",
		"contextWindow",
		"max_model_len",
		"max_input_tokens",
		"inputTokenLimit",
	})

	discovered.MaxTokens = firstPositiveInt(m, []string{
		"max_output_tokens",
		"maxOutputTokens",
		"max_completion_tokens",
		"outputTokenLimit",
	})

	return discovered
}

func listFromResponse(val any) []any {
	if arr, ok := val.([]any); ok {
		return arr
	}
	m, ok := val.(map[string]any)
	if !ok {
		return nil
	}
	for _, k := range []string{"data", "models", "results", "items"} {
		if candidate, exists := m[k]; exists {
			if arr, ok := candidate.([]any); ok {
				return arr
			}
			if objMap, ok := candidate.(map[string]any); ok {
				out := make([]any, 0, len(objMap))
				for _, v := range objMap {
					out = append(out, v)
				}
				return out
			}
		}
	}
	return nil
}

// ParseDiscoveredModels parses a JSON response from a provider's model list endpoint.
func ParseDiscoveredModels(data []byte) ([]DiscoveredModel, error) {
	var payload any
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, fmt.Errorf("invalid JSON response: %w", err)
	}

	items := listFromResponse(payload)
	seen := make(map[string]bool)
	var models []DiscoveredModel
	for _, item := range items {
		m := modelFromValue(item)
		if m == nil || m.ID == "" || seen[m.ID] {
			continue
		}
		seen[m.ID] = true
		models = append(models, *m)
	}

	sort.Slice(models, func(i, j int) bool {
		nameI := models[i].Name
		if nameI == "" {
			nameI = models[i].ID
		}
		nameJ := models[j].Name
		if nameJ == "" {
			nameJ = models[j].ID
		}
		return strings.ToLower(nameI) < strings.ToLower(nameJ)
	})

	return models, nil
}
