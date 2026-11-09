package ui

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
	"github.com/lihaozhe013/pie/tui/internal/skills"
)

type skillActionMsg struct {
	summary string
	output  string
	err     error
}

type skillSearchMsg struct {
	query   string
	results []skills.SearchResult
	err     error
}

type skillEditMsg struct{ err error }

func (m *Model) skillList() ([]skills.Skill, []skills.Diagnostic) {
	if m.configErr != nil {
		return nil, nil
	}
	var paths []string
	if m.settings != nil {
		list, err := m.settings.Skills()
		if err == nil {
			paths = list
		}
	}
	return skills.Load(m.paths.Dir, m.opts.CWD, paths)
}

func (m *Model) skillsSettingsTab() settingsTab {
	tab := settingsTab{
		ID:    "skills",
		Label: "Skills",
		Note:  "Skills loaded from the agent, project, and settings paths. Enter a skill to inspect it or change model invocation.",
	}
	list, diagnostics := m.skillList()
	enabled := 0
	for _, skill := range list {
		if !skill.Disabled {
			enabled++
		}
	}
	tab.Rows = append(tab.Rows, settingsRow{
		ID:    "skills-summary",
		Label: "Loaded",
		Kind:  settingsInfo,
		Current: func() string {
			return fmt.Sprintf("%d skills · %d enabled", len(list), enabled)
		},
		Help: "Pi reads these with the same rules as the web panel.",
	})
	if len(diagnostics) > 0 {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "skills-diagnostics",
			Label:   "Diagnostics",
			Kind:    settingsInfo,
			Current: func() string { return fmt.Sprintf("%d issue(s)", len(diagnostics)) },
			Help:    diagnostics[0].Message + " — " + diagnostics[0].Path,
		})
	}
	tab.Rows = append(tab.Rows,
		settingsRow{
			ID:    "skills-search",
			Label: "Search skills.sh",
			Kind:  settingsAction,
			Help:  "Find a skill by name and install it into the agent skills directory.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				request := &rpc.ExtensionUIRequestEvent{Title: "Search skills.sh", Method: "input", Placeholder: "react"}
				overlay := newInputOverlay(request)
				overlay.action = "skill-search"
				m.openOverlay(overlay)
				return nil
			},
		},
		settingsRow{
			ID:    "skills-install",
			Label: "Install from source",
			Kind:  settingsAction,
			Help:  "Accepts owner/repo, owner/repo@skill, or a skills.sh URL.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				request := &rpc.ExtensionUIRequestEvent{Title: "Install skill package", Method: "input", Placeholder: "owner/repo@skill"}
				overlay := newInputOverlay(request)
				overlay.action = "skill-install-source"
				m.openOverlay(overlay)
				return nil
			},
		},
		settingsRow{
			ID:    "skills-update-global",
			Label: "Update global skills",
			Kind:  settingsAction,
			Help:  "Runs npx skills update -g -y.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				return m.updateSkills(true)
			},
		},
		settingsRow{
			ID:    "skills-update-project",
			Label: "Update project skills",
			Kind:  settingsAction,
			Help:  "Runs npx skills update -p -y in the working directory.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				return m.updateSkills(false)
			},
		},
	)

	if len(list) == 0 {
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "skills-empty",
			Label:   "No skills found",
			Kind:    settingsInfo,
			Current: func() string { return m.paths.Dir + "/skills" },
			Help:    "Install one from skills.sh or add a SKILL.md file.",
		})
	}
	for _, skill := range list {
		skill := skill
		status := "enabled"
		if skill.Disabled {
			status = "disabled"
		}
		tab.Rows = append(tab.Rows, settingsRow{
			ID:      "skill-" + skill.Name,
			Label:   skill.Name,
			Kind:    settingsAction,
			Current: func() string { return status + " · " + skill.Scope },
			Help:    skill.Description,
			Run: func(m *Model, s *settingsState) tea.Cmd {
				return m.openSkillDetail(skill)
			},
		})
	}
	return tab
}

