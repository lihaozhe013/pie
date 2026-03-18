package ui

import (
	"bytes"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/formatters"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/charmbracelet/glamour/ansi"
	glamourstyles "github.com/charmbracelet/glamour/styles"
	"github.com/charmbracelet/lipgloss"
	xansi "github.com/charmbracelet/x/ansi"
	"github.com/muesli/termenv"
)

// A tool call is code the user has to read: a shell's command, an edit's
// replacement, a write's file. syntax.go gives that text the same token colours
// a Markdown fence already uses, so a tool card and the assistant's own code
// blocks agree. A call whose language is unknown stays plain: a guess that is
// wrong is worse than no colour.

// toolCodeLexer picks the syntax of everything a tool call shows. Shell tools
// are shell scripts; file tools are the file their arguments name; anything
// else is unknown.
func toolCodeLexer(toolName string, args map[string]any) chroma.Lexer {
	if isShellToolName(strings.ToLower(strings.TrimSpace(toolName))) {
		return shellLexer(shellCodeLanguage(toolName))
	}
	if path := toolArgPath(args); path != "" {
		return pathLexer(path)
	}
	return nil
}

// batchToolPattern mirrors Pie's web UI: the cmd family is batch, everything
// else among the shell tools is POSIX.
var batchToolPattern = regexp.MustCompile(`(^|[._-])(cmd|bat|batch)([._-]|$)`)

// shellCodeLanguage names the lexer a shell tool's command runs in.
func shellCodeLanguage(toolName string) string {
	lower := strings.ToLower(toolName)
	if strings.Contains(lower, "powershell") || strings.Contains(lower, "pwsh") {
		return "powershell"
	}
	if batchToolPattern.MatchString(lower) {
		return "batch"
	}
	return "bash"
}

func shellLexer(language string) chroma.Lexer {
	return cachedLexer("name:"+language, func() chroma.Lexer {
		return usableLexer(lexers.Get(language))
	})
}

func pathLexer(path string) chroma.Lexer {
	return cachedLexer("path:"+path, func() chroma.Lexer {
		return usableLexer(lexers.Match(path))
	})
}

// usableLexer drops the plaintext fallback. Colouring plain text would only
// replace the theme's own base colour with the code palette's for no gain.
func usableLexer(lexer chroma.Lexer) chroma.Lexer {
	if lexer == nil {
		return nil
	}
	if strings.EqualFold(lexer.Config().Name, "plaintext") {
		return nil
	}
	return lexer
}

// syntaxLexers caches lexer lookups. chroma's Match walks every registered
// file pattern, which is not something to repeat for each tool call.
var syntaxLexers sync.Map // key -> *syntaxLexerEntry

type syntaxLexerEntry struct{ lexer chroma.Lexer }

func cachedLexer(key string, resolve func() chroma.Lexer) chroma.Lexer {
	if cached, ok := syntaxLexers.Load(key); ok {
		return cached.(*syntaxLexerEntry).lexer
	}
	entry := &syntaxLexerEntry{lexer: resolve()}
	actual, _ := syntaxLexers.LoadOrStore(key, entry)
	return actual.(*syntaxLexerEntry).lexer
}

var (
	codePaletteOnce sync.Once
	codePalette     *chroma.Style
)

