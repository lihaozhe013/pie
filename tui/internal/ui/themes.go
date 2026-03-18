package ui

import "github.com/charmbracelet/lipgloss"

// themeOption is one entry of the theme picker. The ids and order match pie's
// web UI so the two clients use the same names.
type themeOption struct {
	ID     string
	Label  string
	Scheme string // "light", "dark", or "" for auto
}

var themeOptions = []themeOption{
	{ID: "auto", Label: "System"},
	{ID: "light", Label: "Light", Scheme: "light"},
	{ID: "mist", Label: "Mist", Scheme: "light"},
	{ID: "lilac", Label: "Lilac", Scheme: "light"},
	{ID: "sand", Label: "Sand", Scheme: "light"},
	{ID: "rose", Label: "Rose", Scheme: "light"},
	{ID: "dark", Label: "Dark", Scheme: "dark"},
	{ID: "pine", Label: "Pine", Scheme: "dark"},
	{ID: "dusk", Label: "Dusk", Scheme: "dark"},
	{ID: "ember", Label: "Ember", Scheme: "dark"},
	{ID: "slate", Label: "Slate", Scheme: "dark"},
	{ID: "contrast-light", Label: "Contrast Light", Scheme: "light"},
	{ID: "contrast-dark", Label: "Contrast Dark", Scheme: "dark"},
	{ID: "zenburn", Label: "Zenburn", Scheme: "dark"},
	{ID: "catppuccin-latte", Label: "Catppuccin Latte", Scheme: "light"},
	{ID: "catppuccin-frappe", Label: "Catppuccin Frappe", Scheme: "dark"},
	{ID: "catppuccin-macchiato", Label: "Catppuccin Macchiato", Scheme: "dark"},
	{ID: "catppuccin-mocha", Label: "Catppuccin Mocha", Scheme: "dark"},
}

// palette is the subset of pie's CSS theme variables the terminal uses. The
// web values come from styles/globals.css and styles/catppuccin.css.
type palette struct {
	Text        string
	Muted       string
	Dim         string
	Accent      string
	AccentHover string
	Border      string
	Panel       string
	Dark        bool
}

var themePalettes = map[string]palette{
	"light":                {Text: "#1a1a1a", Muted: "#515c6b", Dim: "#5e6673", Accent: "#245bce", AccentHover: "#1d4ed8", Border: "#e0e0e0", Panel: "#f5f5f5"},
	"mist":                 {Text: "#202e2b", Muted: "#455f56", Dim: "#52685f", Accent: "#1e6559", AccentHover: "#174f46", Border: "#afc4ba", Panel: "#e9f0ee"},
	"lilac":                {Text: "#2b2635", Muted: "#574d68", Dim: "#625873", Accent: "#6a43a8", AccentHover: "#56348c", Border: "#c4b8d8", Panel: "#efebf6"},
	"sand":                 {Text: "#2e2a22", Muted: "#5c5243", Dim: "#665b4b", Accent: "#7a4f10", AccentHover: "#613f0b", Border: "#cdbfa6", Panel: "#f1ebdf"},
	"rose":                 {Text: "#34282e", Muted: "#65505a", Dim: "#705b65", Accent: "#914360", AccentHover: "#76324d", Border: "#cdb5bf", Panel: "#f3edef"},
	"dark":                 {Text: "#e8e8e8", Muted: "#b7b7b7", Dim: "#a4a4a4", Accent: "#a4c2f4", AccentHover: "#c3d8fa", Border: "#454545", Panel: "#242424", Dark: true},
	"pine":                 {Text: "#e6ede8", Muted: "#c3d0c6", Dim: "#afc2b5", Accent: "#acccb7", AccentHover: "#d0e2d3", Border: "#4a5f52", Panel: "#212b28", Dark: true},
	"dusk":                 {Text: "#ebe6f0", Muted: "#c9c0d4", Dim: "#b5abc3", Accent: "#cdb4f0", AccentHover: "#e0d0f7", Border: "#54496a", Panel: "#26212e", Dark: true},
	"ember":                {Text: "#ede4da", Muted: "#cfc0b0", Dim: "#bba996", Accent: "#e8b27a", AccentHover: "#f2cba0", Border: "#5a4a3d", Panel: "#28211c", Dark: true},
	"slate":                {Text: "#e3e8f2", Muted: "#bcc5d6", Dim: "#a7b1c5", Accent: "#8ccfe0", AccentHover: "#b3e2ec", Border: "#435069", Panel: "#1d2331", Dark: true},
	"contrast-light":       {Text: "#000000", Muted: "#1f1f1f", Dim: "#2e2e2e", Accent: "#0034a0", AccentHover: "#002678", Border: "#5c5c5c", Panel: "#f3f3f3"},
	"contrast-dark":        {Text: "#ffffff", Muted: "#ebebeb", Dim: "#d6d6d6", Accent: "#ffd60a", AccentHover: "#ffe566", Border: "#a3a3a3", Panel: "#0f0f0f", Dark: true},
	"zenburn":              {Text: "#dcdccc", Muted: "#cfcfbf", Dim: "#c6c6b6", Accent: "#f0dfaf", AccentHover: "#f8eccb", Border: "#6f6f6f", Panel: "#383838", Dark: true},
	"catppuccin-latte":     {Text: "#4c4f69", Muted: "#5c5f77", Dim: "#5c5f77", Accent: "#7c2de0", AccentHover: "#6c21c6", Border: "#9ca0b0", Panel: "#e6e9ef"},
	"catppuccin-frappe":    {Text: "#c6d0f5", Muted: "#b5bfe2", Dim: "#a5adce", Accent: "#ca9ee6", AccentHover: "#babbf1", Border: "#626880", Panel: "#292c3c", Dark: true},
	"catppuccin-macchiato": {Text: "#cad3f5", Muted: "#b8c0e0", Dim: "#a5adcb", Accent: "#c6a0f6", AccentHover: "#b7bdf8", Border: "#5b6078", Panel: "#1e2030", Dark: true},
	"catppuccin-mocha":     {Text: "#cdd6f4", Muted: "#bac2de", Dim: "#a6adc8", Accent: "#cba6f7", AccentHover: "#b4befe", Border: "#585b70", Panel: "#181825", Dark: true},
}

