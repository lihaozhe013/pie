package session

import "sort"

// Project is one working directory sessions were created in.
type Project struct {
	Path     string
	Sessions int
	Last     int64 // unix nanoseconds of the newest session
}

// Projects derives the recent projects from session headers. It is the only
// index: sessions are the source of truth, so a project cannot drift from the
// folders it actually contains.
func Projects(dir string) ([]Project, error) {
	entries, err := List(dir, 0)
	if err != nil {
		return nil, err
	}
	byPath := map[string]*Project{}
	for _, entry := range entries {
		if entry.CWD == "" {
			continue
		}
		path := canonicalDir(entry.CWD)
		project := byPath[path]
		if project == nil {
			project = &Project{Path: path}
			byPath[path] = project
		}
		project.Sessions++
		if stamp := entry.Modified.UnixNano(); stamp > project.Last {
			project.Last = stamp
		}
	}
	projects := make([]Project, 0, len(byPath))
	for _, project := range byPath {
		projects = append(projects, *project)
	}
	sort.Slice(projects, func(i, j int) bool {
		if projects[i].Last != projects[j].Last {
			return projects[i].Last > projects[j].Last
		}
		return projects[i].Path < projects[j].Path
	})
	return projects, nil
}