// codeStyle is chroma's view of the palette glamour hands its code fences.
// Building it from the glamour config keeps the two from drifting without
// touching chroma's global style registry.
func codeStyle() *chroma.Style {
	codePaletteOnce.Do(func() {
		config := glamourstyles.DarkStyleConfig.CodeBlock.Chroma
		if config == nil {
			codePalette = chroma.MustNewStyle("pie-tool", chroma.StyleEntries{
				chroma.Text: "#C4C4C4",
			})
			return
		}
		codePalette = chroma.MustNewStyle("pie-tool", chroma.StyleEntries{
			chroma.Text:                chromaEntry(config.Text),
			chroma.Error:               chromaEntry(config.Error),
			chroma.Comment:             chromaEntry(config.Comment),
			chroma.CommentPreproc:      chromaEntry(config.CommentPreproc),
			chroma.Keyword:             chromaEntry(config.Keyword),
			chroma.KeywordReserved:     chromaEntry(config.KeywordReserved),
			chroma.KeywordNamespace:    chromaEntry(config.KeywordNamespace),
			chroma.KeywordType:         chromaEntry(config.KeywordType),
			chroma.Operator:            chromaEntry(config.Operator),
			chroma.Punctuation:         chromaEntry(config.Punctuation),
			chroma.Name:                chromaEntry(config.Name),
			chroma.NameBuiltin:         chromaEntry(config.NameBuiltin),
			chroma.NameTag:             chromaEntry(config.NameTag),
			chroma.NameAttribute:       chromaEntry(config.NameAttribute),
			chroma.NameClass:           chromaEntry(config.NameClass),
			chroma.NameConstant:        chromaEntry(config.NameConstant),
			chroma.NameDecorator:       chromaEntry(config.NameDecorator),
			chroma.NameException:       chromaEntry(config.NameException),
			chroma.NameFunction:        chromaEntry(config.NameFunction),
			chroma.NameOther:           chromaEntry(config.NameOther),
			chroma.Literal:             chromaEntry(config.Literal),
			chroma.LiteralNumber:       chromaEntry(config.LiteralNumber),
			chroma.LiteralDate:         chromaEntry(config.LiteralDate),
			chroma.LiteralString:       chromaEntry(config.LiteralString),
			chroma.LiteralStringEscape: chromaEntry(config.LiteralStringEscape),
			chroma.GenericDeleted:      chromaEntry(config.GenericDeleted),
			chroma.GenericEmph:         chromaEntry(config.GenericEmph),
			chroma.GenericInserted:     chromaEntry(config.GenericInserted),
			chroma.GenericStrong:       chromaEntry(config.GenericStrong),
			chroma.GenericSubheading:   chromaEntry(config.GenericSubheading),
			chroma.Background:          chromaEntry(config.Background),
		})
	})
	return codePalette
}

// chromaEntry converts a glamour chroma setting to the entry string chroma
// parses, the way glamour's own code block renderer does.
func chromaEntry(style ansi.StylePrimitive) string {
	var parts []string
	if style.Color != nil {
		parts = append(parts, *style.Color)
	}
	if style.BackgroundColor != nil {
		parts = append(parts, "bg:"+*style.BackgroundColor)
	}
	if style.Italic != nil && *style.Italic {
		parts = append(parts, "italic")
	}
	if style.Bold != nil && *style.Bold {
		parts = append(parts, "bold")
	}
	if style.Underline != nil && *style.Underline {
		parts = append(parts, "underline")
	}
	return strings.Join(parts, " ")
}

// syntaxFormatter returns the terminal formatter matching the profile the rest
// of the UI renders in, and false when the terminal has no colour at all.
func syntaxFormatter() (chroma.Formatter, bool) {
	switch lipgloss.ColorProfile() {
	case termenv.Ascii:
		return nil, false
	case termenv.ANSI:
		return formatters.Get("terminal"), true
	case termenv.ANSI256:
		return formatters.Get("terminal256"), true
	default:
		return formatters.Get("terminal16m"), true
	}
}

// highlightLines renders src as one ANSI-coloured line per source line. Chroma's
// terminal formatters reset at every newline and resume formatting on the next
// one, so splitting the output on "\n" keeps every line self-contained. It
// returns nil when the terminal has no colour or the lexer cannot tokenize, and
// callers then keep their plain text.
func highlightLines(src string, lexer chroma.Lexer) []string {
	if lexer == nil || src == "" {
		return nil
	}
	formatter, ok := syntaxFormatter()
	if !ok {
		return nil
	}
	iterator, err := chroma.Coalesce(lexer).Tokenise(nil, src)
	if err != nil {
		return nil
	}
	var out bytes.Buffer
	if err := formatter.Format(&out, codeStyle(), iterator); err != nil {
		return nil
	}
	return strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
}

// styledDiffLines computes the line diff of every pair, caps it at limit rows
// across all pairs, and colours each surviving row with the file's syntax. The
// cap is applied before colouring so a huge write never tokenizes thousands of
// lines the transcript will not show.
func styledDiffLines(pairs []diffPair, lexer chroma.Lexer, limit int) ([]diffLine, bool) {
	var (
		out       []diffLine
		truncated bool
	)
	for _, pair := range pairs {
		lines := computeDiff(pair.Old, pair.New, 2)
		if limit > 0 && len(out)+len(lines) > limit {
			lines = lines[:limit-len(out)]
			truncated = true
		}
		colorDiffLines(lines, pair, lexer)
		out = append(out, lines...)
		if truncated {
			break
		}
	}
	return out, truncated
}

// colorDiffLines replaces each row's text with its syntax-coloured form. Each
// side is tokenized as a whole, not line by line, so a construct that spans
// lines keeps its colour. Only the prefix the rows actually use is highlighted,
// which keeps a capped write from tokenizing the rest of a large file.
func colorDiffLines(lines []diffLine, pair diffPair, lexer chroma.Lexer) {
	if lexer == nil || len(lines) == 0 {
		return
	}
	oldNeed, newNeed := 0, 0
	for _, line := range lines {
		if line.kind == '+' {
			newNeed = maxInt(newNeed, line.number)
		} else {
			oldNeed = maxInt(oldNeed, line.number)
		}
	}
	oldColored := highlightPrefix(splitLines(pair.Old), oldNeed, lexer)
	newColored := highlightPrefix(splitLines(pair.New), newNeed, lexer)
	paintDiffLines(lines, oldColored, newColored)
}

