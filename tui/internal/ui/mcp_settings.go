package ui

import (
	"context"
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/lihaozhe013/pie/tui/internal/config"
	"github.com/lihaozhe013/pie/tui/internal/mcp"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

type mcpCheckMsg struct {
	snapshot mcp.Snapshot
	err      error
}

type mcpActionMsg struct {
	summary string
	output  string
	err     error
}

var mcpExposures = []string{"auto", "codemode", "deferred", "direct", "hidden"}

func (m *Model) mcpServerList() (global, project []config.MCPServer, problems []string) {
	if file, err := config.LoadMCP(m.paths); err != nil {
		problems = append(problems, err.Error())
	} else {
		global = file.Servers()
	}
	if file, err := config.LoadProjectMCP(m.opts.CWD); err != nil {
		problems = append(problems, err.Error())
	} else {
		project = file.Servers()
	}
	return global, project, problems
}

func (m *Model) mcpStatusFor(name string) (mcp.Status, bool) {
	for _, status := range m.mcpSnapshot.Servers {
		if status.Name == name {
			return status, true
		}
	}
	return mcp.Status{}, false
}

func (m *Model) mcpSettingsTab() settingsTab {
	tab := settingsTab{
		ID:    "mcp",
		Label: "MCP",
		Note:  "Servers from the agent's mcp.json and the project's .pi/mcp.json. Check connections asks pi to start each enabled server.",
	}
	global, project, problems := m.mcpServerList()
	tab.Rows = append(tab.Rows, settingsRow{
		ID:    "mcp-summary",
		Label: "Configured",
		Kind:  settingsInfo,
		Current: func() string {
			return fmt.Sprintf("%d global · %d project", len(global), len(project))
		},
		Help: "Project servers are read only in trusted projects when pi runs.",
	})
	if m.mcpChecked || len(m.mcpSnapshot.Errors) > 0 {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:    "mcp-checked",
			Label: "Last check",
			Kind:  settingsInfo,
			Current: func() string {
				connected := 0
				for _, status := range m.mcpSnapshot.Servers {
					if status.State == "connected" {
						connected++
					}
				}
				return fmt.Sprintf("%d connected · %d errors", connected, len(m.mcpSnapshot.Errors))
			},
			Help: "Errors are listed at the end of this tab.",
		})
	}
	for _, problem := range problems {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "mcp-problem-" + problem,
			Label:   "Unreadable mcp.json",
			Kind:    settingsInfo,
			Current: func() string { return problem },
		})
	}
	tab.Rows = append(tab.Rows,
		settingsRow{
			ID:    "mcp-check",
			Label: "Check connections",
			Kind:  settingsAction,
			Help:  "Runs pi mcp list --json. Enabled servers are started and stopped.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				m.setToast("checking MCP servers…")
				return m.checkMCP()
			},
		},
		settingsRow{
			ID:    "mcp-add",
			Label: "Add server",
			Kind:  settingsAction,
			Help:  "Arguments for pi mcp add, e.g. name -- npx -y server. Shell quoting is not supported.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				return m.openMCPAddInput(false)
			},
		},
		settingsRow{
			ID:    "mcp-add-project",
			Label: "Add server in this project",
			Kind:  settingsAction,
			Help:  "Same arguments, written to .pi/mcp.json (pi mcp add … -l).",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				return m.openMCPAddInput(true)
			},
		},
	)

	addRows := func(servers []config.MCPServer, scope string) {
		for _, server := range servers {
			server := server
			transport := server.Transport()
			state := ""
			if status, ok := m.mcpStatusFor(server.Name); ok {
				if status.State != "" {
					state = " · " + status.State
				}
			}
			status := "on"
			if !server.Enabled {
				status = "off"
			}
			tab.Rows = append(tab.Rows, settingsRow{
				ID:      "mcp-" + scope + "-" + server.Name,
				Label:   server.Name,
				Kind:    settingsAction,
				Current: func() string { return status + state + " · " + scope + " · " + transport },
				Help:    server.Description,
				Run: func(m *Model, s *settingsState) tea.Cmd {
					return m.openMCPServer(server, scope)
				},
			})
		}
	}
	addRows(global, "global")
	addRows(project, "project")

	if len(global)+len(project) == 0 {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "mcp-empty",
			Label:   "No servers configured",
			Kind:    settingsInfo,
			Current: func() string { return m.paths.MCP() },
		})
	}
	for _, problem := range m.mcpSnapshot.Errors {
		problem := problem
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "mcp-error-" + problem,
			Label:   "Connection error",
			Kind:    settingsInfo,
			Current: func() string { return problem },
		})
	}
	return tab
}

