package ui

import (
	"fmt"
	"strings"
)

// pieWordmark is the hand-drawn block logo shown by the startup card and the
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
func renderWordmark(st styles) []string {
	lines := make([]string, 0, len(pieWordmark))
	for _, row := range pieWordmark {
		lines = append(lines, st.wordmarkP.Render(row[0])+" "+
			st.wordmarkI.Render(row[1])+" "+
			st.wordmarkE.Render(row[2]))
	}
	return lines
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

// welcomeCard is the plain content of the startup card. The block stores the
// facts instead of pre-rendered rows so the card follows the frame width and
// the transcript height, and a theme change recolours it like any other block.
type welcomeCard struct {
	Tagline  string
	Greeting string
	CWD      string
	Model    string
	Session  string
}

// welcomeBlock snapshots the session facts the startup card shows.
func (m *Model) welcomeBlock() *block {
	return &block{
		kind:     blockWelcome,
		revision: 1,
		welcome: &welcomeCard{
			Tagline:  m.splashTagline(),
			Greeting: m.splashGreeting(),
			CWD:      displayPath(m.opts.CWD),
			Model:    m.splashModel(),
			Session:  strings.TrimSpace(m.state.SessionName),
		},
	}
}

// welcomeMeta is the aligned information block inside the startup card.
func welcomeMeta(st styles, card *welcomeCard) []string {
	const labelWidth = 8
	label := func(text string) string {
		return st.splashLabel.Render(fmt.Sprintf("%-*s", labelWidth, text)) + "  "
	}

	lines := make([]string, 0, 3)
	if card.CWD != "" {
		lines = append(lines, label("cwd")+st.splashValue.Render(card.CWD))
	}
	if card.Model != "" {
		lines = append(lines, label("model")+st.splashValue.Render(card.Model))
	}
	if card.Session != "" {
		lines = append(lines, label("session")+st.splashTitle.Render(card.Session))
	}
	return lines
}

// welcomeHint is the guidance line of the startup card, with the command names
// picked out in the accent colour. Narrow terminals only keep the part that
// fits.
func welcomeHint(st styles, width int) string {
	muted := st.splashMuted
	key := st.accent
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

// renderWelcome draws the startup card at the top of the transcript. The card
// is part of the conversation and left-aligned with it, so it scrolls out of
// the way as the session grows instead of covering the scrollback and vanishing
// on the first key press. Sections drop from the bottom up when the transcript
// is too short for the whole card.
func (t *transcript) renderWelcome(b *block, width int) string {
	card := b.welcome
	if card == nil {
		return ""
	}
	if width < 8 {
		width = 8
	}

	logo := renderWordmark(t.styles)
	if width < wordmarkColumns+2 || (t.height > 0 && t.height < len(pieWordmark)) {
		logo = []string{t.styles.splashTitle.Render(splashTitleText)}
	}

	lines := append([]string{}, logo...)
	sections := [][]string{
		{t.styles.splashMuted.Render(card.Tagline)},
		{t.styles.splashTitle.Render(card.Greeting)},
		welcomeMeta(t.styles, card),
		{welcomeHint(t.styles, width)},
	}
	for _, section := range sections {
		if len(section) == 0 {
			continue
		}
		if t.height > 0 && len(lines)+1+len(section) > t.height {
			break
		}
		lines = append(lines, "")
		lines = append(lines, section...)
	}

	for i, line := range lines {
		lines[i] = truncateLine(line, width)
	}
	return strings.Join(lines, "\n")
}

// ExitSummary renders the card printed after the alternate screen closes. It
// repeats the wordmark so the terminal keeps a record of the session and names
// the conversation that can be resumed.
func (m *Model) ExitSummary() string {
	var lines []string
	if m.width > 0 && m.width < wordmarkColumns+2 {
		lines = []string{m.styles.splashTitle.Render(splashTitleText)}
	} else {
		lines = renderWordmark(m.styles)
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
