package ui

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/lihaozhe013/pie/tui/internal/config"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
)

type pluginActionMsg struct {
	summary string
	output  string
	err     error
}

func (m *Model) projectSettings() *config.Settings {
	path := filepath.Join(m.opts.CWD, ".pi", "settings.json")
	settings, err := config.LoadSettingsAt(path)
	if err != nil {
		return nil
	}
	return settings
}

func (m *Model) pluginsSettingsTab() settingsTab {
	tab := settingsTab{
		ID:    "plugins",
		Label: "Plugins",
		Note:  "Pi packages from settings.json. Installing writes the same file the web panel and pi use.",
	}

	var global, project []config.Package
	var problems []string
	if m.settings != nil {
		list, err := m.settings.PackageEntries()
		if err != nil {
			problems = append(problems, err.Error())
		} else {
			global = list
		}
	}
	if settings := m.projectSettings(); settings != nil {
		list, err := settings.PackageEntries()
		if err != nil {
			problems = append(problems, err.Error())
		} else {
			project = list
		}
	}
	tab.Rows = append(tab.Rows, settingsRow{
		ID:    "plugins-summary",
		Label: "Installed",
		Kind:  settingsInfo,
		Current: func() string {
			return fmt.Sprintf("%d global · %d project", len(global), len(project))
		},
		Help: "Project packages live in .pi/settings.json and apply to this folder only.",
	})
	if len(problems) > 0 {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "plugins-problems",
			Label:   "Packages unreadable",
			Kind:    settingsInfo,
			Current: func() string { return fmt.Sprintf("%d issue(s)", len(problems)) },
			Help:    problems[0],
		})
	}
	tab.Rows = append(tab.Rows,
		settingsRow{
			ID:    "plugins-install-global",
			Label: "Install globally",
			Kind:  settingsAction,
			Help:  "npm:, git:, https:, or a local path. Runs pi install <source>.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				request := &rpc.ExtensionUIRequestEvent{Title: "Install package", Method: "input", Placeholder: "npm:owner/package"}
				overlay := newInputOverlay(request)
				overlay.action = "plugin-install-global"
				m.openOverlay(overlay)
				return nil
			},
		},
		settingsRow{
			ID:    "plugins-install-project",
			Label: "Install in this project",
			Kind:  settingsAction,
			Help:  "Adds the package to .pi/settings.json (pi install <source> -l).",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				request := &rpc.ExtensionUIRequestEvent{Title: "Install package locally", Method: "input", Placeholder: "npm:owner/package"}
				overlay := newInputOverlay(request)
				overlay.action = "plugin-install-project"
				m.openOverlay(overlay)
				return nil
			},
		},
		settingsRow{
			ID:    "plugins-update",
			Label: "Update all packages",
			Kind:  settingsAction,
			Help:  "Runs pi update --extensions.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				m.setToast("updating packages…")
				return m.runPiCommand([]string{"update", "--extensions"}, "packages updated")
			},
		},
	)

	addRows := func(entries []config.Package, scope string) {
		for _, entry := range entries {
			entry := entry
			status := "enabled"
			if entry.Disabled {
				status = "disabled"
			}
			tab.Rows = append(tab.Rows, settingsRow{
				ID:      "package-" + scope + "-" + entry.Source,
				Label:   entry.Source,
				Kind:    settingsAction,
				Current: func() string { return status + " · " + scope },
				Help:    "Enter to update, enable, or remove this package.",
				Run: func(m *Model, s *settingsState) tea.Cmd {
					return m.openPackageDetail(entry, scope)
				},
			})
		}
	}
	addRows(global, "global")
	addRows(project, "project")

	if len(global)+len(project) == 0 {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "plugins-empty",
			Label:   "No packages installed",
			Kind:    settingsInfo,
			Current: func() string { return "install one above" },
		})
	}
	return tab
}

