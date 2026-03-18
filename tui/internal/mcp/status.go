// Package mcp wraps the `pi mcp` CLI pieces the settings panel needs.
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Status is one server report from `pi mcp list --json`.
type Status struct {
	Name      string
	Scope     string
	State     string
	Transport string
	Tools     []string
	Resources bool
	Error     string
}

// Snapshot is one connection check.
type Snapshot struct {
	Servers []Status
	Errors  []string
	Note    string
}

// Check asks pi to connect to every configured server and report state.
func Check(ctx context.Context, bin, cwd string) (Snapshot, error) {
	if bin == "" {
		bin = "pi"
	}
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, bin, "mcp", "list", "--json")
	command.Dir = cwd
	command.Env = os.Environ()
	output, err := command.Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok && len(output) == 0 {
			message := strings.TrimSpace(string(exit.Stderr))
			if message != "" {
				return Snapshot{}, fmt.Errorf("%s", tail(message, 8))
			}
		}
		return Snapshot{}, err
	}
	var payload struct {
		Servers []struct {
			Name      string   `json:"name"`
			Scope     string   `json:"scope"`
			State     string   `json:"state"`
			Transport string   `json:"transport"`
			Tools     []string `json:"tools"`
			Resources bool     `json:"resources"`
			Error     string   `json:"error"`
		} `json:"servers"`
		Errors []any  `json:"errors"`
		Note   string `json:"note"`
	}
	if err := json.Unmarshal(output, &payload); err != nil {
		return Snapshot{}, fmt.Errorf("read pi mcp list: %w", err)
	}
	snapshot := Snapshot{Note: payload.Note}
	for _, item := range payload.Servers {
		snapshot.Servers = append(snapshot.Servers, Status{
			Name:      item.Name,
			Scope:     item.Scope,
			State:     item.State,
			Transport: item.Transport,
			Tools:     item.Tools,
			Resources: item.Resources,
			Error:     item.Error,
		})
	}
	for _, item := range payload.Errors {
		switch value := item.(type) {
		case string:
			snapshot.Errors = append(snapshot.Errors, value)
		case map[string]any:
			if message, ok := value["message"].(string); ok {
				snapshot.Errors = append(snapshot.Errors, message)
			} else {
				encoded, _ := json.Marshal(value)
				snapshot.Errors = append(snapshot.Errors, string(encoded))
			}
		default:
			encoded, _ := json.Marshal(value)
			snapshot.Errors = append(snapshot.Errors, string(encoded))
		}
	}
	return snapshot, nil
}

// Add installs a server with the CLI so its validation and file writes match
// `pi mcp add`. arguments is everything after "add".
func Add(ctx context.Context, bin, cwd string, arguments []string, local bool) (string, error) {
	args := append([]string{"mcp", "add"}, arguments...)
	if local {
		args = append(args, "-l")
	}
	return run(ctx, bin, cwd, args)
}

// Login starts the browser OAuth flow for one server.
func Login(ctx context.Context, bin, cwd, name string, local bool) (string, error) {
	args := []string{"mcp", "login", name}
	if local {
		args = append(args, "-l")
	}
	return run(ctx, bin, cwd, args)
}

// Logout deletes a server's stored OAuth credentials.
func Logout(ctx context.Context, bin, cwd, name string, local bool) (string, error) {
	args := []string{"mcp", "logout", name}
	if local {
		args = append(args, "-l")
	}
	return run(ctx, bin, cwd, args)
}

// Remove deletes a server from the file through the CLI.
func Remove(ctx context.Context, bin, cwd, name string, local bool) (string, error) {
	args := []string{"mcp", "remove", name}
	if local {
		args = append(args, "-l")
	}
	return run(ctx, bin, cwd, args)
}

func run(ctx context.Context, bin, cwd string, args []string) (string, error) {
	if bin == "" {
		bin = "pi"
	}
	ctx, cancel := context.WithTimeout(ctx, 150*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, bin, args...)
	command.Dir = cwd
	command.Env = os.Environ()
	output, err := command.CombinedOutput()
	clean := strings.TrimSpace(string(output))
	if err != nil {
		if clean != "" {
			return clean, fmt.Errorf("%s", tail(clean, 8))
		}
		return clean, err
	}
	return clean, nil
}

func tail(value string, count int) string {
	lines := strings.Split(strings.TrimSpace(value), "\n")
	if len(lines) > count {
		lines = lines[len(lines)-count:]
	}
	return strings.Join(lines, "\n")
}