// highlightPrefix colours the first need lines of src and reports nothing when
// the formatter's line split does not line up with the source.
func highlightPrefix(src []string, need int, lexer chroma.Lexer) []string {
	if need <= 0 || need > len(src) {
		return nil
	}
	colored := highlightLines(strings.Join(src[:need], "\n"), lexer)
	if len(colored) != need {
		return nil
	}
	return colored
}

// paintDiffLines writes each side's coloured line onto its row. Context and
// removed rows carry an old-side line number, added rows a new-side one.
func paintDiffLines(lines []diffLine, oldColored, newColored []string) {
	for i := range lines {
		colored := oldColored
		if lines[i].kind == '+' {
			colored = newColored
		}
		index := lines[i].number - 1
		if index >= 0 && index < len(colored) {
			lines[i].text = colored[index]
		}
	}
}

// toolCommandLines is the highlighted logical lines of a shell tool's command.
// A command that cannot be coloured falls back to its plain lines.
func toolCommandLines(toolName string, args map[string]any) []string {
	command := activityArg(args, "command", "cmd")
	if command == "" {
		return nil
	}
	lines := splitLines(command)
	colored := highlightLines(strings.Join(lines, "\n"), toolCodeLexer(toolName, args))
	if len(colored) != len(lines) {
		return lines
	}
	return colored
}

// Diff row backgrounds mirror Pie's diff rows: rgba(34,197,94,0.12) for added
// lines and rgba(248,113,113,0.13) for removed ones, blended into the theme's
// panel colour and converted to the terminal's profile.
const (
	diffAddTintAlpha = 0.12
	diffDelTintAlpha = 0.13
)

// diffTint builds the background sequence a diff row is painted with.
func diffTint(accent, base lipgloss.AdaptiveColor, alpha float64) string {
	profile := lipgloss.ColorProfile()
	if profile == termenv.Ascii {
		return ""
	}
	mixed, ok := blendHex(resolveAdaptive(accent), resolveAdaptive(base), alpha)
	if !ok {
		return ""
	}
	return profile.Color(mixed).Sequence(true)
}

func resolveAdaptive(color lipgloss.AdaptiveColor) string {
	if lipgloss.HasDarkBackground() {
		return color.Dark
	}
	return color.Light
}

// blendHex mixes foreground into background at alpha. False means either input
// was not a hex colour, which leaves the row untinted rather than guessing.
func blendHex(foreground, background string, alpha float64) (string, bool) {
	fr, fg, fb, ok := parseHexColor(foreground)
	if !ok {
		return "", false
	}
	br, bg, bb, ok := parseHexColor(background)
	if !ok {
		return "", false
	}
	mix := func(f, b uint8) uint8 {
		return uint8(math.Round(float64(f)*alpha + float64(b)*(1-alpha)))
	}
	return fmt.Sprintf("#%02x%02x%02x", mix(fr, br), mix(fg, bg), mix(fb, bb)), true
}

func parseHexColor(value string) (uint8, uint8, uint8, bool) {
	value = strings.TrimPrefix(strings.TrimSpace(value), "#")
	if len(value) != 6 {
		return 0, 0, 0, false
	}
	number, err := strconv.ParseUint(value, 16, 32)
	if err != nil {
		return 0, 0, 0, false
	}
	return uint8(number >> 16), uint8(number >> 8), uint8(number), true
}

// tintLine paints a whole row with a background. Chroma resets the terminal
// after every token, which would clear a background applied around the row, so
// every reset re-applies the tint instead.
func tintLine(row, background string) string {
	if background == "" {
		return row
	}
	return background + strings.ReplaceAll(row, "\x1b[0m", "\x1b[0m"+background) + "\x1b[0m"
}

// wrapANSI word-wraps cell-aware, then hard-breaks any word still wider than the
// limit so a long path cannot overflow the transcript.
func wrapANSI(text string, limit int) string {
	if limit < 1 || lipgloss.Width(text) <= limit {
		return text
	}
	var out []string
	for _, line := range strings.Split(xansi.Wordwrap(text, limit, " /="), "\n") {
		if lipgloss.Width(line) > limit {
			out = append(out, strings.Split(xansi.Hardwrap(line, limit, false), "\n")...)
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}