func (m *Model) openMCPAddInput(local bool) tea.Cmd {
	m.openOverlayFromSettings(func() {
		base := &rpc.ExtensionUIRequestEvent{
			Title:       "Add MCP server",
			Method:      "input",
			Placeholder: "name -- npx -y @modelcontextprotocol/server-filesystem /tmp",
			Message:     "For an HTTP server: name --url https://example.com/mcp",
		}
		overlay := newInputOverlay(base)
		if local {
			overlay.action = "mcp-add-local"
		} else {
			overlay.action = "mcp-add-global"
		}
		m.openOverlay(overlay)
	})
	return nil
}

func (m *Model) openMCPServer(server config.MCPServer, scope string) tea.Cmd {
	build := func(mm *Model) []settingsTab {
		if scope == "project" {
			if err := mm.projectWriteRefusal(true); err != nil {
				tab := settingsTab{ID: "mcp-server", Label: "Server", Note: server.Name}
				tab.Rows = []settingsRow{
					{ID: "mcp-name", Label: "Name", Kind: settingsInfo, Current: func() string { return server.Name }},
					{ID: "mcp-scope", Label: "Scope", Kind: settingsInfo, Current: func() string { return "project" }},
					{ID: "mcp-trust", Label: "Status", Kind: settingsInfo, Current: func() string { return "read only" }, Help: err.Error()},
					{ID: "mcp-back", Label: "Back", Kind: settingsAction, Run: func(m *Model, s *settingsState) tea.Cmd {
						return m.popSettingsPanel("mcp")
					}},
				}
				return []settingsTab{tab}
			}
		}

		global, project, _ := mm.mcpServerList()
		currentServer := server
		allServers := global
		if scope == "project" {
			allServers = project
		}
		for _, s := range allServers {
			if s.Name == server.Name {
				currentServer = s
				break
			}
		}
		server = currentServer
		enabled := server.Enabled
		exposure := server.Exposure
		if exposure == "" {
			exposure = "auto"
		}
		armed := false
		file := func() (*config.MCPFile, error) {
			if scope == "project" {
				return config.LoadProjectMCP(mm.opts.CWD)
			}
			return config.LoadMCP(mm.paths)
		}
		save := func(fn func(*config.MCPFile) error) error {
			current, err := file()
			if err != nil {
				return err
			}
			return fn(current)
		}

		tab := settingsTab{ID: "mcp-server", Label: "Server", Note: server.Name}
		tab.Rows = []settingsRow{
			{ID: "mcp-name", Label: "Name", Kind: settingsInfo, Current: func() string { return server.Name }},
			{ID: "mcp-scope", Label: "Scope", Kind: settingsInfo, Current: func() string { return scope }},
			{ID: "mcp-transport", Label: "Transport", Kind: settingsInfo, Current: func() string { return server.Transport() }},
			{ID: "mcp-description", Label: "Description", Kind: settingsInfo, Current: func() string {
				if server.Description == "" {
					return "(none)"
				}
				return server.Description
			}},
			{ID: "mcp-env", Label: "Environment", Kind: settingsInfo, Help: "Names only; values stay in mcp.json.", Current: func() string {
				return maskedSecrets(server.Env)
			}},
			{ID: "mcp-headers", Label: "Headers", Kind: settingsInfo, Help: "Names only; values stay in mcp.json.", Current: func() string {
				return maskedSecrets(server.Headers)
			}},
			{
				ID:    "mcp-enabled",
				Label: "Enabled",
				Kind:  settingsToggle,
				Bool:  func() bool { return enabled },
				SetBool: func(on bool) error {
					if err := save(func(f *config.MCPFile) error { return f.SetServerEnabled(server.Name, on) }); err != nil {
						return err
					}
					enabled = on
					return nil
				},
			},
			{
				ID:      "mcp-exposure",
				Label:   "Exposure",
				Kind:    settingsChoice,
				Current: func() string { return exposure },
				Choices: mcpExposureChoices(),
				Apply: func(value string) error {
					if err := save(func(f *config.MCPFile) error { return f.SetServerExposure(server.Name, value) }); err != nil {
						return err
					}
					exposure = value
					return nil
				},
			},
			{
				ID:    "mcp-check-one",
				Label: "Check connections",
				Kind:  settingsAction,
				Run: func(m *Model, s *settingsState) tea.Cmd {
					m.setToast("checking MCP servers…")
					return m.checkMCP()
				},
			},
			{
				ID:    "mcp-login",
				Label: "Sign in",
				Kind:  settingsAction,
				Help:  "Opens the browser OAuth flow for HTTP servers that use OAuth.",
				Run: func(m *Model, s *settingsState) tea.Cmd {
					m.setToast("starting MCP sign-in for " + server.Name + "…")
					return m.runMCPCommand(func(ctx context.Context, bin, cwd string) (string, error) {
						return mcp.Login(ctx, bin, cwd, server.Name, scope == "project")
					}, "signed in to "+server.Name)
				},
			},
			{
				ID:    "mcp-logout",
				Label: "Sign out",
				Kind:  settingsAction,
				Run: func(m *Model, s *settingsState) tea.Cmd {
					return m.runMCPCommand(func(ctx context.Context, bin, cwd string) (string, error) {
						return mcp.Logout(ctx, bin, cwd, server.Name, scope == "project")
					}, "signed out of "+server.Name)
				},
			},
			{
				ID:    "mcp-remove",
				Label: "Remove server",
				Kind:  settingsAction,
				Help:  "Press enter twice to confirm.",
				Run: func(m *Model, s *settingsState) tea.Cmd {
					if !armed {
						armed = true
						s.notice = "press enter again to remove " + server.Name
						return nil
					}
					return m.runMCPCommand(func(ctx context.Context, bin, cwd string) (string, error) {
						return mcp.Remove(ctx, bin, cwd, server.Name, scope == "project")
					}, "removed "+server.Name)
				},
			},
			{
				ID:    "mcp-back",
				Label: "Back",
				Kind:  settingsAction,
				Run: func(m *Model, s *settingsState) tea.Cmd {
					return m.popSettingsPanel("mcp")
				},
			},
		}
		if status, ok := mm.mcpStatusFor(server.Name); ok {
			stateRow := settingsRow{
				ID:    "mcp-state",
				Label: "State",
				Kind:  settingsInfo,
				Current: func() string {
					if status.Error != "" {
						return status.State + " · " + status.Error
					}
					if len(status.Tools) > 0 {
						return fmt.Sprintf("%s · %d tools", status.State, len(status.Tools))
					}
					return status.State
				},
			}
			rows := append([]settingsRow{}, tab.Rows[:4]...)
			rows = append(rows, stateRow)
			tab.Rows = append(rows, tab.Rows[4:]...)
		}
		return []settingsTab{tab}
	}

	state := m.pushSettingsPanel("mcp", "Server · "+server.Name, build)
	state.action = "mcp-detail"
	m.showPage(state)
	return nil
}

