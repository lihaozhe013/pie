package ui

import (
	"fmt"
	"strings"
)

// pieWordmark is the hand-drawn block logo shown by the welcome panel and the
// post-exit card. Each row stores the P, I, and E glyphs separately so the
// letters can carry their own shade of the theme accent.
var pieWordmark = [][3]string{
	{"██████╗ ", "██╗", "███████╗"},
	{"██╔══██╗", "██║", "██╔════╝"},
	{"██████╔╝", "██║", "█████╗  "},
	{"██╔═══╝ ", "██║", "██╔══╝  "},
	{"██║     ", "██║", "███████╗"},
	{"╚═╝     ", "╚═╝", "╚══════╝"},
}

// wordmarkColumns is the display width of one rendered wordmark row: 8 columns
// for P, 3 for I, 8 for E, and one space between the letters.
const wordmarkColumns = 8 + 1 + 3 + 1 + 8

// splashTitleText is the one-line wordmark used on very narrow terminals.
const splashTitleText = "PIE"

// renderWordmark colours and joins the three letters of every row.
func (m *Model) renderWordmark() []string {
	lines := make([]string, 0, len(pieWordmark))
	for _, row := range pieWordmark {
		lines = append(lines, m.styles.wordmarkP.Render(row[0])+" "+
			m.styles.wordmarkI.Render(row[1])+" "+
			m.styles.wordmarkE.Render(row[2]))
	}
	return lines
}

// dismissSplash hides the welcome panel once the user takes over. It is safe
// to call when the panel is already gone.
func (m *Model) dismissSplash() {
	m.splash = false
}

// splashTagline describes what the client is and which build is running.
func (m *Model) splashTagline() string {
	tagline := "terminal client for pi"
	if version := strings.TrimSpace(m.opts.Version); version != "" {
		tagline += " · " + version
	}
	return tagline
}

// splashGreeting welcomes a fresh session and greets a resumed one.
func (m *Model) splashGreeting() string {
	if strings.TrimSpace(m.state.SessionName) != "" || m.state.MessageCount > 0 {
		return "Welcome back"
	}
	return "Welcome to pie"
}

// splashModel names the active model and thinking level, when known.
func (m *Model) splashModel() string {
	parts := make([]string, 0, 2)
	if m.state.Model != nil {
		if label := strings.TrimSpace(m.state.Model.Label()); label != "" {
			parts = append(parts, label)
		}
	}
	if level := strings.TrimSpace(m.state.ThinkingLevel); level != "" {
		parts = append(parts, level)
	}
	return strings.Join(parts, " · ")
}

// splashMeta is the aligned information block: where the session runs, which
// model answers, and what the conversation is called.
func (m *Model) splashMeta() []string {
	const labelWidth = 8
	label := func(text string) string {
		return m.styles.splashLabel.Render(fmt.Sprintf("%-*s", labelWidth, text)) + "  "
	}

	lines := make([]string, 0, 3)
	if cwd := displayPath(m.opts.CWD); cwd != "" {
		lines = append(lines, label("cwd")+m.styles.splashValue.Render(cwd))
	}
	if model := m.splashModel(); model != "" {
		lines = append(lines, label("model")+m.styles.splashValue.Render(model))
	}
	if name := strings.TrimSpace(m.state.SessionName); name != "" {
		lines = append(lines, label("session")+m.styles.splashTitle.Render(name))
	}
	return lines
}

// splashHint is the single line of first-run guidance under the information
// block, with the command names picked out in the accent colour. Narrow
// terminals only keep the part that fits.
func (m *Model) splashHint(width int) string {
	muted := m.styles.splashMuted
	key := m.styles.accent
	switch {
	case width >= 66:
		return muted.Render("Type a prompt to start  ·  ") +
			key.Render("/help") + muted.Render(" commands  ·  ") +
			key.Render("/resume") + muted.Render(" sessions")
	case width >= 44:
		return muted.Render("Type a prompt to start  ·  ") +
			key.Render("/help") + muted.Render(" commands")
	case width >= 25:
		return muted.Render("Type a prompt to start")
	default:
		return muted.Render("type a prompt")
	}
}

// splashDismissLine is the closing hint on the welcome panel.
func (m *Model) splashDismissLine(width int) string {
	switch {
	case width >= 28:
		return m.styles.splashDismiss.Render("press any key to continue")
	case width >= 18:
		return m.styles.splashDismiss.Render("any key continues")
	default:
		return ""
	}
}

// alignSplashBlock pads every row of one section to the width of its longest
// row. Centering the rows then keeps their left edge, so the aligned labels of
// the information block stay aligned.
func alignSplashBlock(lines []string) []string {
	width := 0
	for _, line := range lines {
		if w := lipglossWidth(line); w > width {
			width = w
		}
	}
	aligned := make([]string, len(lines))
	for i, line := range lines {
		aligned[i] = line + strings.Repeat(" ", width-lipglossWidth(line))
	}
	return aligned
}

