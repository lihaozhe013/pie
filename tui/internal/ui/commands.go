package ui

import "strings"

// builtinCommand is one command pie handles itself instead of forwarding to
// pi. Aliases let the names users know from other CLIs work without duplicating
// the dispatch code.
type builtinCommand struct {
	Name    string   // canonical name, e.g. "/quit"
	Detail  string   // one-line description for the picker
	Aliases []string // accepted alternative names, e.g. "/exit"
}

// builtinCommandTable is the single source of truth for client-side commands.
// Dispatch, the completion popup, and /help all read it, so a command can never
// be reachable without also being discoverable.
//
// An alias is a convenience only: runSlash ignores one when pi reported a
// command with the same name, so an extension or prompt template called
// "continue" is never shadowed by the /resume alias.
var builtinCommandTable = []builtinCommand{
	{Name: "/settings", Detail: "open settings", Aliases: []string{"/config", "/prefs"}},
	{Name: "/preset", Detail: "change the tool preset", Aliases: []string{"/tools"}},
	{Name: "/model", Detail: "switch model", Aliases: []string{"/models"}},
	{Name: "/think", Detail: "cycle thinking level"},
	{Name: "/new", Detail: "start a new session"},
	{Name: "/resume", Detail: "resume another session", Aliases: []string{"/continue", "/sessions"}},
	{Name: "/compact", Detail: "compact the conversation", Aliases: []string{"/compress"}},
	{Name: "/name", Detail: "rename this session", Aliases: []string{"/rename"}},
	{Name: "/title", Detail: "generate a session title"},
	{Name: "/goal", Detail: "goal status and controls"},
	{Name: "/cwd", Detail: "switch working directory", Aliases: []string{"/dir", "/project"}},
	{Name: "/image", Detail: "attach an image to a prompt"},
	{Name: "/context", Detail: "system prompt and tool definitions", Aliases: []string{"/tools-view"}},
	{Name: "/search", Detail: "search session names, folders, and transcripts"},
	{Name: "/fork", Detail: "fork the session from a user message"},
	{Name: "/clone", Detail: "clone the current branch into a new session"},
	{Name: "/tree", Detail: "show the session tree"},
	{Name: "/export", Detail: "export the session as HTML"},
	{Name: "/stats", Detail: "show token and context usage", Aliases: []string{"/status", "/usage"}},
	{Name: "/clear", Detail: "clear the scrollback", Aliases: []string{"/cls"}},
	{Name: "/mouse", Detail: "toggle mouse capture for native selection"},
	{Name: "/help", Detail: "show key bindings", Aliases: []string{"/keys"}},
	{Name: "/quit", Detail: "exit pie", Aliases: []string{"/exit", "/q"}},
}

// builtinTarget is the resolution result for a typed slash name.
type builtinTarget struct {
	name  string // canonical command name
	alias bool   // the typed name was an alias, not the canonical name
}

// builtinIndex maps every accepted client-side name to its canonical command.
var builtinIndex = buildBuiltinIndex()

func buildBuiltinIndex() map[string]builtinTarget {
	index := make(map[string]builtinTarget, len(builtinCommandTable)*2)
	for _, command := range builtinCommandTable {
		index[command.Name] = builtinTarget{name: command.Name}
		for _, alias := range command.Aliases {
			index[alias] = builtinTarget{name: command.Name, alias: true}
		}
	}
	return index
}

// builtinCommands lists client-side commands for the completion popup. Aliases
// are included so typing "/ex" reveals /exit.
func builtinCommands() []completionItem {
	items := make([]completionItem, 0, len(builtinCommandTable)*2)
	for _, command := range builtinCommandTable {
		items = append(items, completionItem{
			Value:   command.Name,
			Detail:  command.Detail,
			Kind:    "builtin",
			Builtin: true,
		})
		for _, alias := range command.Aliases {
			items = append(items, completionItem{
				Value:   alias,
				Detail:  "alias for " + command.Name,
				Kind:    "builtin",
				Builtin: true,
				Alias:   command.Name,
			})
		}
	}
	return items
}

// piOwns reports whether pi advertised a command under name, ignoring the
// leading slash.
func (m *Model) piOwns(name string) bool {
	trimmed := strings.TrimPrefix(name, "/")
	for _, command := range m.commands {
		if command.Name == trimmed {
			return true
		}
	}
	return false
}
