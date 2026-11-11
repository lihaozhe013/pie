package ui

import (
	"github.com/charmbracelet/glamour/ansi"
	glamourstyles "github.com/charmbracelet/glamour/styles"
	"github.com/charmbracelet/lipgloss"
)

// theme is the dark, low-noise palette of the client.
type theme struct {
	Base        lipgloss.Color
	Muted       lipgloss.Color
	Faint       lipgloss.Color
	Editor      lipgloss.Color
	Accent      lipgloss.Color
	AccentSoft  lipgloss.Color
	User        lipgloss.Color
	Assistant   lipgloss.Color
	Thinking    lipgloss.Color
	Tool        lipgloss.Color
	Success     lipgloss.Color
	Warn        lipgloss.Color
	Danger      lipgloss.Color
	DiffAdd     lipgloss.Color
	DiffDel     lipgloss.Color
	Border      lipgloss.Color
	Panel       lipgloss.Color
	Activity    lipgloss.Color
	ActivityDim lipgloss.Color
}

func defaultTheme() theme {
	return theme{
		Base:        lipgloss.Color("#E4E5E9"),
		Muted:       lipgloss.Color("#B7B7B7"),
		Faint:       lipgloss.Color("#A4A4A4"),
		Editor:      lipgloss.Color("#8A8B94"),
		Accent:      lipgloss.Color("#8BB9FA"),
		AccentSoft:  lipgloss.Color("#6F9AD6"),
		User:        lipgloss.Color("#9AD1FF"),
		Assistant:   lipgloss.Color("#D5D6DB"),
		Thinking:    lipgloss.Color("#B7B7B7"),
		Tool:        lipgloss.Color("#A9C7F0"),
		Success:     lipgloss.Color("#7EE787"),
		Warn:        lipgloss.Color("#E5A84B"),
		Danger:      lipgloss.Color("#FF7B72"),
		DiffAdd:     lipgloss.Color("#7EE787"),
		DiffDel:     lipgloss.Color("#FF7B72"),
		Border:      lipgloss.Color("#33343D"),
		Panel:       lipgloss.Color("#1C1D24"),
		Activity:    lipgloss.Color("#5AA9FF"),
		ActivityDim: lipgloss.Color("#2F5D8F"),
	}
}

// editorRuleBorder frames the composer with a top and bottom rule only, the
// way Claude Code draws its prompt: the text sits between two lines instead of
// inside a closed box.
var editorRuleBorder = lipgloss.Border{
	Top:    "─",
	Bottom: "─",
}

// styles holds prebuilt Lip Gloss styles.
type styles struct {
	theme theme

	header            lipgloss.Style
	headerKey         lipgloss.Style
	statusBar         lipgloss.Style
	activityMarker    lipgloss.Style
	activityMarkerDim lipgloss.Style
	activityLabel     lipgloss.Style
	activityMeta      lipgloss.Style

	userPrefix      lipgloss.Style
	userText        lipgloss.Style
	assistantPrefix lipgloss.Style
	toolLine        lipgloss.Style
	toolName        lipgloss.Style
	toolMeta        lipgloss.Style
	faint           lipgloss.Style
	thinkingHead    lipgloss.Style
	thinkingBody    lipgloss.Style
	notice          lipgloss.Style
	errorText       lipgloss.Style
	muted           lipgloss.Style
	accent          lipgloss.Style

	wordmarkP   lipgloss.Style
	wordmarkI   lipgloss.Style
	wordmarkE   lipgloss.Style
	splashTitle lipgloss.Style
	splashMuted lipgloss.Style
	splashLabel lipgloss.Style
	splashValue lipgloss.Style

	editorBox         lipgloss.Style
	editorHint        lipgloss.Style
	editorText        lipgloss.Style
	editorCursor      lipgloss.Style
	editorSelection   lipgloss.Style
	editorPlaceholder lipgloss.Style
	scrollRail        lipgloss.Style
	scrollThumb       lipgloss.Style
	completion        lipgloss.Style
	compActive        lipgloss.Style
	overlayBox        lipgloss.Style
	overlayHead       lipgloss.Style
	overlayHint       lipgloss.Style
	pickerItem        lipgloss.Style
	pickerSel         lipgloss.Style

	// settingsSel paints a whole selected row, including its padding, so the
	// cursor reads as one bar the way Claude Code's settings page does.
	settingsSel     lipgloss.Style
	settingsSection lipgloss.Style
	settingsTabOn   lipgloss.Style
	settingsTabOff  lipgloss.Style
	settingsRule    lipgloss.Style
	settingsPrompt  lipgloss.Style
	settingsOn      lipgloss.Style
	settingsOff     lipgloss.Style
	settingsChevron lipgloss.Style
	diffAdd           lipgloss.Style
	diffDel           lipgloss.Style
	diffMeta          lipgloss.Style
}