func (m *Model) openSkillDetail(skill skills.Skill) tea.Cmd {
	disabled := skill.Disabled
	tab := settingsTab{ID: "skill", Label: "Skill", Note: skill.FilePath}
	tab.Rows = []settingsRow{
		{ID: "skill-name", Label: "Name", Kind: settingsInfo, Current: func() string { return skill.Name }},
		{ID: "skill-scope", Label: "Scope", Kind: settingsInfo, Current: func() string { return skill.Scope }},
		{ID: "skill-description", Label: "Description", Kind: settingsInfo, Current: func() string { return skill.Description }},
		{
			ID:    "skill-invocation",
			Label: "Model invocation",
			Help:  "Disabled skills stay available as /skill:<name> but are left out of the model's skill list.",
			Kind:  settingsToggle,
			Bool:  func() bool { return !disabled },
			SetBool: func(on bool) error {
				if err := skills.SetDisabled(skill.FilePath, !on); err != nil {
					return err
				}
				disabled = !on
				return nil
			},
		},
		{
			ID:      "skill-reload",
			Label:   "Applies",
			Kind:    settingsInfo,
			Current: func() string { return "on the next pi start or reload" },
		},
		{
			ID:    "skill-reload",
			Label: "Reload pi",
			Help:  "Runs /pie-reload so pi rereads its skill list without restarting.",
			Kind:  settingsAction,
			Run: func(m *Model, s *settingsState) tea.Cmd {
				return m.reloadPi()
			},
		},
		{
			ID:    "skill-edit",
			Label: "Edit skill file",
			Kind:  settingsAction,
			Help:  "Opens " + skill.FilePath + " in $VISUAL or $EDITOR.",
			Run: func(m *Model, s *settingsState) tea.Cmd {
				return m.editSkillFile(skill.FilePath)
			},
		},
		{
			ID:    "skill-back",
			Label: "Back",
			Kind:  settingsAction,
			Run: func(m *Model, s *settingsState) tea.Cmd {
				return m.openSettingsAt("skills")
			},
		},
	}
	panel := newSettingsPanel("Skill · "+skill.Name, []settingsTab{tab})
	panel.action = "skill-detail"
	panel.back = func(mm *Model) tea.Cmd { return mm.openSettingsAt("skills") }
	m.showPage(panel)
	return nil
}

func (m *Model) editSkillFile(path string) tea.Cmd {
	editor := strings.TrimSpace(os.Getenv("VISUAL"))
	if editor == "" {
		editor = strings.TrimSpace(os.Getenv("EDITOR"))
	}
	if editor == "" {
		editor = "nvim"
	}
	fields := strings.Fields(editor)
	command := exec.Command(fields[0], append(fields[1:], path)...)
	return tea.ExecProcess(command, func(err error) tea.Msg { return skillEditMsg{err: err} })
}

func (m *Model) searchSkills(query string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		results, err := skills.Search(ctx, "", query, 50)
		return skillSearchMsg{query: query, results: results, err: err}
	}
}

func (m *Model) installSkill(pkg string) tea.Cmd {
	pkg = strings.TrimSpace(pkg)
	if pkg == "" {
		return nil
	}
	cwd := m.opts.CWD
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
		defer cancel()
		output, err := skills.Install(ctx, pkg, cwd, true)
		return skillActionMsg{summary: "installed " + pkg, output: output, err: err}
	}
}

func (m *Model) updateSkills(global bool) tea.Cmd {
	cwd := m.opts.CWD
	scope := "project"
	if global {
		scope = "global"
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 130*time.Second)
		defer cancel()
		output, err := skills.UpdateAll(ctx, cwd, global)
		return skillActionMsg{summary: "updated " + scope + " skills", output: output, err: err}
	}
}

func (m *Model) applySkillSearch(msg skillSearchMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.addError("skill search: " + msg.err.Error())
		return m, m.openSettingsAt("skills")
	}
	if len(msg.results) == 0 {
		m.setToast("no skills found for " + msg.query)
		return m, m.openSettingsAt("skills")
	}
	items := make([]pickerItem, 0, len(msg.results))
	for _, result := range msg.results {
		detail := result.Installs
		if detail == "" {
			detail = "skills.sh"
		}
		items = append(items, pickerItem{Value: result.Package, Label: result.Package, Detail: detail})
	}
	m.openOverlay(newPickerOverlay("skill-search-results", "Install a skill · "+msg.query, items))
	return m, nil
}

func (m *Model) applySkillAction(msg skillActionMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.addError("skills: " + msg.err.Error())
		if strings.TrimSpace(msg.output) != "" {
			m.addNotice(msg.output)
		}
		return m, nil
	}
	m.setToast(msg.summary)
	return m, m.openSettingsAt("skills")
}
