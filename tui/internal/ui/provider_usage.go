package ui

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/providerusage"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

// usageSnapshot is the last usage reply for one provider, kept so a panel
// reopen does not spend another network request.
type usageSnapshot struct {
	report  *providerusage.Report
	err     string
	loading bool
}

// providerUsageMsg reports one bridge usage query.
type providerUsageMsg struct {
	providerID string
	result     *providerusage.Result
	err        error
}

// loadProviderUsage asks the bridge to query one provider's usage endpoint.
// The bridge owns credential resolution, including OAuth refreshes, because
// pi already knows how to turn each credential into request auth.
func (m *Model) loadProviderUsage(providerID string) tea.Cmd {
	if !providerusage.Supported(providerID) {
		m.setToast("usage is not available for this provider")
		return nil
	}
	if !m.bridgeReady {
		m.setToast("provider usage needs the bridge extension; restart pie")
		return nil
	}
	if m.busy {
		m.setToast("wait for the current turn before querying usage")
		return nil
	}
	if m.authFlow != "" {
		m.setToast("finish the running sign-in first")
		return nil
	}
	if m.providerUsage == nil {
		m.providerUsage = map[string]*usageSnapshot{}
	}
	state := m.providerUsage[providerID]
	if state == nil {
		state = &usageSnapshot{}
		m.providerUsage[providerID] = state
	}
	if state.loading {
		return nil
	}
	state.loading = true
	state.err = ""

	client := m.client
	return func() tea.Msg {
		dir, err := os.MkdirTemp("", "pie-usage-*")
		if err != nil {
			return providerUsageMsg{providerID: providerID, err: err}
		}
		defer func() { _ = os.RemoveAll(dir) }()
		path := filepath.Join(dir, "usage.json")

		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		if _, err := client.DoOK(ctx, rpc.Prompt("/pie-usage "+providerID+" "+path)); err != nil {
			return providerUsageMsg{providerID: providerID, err: err}
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return providerUsageMsg{providerID: providerID, err: err}
		}
		result, err := providerusage.ParseResult(data)
		return providerUsageMsg{providerID: providerID, result: result, err: err}
	}
}

// applyProviderUsage stores a reply and refreshes the panel that asked for it.
func (m *Model) applyProviderUsage(msg providerUsageMsg) {
	if m.providerUsage == nil {
		m.providerUsage = map[string]*usageSnapshot{}
	}
	state := m.providerUsage[msg.providerID]
	if state == nil {
		state = &usageSnapshot{}
		m.providerUsage[msg.providerID] = state
	}
	state.loading = false
	switch {
	case msg.err != nil:
		state.err = msg.err.Error()
	case msg.result == nil:
		state.err = "the provider returned no usage data"
	case msg.result.Ready():
		state.report = msg.result.Report
		state.err = ""
	default:
		state.err = msg.result.Message
		if state.err == "" {
			state.err = "usage query failed"
		}
	}
	if m.overlay != nil && m.overlay.action == "settings-panel" && m.panelUsageProvider == msg.providerID {
		m.openSettingsOverlay()
	}
}

// providerUsageSummary is the compact one-line state for a provider row.
func (m *Model) providerUsageSummary(providerID string) string {
	state := m.providerUsage[providerID]
	if state == nil {
		return "not queried"
	}
	switch {
	case state.loading:
		return "querying…"
	case state.report != nil:
		return summarizeUsage(state.report)
	case state.err != "":
		return "query failed"
	}
	return "not queried"
}

// summarizeUsage joins a few bucket values into one line.
func summarizeUsage(report *providerusage.Report) string {
	parts := make([]string, 0, 3)
	for _, bucket := range report.Buckets {
		text := compactUsageBucket(bucket)
		if text == "" {
			continue
		}
		parts = append(parts, text)
		if len(parts) == 2 {
			break
		}
	}
	if len(parts) == 0 {
		for _, metric := range report.Metrics {
			parts = append(parts, metric.Label+" "+formatUsageMetric(metric))
			if len(parts) == 2 {
				break
			}
		}
	}
	if len(parts) == 0 {
		return "no limits reported"
	}
	return strings.Join(parts, " · ")
}

func compactUsageBucket(bucket providerusage.Bucket) string {
	label := bucket.Label
	if label == "" {
		label = "Limit"
	}
	if strings.EqualFold(bucket.Period, "Unlimited") {
		return label + " unlimited"
	}
	switch bucket.Unit {
	case "percent":
		if bucket.Remaining != nil {
			return fmt.Sprintf("%s %.0f%%", label, *bucket.Remaining)
		}
	case "count":
		if bucket.Remaining != nil && bucket.Limit != nil {
			return fmt.Sprintf("%s %s/%s", label, formatUsageNumber(*bucket.Remaining), formatUsageNumber(*bucket.Limit))
		}
	case "currency":
		amount := bucket.Remaining
		if amount == nil {
			amount = bucket.Limit
		}
		if amount != nil {
			return label + " " + formatUsageAmount(*amount, bucket.Currency)
		}
	}
	if bucket.Period != "" {
		return label + " " + bucket.Period
	}
	return ""
}