// splashSection assembles one layout candidate. spaced layouts separate the
// logo, tagline, greeting, information, hint, and dismiss line with blank rows;
// the compact fallback packs them together so a short terminal still gets the
// important lines.
func splashSection(logo []string, spaced bool, tagline, greeting string, meta []string, hint, dismiss string) []string {
	lines := append([]string{}, logo...)
	gap := func() {
		if spaced {
			lines = append(lines, "")
		}
	}

	gap()
	lines = append(lines, tagline)
	if greeting != "" {
		gap()
		lines = append(lines, greeting)
	}
	if len(meta) > 0 {
		gap()
		lines = append(lines, meta...)
	}
	if hint != "" {
		gap()
		lines = append(lines, hint)
	}
	if dismiss != "" {
		gap()
		lines = append(lines, dismiss)
	}
	return lines
}

// splashLines picks the richest layout that fits the transcript area.
func (m *Model) splashLines(width, height int) []string {
	logo := m.renderWordmark()
	if width < wordmarkColumns+4 || height < len(pieWordmark) {
		logo = []string{m.styles.splashTitle.Render(splashTitleText)}
	}

	taglineText := m.splashTagline()
	if width < 28 {
		taglineText = "pi client"
	}
	tagline := m.styles.splashMuted.Render(taglineText)
	greeting := m.styles.splashTitle.Render(m.splashGreeting())
	meta := m.splashMeta()
	if len(meta) > 0 {
		meta = alignSplashBlock(meta)
	}
	hint := m.splashHint(width)
	dismiss := m.splashDismissLine(width)

	firstMeta := meta
	if len(firstMeta) > 1 {
		firstMeta = firstMeta[:1]
	}

	candidates := [][]string{
		splashSection(logo, true, tagline, greeting, meta, hint, dismiss),
		splashSection(logo, true, tagline, greeting, meta, hint, ""),
		splashSection(logo, true, tagline, "", meta, hint, ""),
		splashSection(logo, true, tagline, "", firstMeta, hint, ""),
		splashSection(logo, true, tagline, "", nil, hint, ""),
		splashSection(logo, false, tagline, "", nil, hint, ""),
		splashSection(logo, false, tagline, "", nil, "", ""),
		logo,
	}
	for _, candidate := range candidates {
		if len(candidate) <= height {
			return candidate
		}
	}
	return logo
}

// splashBody renders the welcome panel in the transcript area.
func (m *Model) splashBody() []string {
	width, height := m.frameWidth(), m.body
	if width < 1 {
		width = 1
	}
	if height < 1 {
		return nil
	}

	content := m.splashLines(width, height)
	lines := make([]string, 0, height)
	top := (height - len(content)) / 2
	if top < 0 {
		top = 0
	}
	for i := 0; i < top; i++ {
		lines = append(lines, "")
	}
	for _, line := range content {
		if len(lines) >= height {
			break
		}
		lines = append(lines, centerSplashLine(line, width))
	}
	for len(lines) < height {
		lines = append(lines, "")
	}
	return lines
}

// centerSplashLine truncates a styled row and centers it in the content
// column.
func centerSplashLine(line string, width int) string {
	line = truncateLine(line, width)
	padding := (width - lipglossWidth(line)) / 2
	if padding <= 0 {
		return line
	}
	return strings.Repeat(" ", padding) + line
}

// ExitSummary renders the card printed after the alternate screen closes. It
// repeats the wordmark so the terminal keeps a record of the session and names
// the conversation that can be resumed.
func (m *Model) ExitSummary() string {
	var lines []string
	if m.width > 0 && m.width < wordmarkColumns+2 {
		lines = []string{m.styles.splashTitle.Render(splashTitleText)}
	} else {
		lines = m.renderWordmark()
	}
	lines = append(lines, "", m.styles.splashMuted.Render(m.splashTagline()), "")

	ephemeral := strings.TrimSpace(m.state.SessionFile) == ""
	fatal := m.fatal != ""
	name := strings.TrimSpace(m.state.SessionName)
	switch {
	case name != "":
		lines = append(lines, m.exitField("Session", m.styles.splashTitle.Render(name)))
	case ephemeral && !fatal:
		lines = append(lines, m.exitField("Session", m.styles.splashMuted.Render("ephemeral session")))
	case fatal:
		lines = append(lines, m.exitField("Session", m.styles.splashMuted.Render("unavailable")))
	default:
		lines = append(lines, m.exitField("Session", m.styles.splashMuted.Render("untitled session")))
	}
	if cwd := displayPath(m.opts.CWD); cwd != "" {
		lines = append(lines, m.exitField("Directory", m.styles.splashValue.Render(cwd)))
	}
	if model := m.splashModel(); model != "" {
		lines = append(lines, m.exitField("Model", m.styles.splashValue.Render(model)))
	}
	if fatal {
		lines = append(lines, "", m.exitField("Error", m.styles.errorText.Render(m.fatal)))
	}
	switch {
	case ephemeral && !fatal:
		lines = append(lines, "", m.styles.splashMuted.Render("Nothing was saved for this session."))
	case !ephemeral:
		lines = append(lines, "", m.exitField("Resume",
			m.styles.splashValue.Render("pie --session "+displayPath(m.state.SessionFile))))
	}

	for i, line := range lines {
		if line != "" {
			lines[i] = "  " + line
		}
	}
	return strings.Join(lines, "\n")
}

// exitField aligns one label and value pair in the post-exit card.
func (m *Model) exitField(label, value string) string {
	return m.styles.splashLabel.Render(fmt.Sprintf("%-9s", label)) + "  " + value
}