// ThemeLabel returns the picker label for a theme id.
func ThemeLabel(id string) string {
	for _, option := range themeOptions {
		if option.ID == id {
			return option.Label
		}
	}
	return "System"
}

// themeFor resolves a saved theme id to a palette. "auto" keeps the adaptive
// default, which follows the terminal background.
func themeFor(id string) theme {
	base := defaultTheme()
	if id == "" || id == "auto" {
		return base
	}
	pal, ok := themePalettes[id]
	if !ok {
		return base
	}
	fixed := func(color string) lipgloss.AdaptiveColor {
		return lipgloss.AdaptiveColor{Light: color, Dark: color}
	}
	base.Base = fixed(pal.Text)
	base.Muted = fixed(pal.Muted)
	base.Faint = fixed(pal.Dim)
	base.Editor = fixed(pal.Dim)
	base.Accent = fixed(pal.Accent)
	base.AccentSoft = fixed(pal.AccentHover)
	base.User = fixed(pal.Accent)
	base.Assistant = fixed(pal.Text)
	base.Thinking = fixed(pal.Dim)
	base.Tool = fixed(pal.Accent)
	base.Border = fixed(pal.Border)
	base.Panel = fixed(pal.Panel)
	base.Activity = fixed(pal.Accent)
	base.ActivityDim = fixed(pal.Dim)
	// Semantic colors have no web palette counterpart; pick the variant that
	// matches the theme's contrast instead of the terminal background.
	base.Success = pickScheme(base.Success, pal.Dark)
	base.Warn = pickScheme(base.Warn, pal.Dark)
	base.Danger = pickScheme(base.Danger, pal.Dark)
	base.DiffAdd = pickScheme(base.DiffAdd, pal.Dark)
	base.DiffDel = pickScheme(base.DiffDel, pal.Dark)
	return base
}

func pickScheme(color lipgloss.AdaptiveColor, dark bool) lipgloss.AdaptiveColor {
	if dark {
		return lipgloss.AdaptiveColor{Light: color.Dark, Dark: color.Dark}
	}
	return lipgloss.AdaptiveColor{Light: color.Light, Dark: color.Light}
}
