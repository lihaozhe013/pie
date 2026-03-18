package ui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// lipglossWidth is the display width of a possibly styled string.
func lipglossWidth(s string) int { return lipgloss.Width(s) }

// lipglossHeight is the line count of a possibly styled string.
func lipglossHeight(s string) int { return lipgloss.Height(s) }

// truncateLine clips a styled string to width, adding an ellipsis.
func truncateLine(s string, width int) string {
	if width <= 0 {
		return ""
	}
	return ansi.Truncate(s, width, "…")
}

// shortenPath replaces the home directory with ~ and elides deep paths.
func displayPath(path string) string {
	if path == "" {
		return ""
	}
	path = filepath.Clean(path)
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return path
	}
	home = filepath.Clean(home)
	switch {
	case path == home:
		return "~"
	case strings.HasPrefix(path, home+string(filepath.Separator)):
		return "~" + strings.TrimPrefix(path, home)
	default:
		return path
	}
}

// shortenPath additionally elides deep paths so they fit pickers and status
// lines.
func shortenPath(path string) string {
	if path == "" {
		return "unknown directory"
	}
	short := displayPath(path)
	parts := strings.Split(short, string(filepath.Separator))
	if len(parts) > 4 {
		short = "…/" + strings.Join(parts[len(parts)-3:], "/")
	}
	return short
}

// humanTime renders a coarse relative timestamp.
func humanTime(t time.Time) string {
	if t.IsZero() {
		return "unknown time"
	}
	delta := time.Since(t)
	switch {
	case delta < time.Minute:
		return "just now"
	case delta < time.Hour:
		return fmt.Sprintf("%dm ago", int(delta.Minutes()))
	case delta < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(delta.Hours()))
	case delta < 30*24*time.Hour:
		return fmt.Sprintf("%dd ago", int(delta.Hours()/24))
	default:
		return t.Format("2006-01-02")
	}
}

// formatTokens abbreviates a token count.
func formatTokens(count int) string {
	switch {
	case count <= 0:
		return "0"
	case count >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(count)/1_000_000)
	case count >= 1_000:
		return fmt.Sprintf("%.1fk", float64(count)/1_000)
	default:
		return fmt.Sprintf("%d", count)
	}
}