func newStyles() styles {
	t := defaultTheme()
	return styles{
		theme: t,

		header: lipgloss.NewStyle().
			Foreground(t.Accent).
			Bold(true),
		headerKey: lipgloss.NewStyle().Foreground(t.Muted),
		statusBar: lipgloss.NewStyle().Foreground(t.Muted),

		activityMarker:    lipgloss.NewStyle().Foreground(t.Activity).Bold(true),
		activityMarkerDim: lipgloss.NewStyle().Foreground(t.ActivityDim),
		activityLabel:     lipgloss.NewStyle().Foreground(t.Activity).Bold(true),
		activityMeta:      lipgloss.NewStyle().Foreground(t.Faint),

		userPrefix:      lipgloss.NewStyle().Foreground(t.User).Bold(true),
		userText:        lipgloss.NewStyle().Foreground(t.Base),
		assistantPrefix: lipgloss.NewStyle().Foreground(t.Accent).Bold(true),
		toolLine:        lipgloss.NewStyle().Foreground(t.Muted),
		toolName:        lipgloss.NewStyle().Foreground(t.Tool),
		toolMeta:        lipgloss.NewStyle().Foreground(t.Base),
		faint:           lipgloss.NewStyle().Foreground(t.Faint),
		thinkingHead:    lipgloss.NewStyle().Foreground(t.Thinking).Italic(true),
		thinkingBody:    lipgloss.NewStyle().Foreground(t.Thinking).Italic(true),
		notice:          lipgloss.NewStyle().Foreground(t.Muted),
		errorText:       lipgloss.NewStyle().Foreground(t.Danger),
		muted:           lipgloss.NewStyle().Foreground(t.Muted),
		accent:          lipgloss.NewStyle().Foreground(t.Accent),

		wordmarkP:   lipgloss.NewStyle().Foreground(t.Accent).Bold(true),
		wordmarkI:   lipgloss.NewStyle().Foreground(t.User).Bold(true),
		wordmarkE:   lipgloss.NewStyle().Foreground(t.AccentSoft).Bold(true),
		splashTitle: lipgloss.NewStyle().Foreground(t.Accent).Bold(true),
		splashMuted: lipgloss.NewStyle().Foreground(t.Muted),
		splashLabel: lipgloss.NewStyle().Foreground(t.Faint),
		splashValue: lipgloss.NewStyle().Foreground(t.Base),

		editorBox: lipgloss.NewStyle().
			Border(editorRuleBorder).
			BorderTop(true).
			BorderBottom(true).
			BorderLeft(false).
			BorderRight(false).
			BorderForeground(t.Base).
			Padding(0, 1),
		editorHint:        lipgloss.NewStyle().Foreground(t.Editor),
		editorText:        lipgloss.NewStyle().Foreground(t.Base),
		editorCursor:      lipgloss.NewStyle().Reverse(true),
		editorSelection:   lipgloss.NewStyle().Background(t.Accent).Foreground(t.Panel),
		editorPlaceholder: lipgloss.NewStyle().Foreground(t.Editor),
		scrollRail:        lipgloss.NewStyle().Foreground(t.Editor),
		scrollThumb:       lipgloss.NewStyle().Foreground(t.AccentSoft),
		completion: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(t.Border).
			Padding(0, 1),
		compActive: lipgloss.NewStyle().Foreground(t.Accent).Bold(true),
		overlayBox: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(t.AccentSoft).
			Padding(1, 2),
		overlayHead: lipgloss.NewStyle().Foreground(t.Accent).Bold(true),
		overlayHint: lipgloss.NewStyle().Foreground(t.Faint),
		pickerItem:  lipgloss.NewStyle().Foreground(t.Base),
		pickerSel: lipgloss.NewStyle().
			Foreground(t.Accent).
			Bold(true),
		settingsSel: lipgloss.NewStyle().
			Background(t.Accent).
			Foreground(t.Panel),
		settingsSection: lipgloss.NewStyle().
			Foreground(t.Faint).
			Bold(true),
		settingsTabOn: lipgloss.NewStyle().
			Foreground(t.Accent).
			Bold(true).
			Underline(true),
		settingsTabOff: lipgloss.NewStyle().Foreground(t.Muted),
		settingsRule:   lipgloss.NewStyle().Foreground(t.Border),
		settingsPrompt: lipgloss.NewStyle().
			Foreground(t.Accent).
			Bold(true),
		settingsOn:      lipgloss.NewStyle().Foreground(t.Success),
		settingsOff:     lipgloss.NewStyle().Foreground(t.Muted),
		settingsChevron: lipgloss.NewStyle().Foreground(t.Faint),
		diffAdd:  lipgloss.NewStyle().Foreground(t.DiffAdd),
		diffDel:  lipgloss.NewStyle().Foreground(t.DiffDel),
		diffMeta: lipgloss.NewStyle().Foreground(t.Faint),
	}
}