func maskedSecrets(values map[string]string) string {
	names := config.SecretNames(values)
	if len(names) == 0 {
		return "(none)"
	}
	masked := make([]string, 0, len(names))
	for _, name := range names {
		masked = append(masked, name+"=···")
	}
	return strings.Join(masked, ", ")
}

func mcpExposureChoices() []pickerItem {
	items := make([]pickerItem, 0, len(mcpExposures))
	for _, exposure := range mcpExposures {
		detail := ""
		switch exposure {
		case "auto":
			detail = "server default (codemode unless set)"
		case "codemode":
			detail = "reachable through the codemode tool"
		case "deferred":
			detail = "listed, loaded on demand"
		case "direct":
			detail = "exposed as tools"
		case "hidden":
			detail = "callable but not declared"
		}
		items = append(items, pickerItem{Value: exposure, Label: exposure, Detail: detail})
	}
	return items
}

func (m *Model) checkMCP() tea.Cmd {
	bin := m.opts.PiBin
	cwd := m.opts.CWD
	return func() tea.Msg {
		snapshot, err := mcp.Check(context.Background(), bin, cwd)
		return mcpCheckMsg{snapshot: snapshot, err: err}
	}
}

func (m *Model) runMCPCommand(run func(context.Context, string, string) (string, error), summary string) tea.Cmd {
	bin := m.opts.PiBin
	cwd := m.opts.CWD
	return func() tea.Msg {
		output, err := run(context.Background(), bin, cwd)
		return mcpActionMsg{summary: summary, output: output, err: err}
	}
}

func (m *Model) addMCP(arguments string, local bool) tea.Cmd {
	if local {
		if err := m.projectWriteRefusal(true); err != nil {
			m.setToast(err.Error())
			return nil
		}
	}
	fields := strings.Fields(arguments)
	if len(fields) == 0 {
		m.setToast("server arguments are required")
		return nil
	}
	bin := m.opts.PiBin
	cwd := m.opts.CWD
	summary := "added " + fields[0]
	return func() tea.Msg {
		output, err := mcp.Add(context.Background(), bin, cwd, fields, local)
		return mcpActionMsg{summary: summary, output: output, err: err}
	}
}

func (m *Model) applyMCPCheck(msg mcpCheckMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.addError("mcp: " + msg.err.Error())
		m.openSettingsOverlay()
		return m, nil
	}
	m.mcpSnapshot = msg.snapshot
	m.mcpChecked = true
	if len(msg.snapshot.Errors) > 0 {
		m.setToast(fmt.Sprintf("%d MCP error(s)", len(msg.snapshot.Errors)))
	} else {
		m.setToast(fmt.Sprintf("%d MCP server(s) checked", len(msg.snapshot.Servers)))
	}
	m.openSettingsOverlay()
	return m, nil
}

func (m *Model) applyMCPAction(msg mcpActionMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.addError("mcp: " + msg.err.Error())
		m.openSettingsOverlay()
		return m, nil
	}
	m.setToast(msg.summary)
	m.openSettingsOverlay()
	return m, nil
}