func (m *Model) openPackageDetail(entry config.Package, scope string) tea.Cmd {
	disabled := entry.Disabled
	armed := false
	setDisabled := func(value bool) error {
		if scope == "project" {
			if err := m.projectWriteRefusal(false); err != nil {
				return err
			}
			settings := m.projectSettings()
			if settings == nil {
				return fmt.Errorf("cannot read .pi/settings.json")
			}
			if err := settings.SetPackageDisabled(entry.Source, value); err != nil {
				return err
			}
		} else {
			if m.settings == nil {
				return fmt.Errorf("settings.json is unavailable")
			}
			if err := m.settings.SetPackageDisabled(entry.Source, value); err != nil {
				return err
			}
		}
		disabled = value
		return nil
	}

	tab := settingsTab{ID: "package", Label: "Package", Note: entry.Source}
	tab.Rows = []settingsRow{
		{ID: "package-reload-note", Label: "Applies", Kind: settingsInfo, Current: func() string { return "after a reload or restart" }},
		{ID: "package-source", Label: "Source", Kind: settingsInfo, Current: func() string { return entry.Source }},
		{ID: "package-scope", Label: "Scope", Kind: settingsInfo, Current: func() string { return scope }},
		{
			ID:    "package-enabled",
			Label: "Enabled",
			Help:  "Disabling empties every resource list. A package with its own filters must be switched from its own settings.",
			Kind:  settingsToggle,
			Bool:  func() bool { return !disabled },
			SetBool: func(on bool) error {
				return setDisabled(!on)
			},
		},
		{
			ID:    "package-reload",
			Label: "Reload now",
			Help:  "Runs /pie-reload so pi rereads settings without restarting.",
			Kind:  settingsAction,
			Run: func(m *Model, s *settingsState) tea.Cmd {
				return m.reloadPi()
			},
		},
		{
			ID:    "package-update",
			Label: "Update this package",
			Kind:  settingsAction,
			Help:  "Runs pi update --extension <source>.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				if scope == "project" {
					if err := m.projectWriteRefusal(false); err != nil {
						s.err = err.Error()
						return nil
					}
				}
				m.setToast("updating " + entry.Source + "…")
				return m.runPiCommand([]string{"update", "--extension", entry.Source}, "updated "+entry.Source)
			},
		},
		{
			ID:    "package-remove",
			Label: "Remove",
			Kind:  settingsAction,
			Help:  "Removes the package from settings. Press enter twice to confirm.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				if !armed {
					armed = true
					s.notice = "press enter again to remove " + entry.Source
					return nil
				}
				if scope == "project" {
					if err := m.projectWriteRefusal(false); err != nil {
						s.err = err.Error()
						return nil
					}
				}
				args := []string{"remove", entry.Source}
				if scope == "project" {
					args = append(args, "-l")
				}
				m.setToast("removing " + entry.Source + "…")
				return m.runPiCommand(args, "removed "+entry.Source)
			},
		},
		{
			ID:    "package-back",
			Label: "Back",
			Kind:  settingsAction,
			Run: func(m *Model, s *settingsState) tea.Cmd {
				return m.openSettingsAt("plugins")
			},
		},
	}
	panel := newSettingsPanel("Package · "+entry.Source, []settingsTab{tab})
	panel.action = "package-detail"
	panel.back = func(mm *Model) tea.Cmd { return mm.openSettingsAt("plugins") }
	m.showPage(panel)
	return nil
}

func (m *Model) installPackage(source string, global bool) tea.Cmd {
	source = strings.TrimSpace(source)
	if source == "" {
		return nil
	}
	if !global {
		if err := m.projectWriteRefusal(false); err != nil {
			m.setToast(err.Error())
			return nil
		}
	}
	args := []string{"install", source}
	scope := "globally"
	if !global {
		args = append(args, "-l")
		scope = "in " + m.opts.CWD
	}
	m.setToast("installing " + source + " " + scope + "…")
	return m.runPiCommand(args, "installed "+source)
}

func (m *Model) runPiCommand(args []string, summary string) tea.Cmd {
	bin := m.opts.PiBin
	if bin == "" {
		bin = "pi"
	}
	cwd := m.opts.CWD
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, bin, args...)
		command.Dir = cwd
		output, err := command.CombinedOutput()
		clean := strings.TrimSpace(string(output))
		if err != nil {
			if clean != "" {
				return pluginActionMsg{summary: summary, output: clean, err: fmt.Errorf("%s", tailLines(clean, 6))}
			}
			return pluginActionMsg{summary: summary, err: err}
		}
		return pluginActionMsg{summary: summary, output: clean}
	}
}

func tailLines(value string, count int) string {
	lines := strings.Split(strings.TrimSpace(value), "\n")
	if len(lines) > count {
		lines = lines[len(lines)-count:]
	}
	return strings.Join(lines, "\n")
}

func (m *Model) applyPluginAction(msg pluginActionMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.addError("package: " + msg.err.Error())
		return m, m.openSettingsAt("plugins")
	}
	m.setToast(msg.summary + " · restart pie to load it")
	return m, m.openSettingsAt("plugins")
}
