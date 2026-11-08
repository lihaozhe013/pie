// Package providerusage reads the normalized subscription-usage reports the
// bridge extension queries from provider endpoints. It owns the provider list
// and the wire shapes only; the terminal client renders them.
package providerusage

import (
	"encoding/json"
	"fmt"
)

// SupportedIDs are the providers whose plans expose a usage or balance
// endpoint. The list matches Pie's provider-usage surface and the bridge's
// USAGE_ENDPOINTS table.
var SupportedIDs = []string{
	"openai-codex",
	"deepseek",
	"openrouter",
	"moonshotai",
	"moonshotai-cn",
	"minimax",
	"minimax-cn",
	"vercel-ai-gateway",
	"opencode-go",
	"kimi-coding",
}

// Supported reports whether a provider has a usage endpoint.
func Supported(providerID string) bool {
	for _, id := range SupportedIDs {
		if id == providerID {
			return true
		}
	}
	return false
}

// Bucket is one rate-limit window or balance.
type Bucket struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	GroupLabel    string   `json:"groupLabel"`
	Used          *float64 `json:"used"`
	Remaining     *float64 `json:"remaining"`
	Limit         *float64 `json:"limit"`
	Unit          string   `json:"unit"`
	Currency      string   `json:"currency"`
	WindowMinutes int      `json:"windowMinutes"`
	ResetsAt      *int64   `json:"resetsAt"`
	Period        string   `json:"period"`
}

// Metric is a non-window value such as a balance or membership level.
type Metric struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Value    Scalar `json:"value"`
	Unit     string `json:"unit"`
	Currency string `json:"currency"`
}

// Scalar is a JSON number or string, the two shapes a usage metric value
// takes in the provider responses.
type Scalar struct {
	Number  float64
	Text    string
	Numeric bool
}

// UnmarshalJSON accepts a number or a string.
func (s *Scalar) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		return nil
	}
	if len(data) > 0 && data[0] == '"' {
		if err := json.Unmarshal(data, &s.Text); err != nil {
			return err
		}
		s.Numeric = false
		return nil
	}
	var number float64
	if err := json.Unmarshal(data, &number); err != nil {
		return err
	}
	s.Number = number
	s.Numeric = true
	return nil
}

// Report is one provider's normalized usage snapshot.
type Report struct {
	ProviderID   string   `json:"providerId"`
	ProviderName string   `json:"providerName"`
	CapturedAt   int64    `json:"capturedAt"`
	Buckets      []Bucket `json:"buckets"`
	Metrics      []Metric `json:"metrics"`
	Notes        []string `json:"notes"`
}

// Result is the bridge's reply for one query.
type Result struct {
	ProviderID string  `json:"providerId"`
	Status     string  `json:"status"`
	Report     *Report `json:"report"`
	Message    string  `json:"message"`
}

// Ready reports whether the result carries a report.
func (r *Result) Ready() bool {
	return r != nil && r.Status == "ready" && r.Report != nil
}

// ParseResult decodes a bridge usage reply.
func ParseResult(data []byte) (*Result, error) {
	var result Result
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("usage report: %w", err)
	}
	if result.Status == "" {
		return nil, fmt.Errorf("usage report: missing status")
	}
	return &result, nil
}