// openProviderUsageList lists every provider that can answer a usage query.
func (m *Model) openProviderUsageList() {
	build := func(mm *Model) []settingsTab {
		rows := make([]settingsRow, 0, len(providerusage.SupportedIDs))
		for _, providerID := range providerusage.SupportedIDs {
			if mm.catalog != nil && mm.catalog.Provider(providerID) == nil {
				continue
			}
			providerID := providerID
			rows = append(rows, settingsRow{
				ID:      "usage-" + providerID,
				Label:   mm.providerLabel(providerID),
				Kind:    settingsAction,
				Current: func() string { return mm.providerUsageSummary(providerID) },
				Help:    "Subscription windows and balances reported by " + providerID + ".",
				Run: func(mm2 *Model, _ *settingsState) tea.Cmd {
					return mm2.openProviderUsagePanel(providerID)
				},
			})
		}
		if len(rows) == 0 {
			return nil
		}
		return []settingsTab{{ID: "panel", Label: "Usage limits", Rows: rows}}
	}
	state := m.pushProvidersPanel("Usage limits", build)
	m.showPage(state)
	m.panelUsageProvider = ""
}

// openProviderUsagePanel shows one provider's windows and balances. The first
// open queries automatically; later opens and refreshes reuse the snapshot.
func (m *Model) openProviderUsagePanel(providerID string) tea.Cmd {
	if !providerusage.Supported(providerID) {
		m.setToast("usage is not available for this provider")
		return nil
	}
	if m.providerUsage == nil {
		m.providerUsage = map[string]*usageSnapshot{}
	}
	state := m.providerUsage[providerID]
	shouldQuery := state == nil || (!state.loading && state.report == nil && state.err == "")
	var command tea.Cmd
	if shouldQuery {
		// Start the query before building rows so the panel opens in its
		// querying state instead of showing stale "not queried" text.
		command = m.loadProviderUsage(providerID)
	}

	build := func(mm *Model) []settingsTab {
		rows := []settingsRow{
			{
				ID:      "usage-provider",
				Label:   "Provider",
				Kind:    settingsInfo,
				Current: func() string { return providerID },
			},
			{
				ID:    "usage-updated",
				Label: "Updated",
				Kind:  settingsInfo,
				Current: func() string {
					st := mm.providerUsage[providerID]
					if st == nil {
						return "never"
					}
					if st.loading {
						return "querying…"
					}
					if st.report == nil {
						return "never"
					}
					return formatUsageTimestamp(st.report.CapturedAt)
				},
			},
			{
				ID:    "usage-refresh",
				Label: "Refresh usage",
				Kind:  settingsAction,
				Help:  "Queries the provider again; the report stays in memory.",
				Run: func(mm2 *Model, _ *settingsState) tea.Cmd {
					return mm2.loadProviderUsage(providerID)
				},
			},
		}

		if mm.providerUsageStatus(providerID) != "" {
			rows = append(rows, settingsRow{
				ID:      "usage-status",
				Label:   "Status",
				Kind:    settingsInfo,
				Current: func() string { return mm.providerUsageStatus(providerID) },
			})
		}
		st := mm.providerUsage[providerID]
		if st != nil && st.report != nil {
			for index, bucket := range st.report.Buckets {
				bucket := bucket
				rows = append(rows, settingsRow{
					ID:      "usage-bucket-" + strconv.Itoa(index),
					Label:   usageBucketLabel(bucket),
					Kind:    settingsInfo,
					Current: func() string { return formatUsageBucket(bucket) },
					Help:    usageBucketHelp(bucket),
				})
			}
			for index, metric := range st.report.Metrics {
				metric := metric
				rows = append(rows, settingsRow{
					ID:      "usage-metric-" + strconv.Itoa(index),
					Label:   metric.Label,
					Kind:    settingsInfo,
					Current: func() string { return formatUsageMetric(metric) },
				})
			}
			for index, note := range st.report.Notes {
				note := note
				rows = append(rows, settingsRow{
					ID:      "usage-note-" + strconv.Itoa(index),
					Label:   "Note",
					Kind:    settingsInfo,
					Current: func() string { return note },
				})
			}
		}
		return []settingsTab{{ID: "panel", Label: "Usage: " + mm.providerLabel(providerID), Rows: rows}}
	}

	if m.settingsPanel != nil && m.settingsPanel.usageProviderID == providerID && m.settingsPanel.build != nil {
		m.settingsPanel.rebuild(m)
		m.showPage(m.settingsPanel)
		return command
	}

	pState := m.pushProvidersPanel("Usage: "+m.providerLabel(providerID), build)
	pState.usageProviderID = providerID
	m.showPage(pState)
	return command
}

