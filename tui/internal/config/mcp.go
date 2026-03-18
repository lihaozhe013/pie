package config

import (
	"path/filepath"
	"sort"
)

// MCPFile is a snapshot of one mcp.json (global or project).
type MCPFile struct {
	path string
	root *Value
}

// MCPServer is one entry of mcpServers.
type MCPServer struct {
	Name        string
	Command     string
	Args        []string
	URL         string
	Enabled     bool
	Exposure    string
	Description string
	Env         map[string]string
	Headers     map[string]string
	Raw         *Value
}

// LoadMCP reads the global mcp.json. A missing file reads as empty.
func LoadMCP(paths Paths) (*MCPFile, error) {
	return loadMCPFile(paths.MCP())
}

// LoadProjectMCP reads a project's .pi/mcp.json.
func LoadProjectMCP(projectDir string) (*MCPFile, error) {
	return loadMCPFile(filepath.Join(projectDir, ".pi", "mcp.json"))
}

func loadMCPFile(path string) (*MCPFile, error) {
	doc, err := LoadObject(path)
	if err != nil {
		return nil, err
	}
	return &MCPFile{path: path, root: doc.Root()}, nil
}

// Path returns the file path.
func (m *MCPFile) Path() string { return m.path }

// Root returns the current tree.
func (m *MCPFile) Root() *Value { return m.root }

// Servers returns the configured servers in file order. A malformed entry is
// still listed, with its raw value available, so the panel can show it.
func (m *MCPFile) Servers() []MCPServer {
	container := m.root.Get("mcpServers")
	if container == nil || !container.IsObject() {
		return nil
	}
	out := make([]MCPServer, 0, container.Len())
	for _, name := range container.Keys() {
		entry := container.Get(name)
		server := MCPServer{Name: name, Enabled: true, Raw: entry, Exposure: "auto"}
		if entry == nil || !entry.IsObject() {
			out = append(out, server)
			continue
		}
		server.Command, _ = entry.Get("command").AsString()
		server.Args = entry.Get("args").StringsOr(nil)
		server.URL, _ = entry.Get("url").AsString()
		server.Description, _ = entry.Get("description").AsString()
		server.Env = stringMap(entry.Get("env"))
		server.Headers = stringMap(entry.Get("headers"))
		server.Exposure, _ = entry.Get("exposure").AsString()
		if server.Exposure == "" {
			server.Exposure = "auto"
		}
		if enabled := entry.Get("enabled"); enabled != nil {
			server.Enabled = enabled.BoolOr(true)
		}
		out = append(out, server)
	}
	return out
}

func stringMap(value *Value) map[string]string {
	if value == nil || !value.IsObject() {
		return nil
	}
	out := make(map[string]string, value.Len())
	for _, key := range value.Keys() {
		if text, ok := value.Get(key).AsString(); ok {
			out[key] = text
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// SecretNames lists the env or header names in sorted order. Values are never
// returned to the UI, so panels can only show masked entries.
func SecretNames(values map[string]string) []string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Update applies fn to a freshly loaded mcp.json and writes it back.
func (m *MCPFile) Update(fn func(root *Value) error) error {
	if err := Update(m.path, fn); err != nil {
		return err
	}
	doc, err := LoadObject(m.path)
	if err != nil {
		return err
	}
	m.root = doc.Root()
	return nil
}

// SetServerEnabled writes or removes the enabled flag for one server.
func (m *MCPFile) SetServerEnabled(name string, enabled bool) error {
	return m.Update(func(root *Value) error {
		entry, err := mcpEntry(root, name)
		if err != nil {
			return err
		}
		if enabled {
			entry.Delete("enabled")
		} else {
			entry.SetBool("enabled", false)
		}
		return nil
	})
}

// SetServerExposure sets the tool exposure mode for one server.
func (m *MCPFile) SetServerExposure(name, exposure string) error {
	switch exposure {
	case "codemode", "deferred", "direct", "hidden", "auto":
	default:
		return &TypeError{Path: m.path, Key: "exposure", Expected: "one of codemode, deferred, direct, hidden, auto", Got: KindString}
	}
	return m.Update(func(root *Value) error {
		entry, err := mcpEntry(root, name)
		if err != nil {
			return err
		}
		if exposure == "auto" {
			entry.Delete("exposure")
		} else {
			entry.SetString("exposure", exposure)
		}
		return nil
	})
}

// RemoveServer deletes one server entry.
func (m *MCPFile) RemoveServer(name string) error {
	return m.Update(func(root *Value) error {
		container := root.Get("mcpServers")
		if container == nil || !container.IsObject() {
			return &TypeError{Path: m.path, Key: "mcpServers", Expected: "an object", Got: KindNull}
		}
		if !container.Delete(name) {
			return &TypeError{Path: m.path, Key: "mcpServers", Expected: "an entry named " + name, Got: KindNull}
		}
		return nil
	})
}

func mcpEntry(root *Value, name string) (*Value, error) {
	container := root.Get("mcpServers")
	if container == nil || !container.IsObject() {
		return nil, &TypeError{Key: "mcpServers", Expected: "an object", Got: KindNull}
	}
	entry := container.Get(name)
	if entry == nil || !entry.IsObject() {
		return nil, &TypeError{Key: "mcpServers", Expected: "an object entry named " + name, Got: KindNull}
	}
	return entry, nil
}

// Transport describes how pi reaches the server.
func (s MCPServer) Transport() string {
	if s.URL != "" {
		return "http: " + s.URL
	}
	if s.Command != "" {
		return "stdio: " + s.Command
	}
	return "unknown"
}

// Find returns one server by name.
func (m *MCPFile) Find(name string) (MCPServer, bool) {
	for _, server := range m.Servers() {
		if server.Name == name {
			return server, true
		}
	}
	return MCPServer{}, false
}