// markdownStyle derives a glamour style from the palette so code blocks and
// headings match the surrounding chrome.
func (s styles) markdownStyle() ansi.StyleConfig {
	style := glamourstyles.DarkStyleConfig

	style.Document.Margin = uintPtr(0)
	style.Document.BlockPrefix = ""
	style.Document.BlockSuffix = ""
	style.Document.Color = colorPtr(string(s.theme.Base))

	// Headings keep their "#" markers, like Codex's TUI, so copied text stays
	// valid Markdown. Levels are colour-coded, and H1 loses glamour's background
	// chip so it matches the rest of the palette.
	style.H1.Prefix = "# "
	style.H1.Suffix = ""
	style.H1.BackgroundColor = nil
	style.H1.Color = colorPtr(string(s.theme.Accent))
	style.H1.Bold = boolPtr(true)
	style.H2.Color = colorPtr(string(s.theme.AccentSoft))
	style.H2.Bold = boolPtr(true)
	style.H3.Color = colorPtr(string(s.theme.Base))
	style.H3.Bold = boolPtr(true)
	style.H4.Color = colorPtr(string(s.theme.Muted))
	style.H4.Bold = boolPtr(true)
	style.H5.Color = colorPtr(string(s.theme.Muted))
	style.H5.Bold = boolPtr(false)
	style.H5.Italic = boolPtr(true)
	style.H6.Color = colorPtr(string(s.theme.Muted))
	style.H6.Bold = boolPtr(false)
	style.H6.Italic = boolPtr(true)
	style.Heading.Color = colorPtr(string(s.theme.Accent))

	style.Emph.Color = colorPtr(string(s.theme.AccentSoft))
	style.Strong.Color = colorPtr(string(s.theme.Base))
	style.Strong.Bold = boolPtr(true)
	style.Link.Color = colorPtr(string(s.theme.User))
	style.LinkText.Color = colorPtr(string(s.theme.User))
	style.LinkText.Underline = boolPtr(true)
	style.HorizontalRule.Color = colorPtr(string(s.theme.Faint))

	style.Code.Color = colorPtr(string(s.theme.Base))
	style.Code.BackgroundColor = colorPtr(string(s.theme.Panel))

	style.CodeBlock.BackgroundColor = colorPtr(string(s.theme.Panel))
	style.CodeBlock.Color = colorPtr(string(s.theme.Base))
	style.CodeBlock.Margin = uintPtr(1)

	style.BlockQuote.Indent = uintPtr(1)
	style.BlockQuote.IndentToken = stringPtr("│ ")
	style.BlockQuote.Color = colorPtr(string(s.theme.Muted))

	style.List.LevelIndent = 2
	style.Item.Color = colorPtr(string(s.theme.AccentSoft))
	style.Enumeration.Color = colorPtr(string(s.theme.AccentSoft))

	style.Table.CenterSeparator = stringPtr("┼")
	style.Table.ColumnSeparator = stringPtr("│")
	style.Table.RowSeparator = stringPtr("─")
	style.Table.Color = colorPtr(string(s.theme.Base))

	return style
}

func colorPtr(value string) *string  { return &value }
func stringPtr(value string) *string { return &value }
func boolPtr(value bool) *bool       { return &value }
func uintPtr(value uint) *uint       { return &value }