// providerUsageStatus is the panel's one-line query state. It is empty when
// there is a report with data to show.
func (m *Model) providerUsageStatus(providerID string) string {
	state := m.providerUsage[providerID]
	switch {
	case state == nil:
		return "not queried"
	case state.loading:
		return "querying the provider…"
	case state.err != "":
		return state.err
	case state.report == nil:
		return "not queried"
	case len(state.report.Buckets) == 0 && len(state.report.Metrics) == 0:
		return "no usage data"
	}
	return ""
}

func usageBucketLabel(bucket providerusage.Bucket) string {
	label := bucket.Label
	if label == "" {
		label = "Limit"
	}
	if bucket.GroupLabel != "" {
		return bucket.GroupLabel + " / " + label
	}
	return label
}

func usageBucketHelp(bucket providerusage.Bucket) string {
	parts := make([]string, 0, 3)
	if bucket.WindowMinutes > 0 {
		parts = append(parts, usageWindowLabel(bucket.WindowMinutes))
	}
	if bucket.Period != "" {
		parts = append(parts, "period: "+bucket.Period)
	}
	if bucket.ResetsAt != nil {
		parts = append(parts, "resets "+formatUsageTime(*bucket.ResetsAt))
	}
	return strings.Join(parts, " · ")
}

func usageWindowLabel(minutes int) string {
	switch {
	case minutes >= 10080:
		return "weekly window"
	case minutes >= 1440:
		return fmt.Sprintf("%d-day window", minutes/1440)
	case minutes >= 60:
		return fmt.Sprintf("%d-hour window", minutes/60)
	default:
		return fmt.Sprintf("%d-minute window", minutes)
	}
}

func formatUsageBucket(bucket providerusage.Bucket) string {
	if strings.EqualFold(bucket.Period, "Unlimited") {
		return "Unlimited"
	}
	switch bucket.Unit {
	case "percent":
		if bucket.Remaining != nil {
			text := fmt.Sprintf("%.0f%% left", *bucket.Remaining)
			if bucket.ResetsAt != nil {
				text += " · resets " + formatUsageTime(*bucket.ResetsAt)
			}
			return text
		}
	case "currency":
		amount := bucket.Remaining
		if amount == nil {
			amount = bucket.Limit
		}
		if amount != nil {
			text := formatUsageAmount(*amount, bucket.Currency) + " left"
			if bucket.ResetsAt != nil {
				text += " · resets " + formatUsageTime(*bucket.ResetsAt)
			}
			return text
		}
	case "count":
		if bucket.Remaining != nil && bucket.Limit != nil {
			text := formatUsageNumber(*bucket.Remaining) + " / " + formatUsageNumber(*bucket.Limit) + " left"
			if bucket.ResetsAt != nil {
				text += " · resets " + formatUsageTime(*bucket.ResetsAt)
			}
			return text
		}
	}
	if bucket.Period != "" {
		return bucket.Period
	}
	return "available"
}

func formatUsageMetric(metric providerusage.Metric) string {
	if metric.Unit == "currency" {
		if metric.Value.Numeric {
			return formatUsageAmount(metric.Value.Number, metric.Currency)
		}
		return usageCurrencyPrefix(metric.Currency) + metric.Value.Text
	}
	if metric.Value.Numeric {
		return formatUsageNumber(metric.Value.Number)
	}
	return metric.Value.Text
}

func formatUsageAmount(value float64, currency string) string {
	prefix := usageCurrencyPrefix(currency)
	if math.Trunc(value) == value {
		return fmt.Sprintf("%s%.0f", prefix, value)
	}
	return fmt.Sprintf("%s%.2f", prefix, value)
}

func usageCurrencyPrefix(currency string) string {
	switch currency {
	case "USD", "":
		return "$"
	case "CNY":
		return "CNY "
	default:
		return currency + " "
	}
}

func formatUsageNumber(value float64) string {
	if math.Trunc(value) == value {
		return strconv.FormatFloat(value, 'f', 0, 64)
	}
	return strconv.FormatFloat(value, 'f', 2, 64)
}

func formatUsageTime(seconds int64) string {
	return time.Unix(seconds, 0).Local().Format("Jan 2 15:04")
}

func formatUsageTimestamp(milliseconds int64) string {
	return time.UnixMilli(milliseconds).Local().Format("2006-01-02 15:04:05")
}
