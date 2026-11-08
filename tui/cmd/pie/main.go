// Command pie is a thin terminal client for the pi coding agent.
//
// It never embeds the agent: it starts the `pi` binary in RPC mode and speaks
// newline-delimited JSON over stdin/stdout.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lihaozhe013/pie/tui/internal/bridge"
	"github.com/lihaozhe013/pie/tui/internal/rpc"
	"github.com/lihaozhe013/pie/tui/internal/ui"
)

// version is overridden at build time with -ldflags "-X main.version=...".
var version = "dev"

const (
	exitOK      = 0
	exitFailure = 1
	exitMissing = 2

	// binEnv overrides the pi executable path.
	binEnv = "PIE_PI"
)

type config struct {
	bin         string
	provider    string
	model       string
	name        string
	session     string
	sessionDir  string
	cwd         string
	noSession   bool
	noMouse     bool
	debug       bool
	showHelp    bool
	showVersion bool
}

func main() {
	os.Exit(run(os.Args[1:], os.Stderr))
}

func run(args []string, stderr io.Writer) int {
	cfg, err := parseFlags(args, stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		fmt.Fprintf(stderr, "pie: %v\n", err)
		return exitMissing
	}
	if cfg.showVersion {
		fmt.Fprintf(stderr, "pie %s\n", version)
		return exitOK
	}

	piBinary, err := resolvePi(cfg.bin)
	if err != nil {
		printDependencyHelp(stderr, err)
		return exitMissing
	}

	cwd, err := enterWorkingDir(cfg.cwd)
	if err != nil {
		fmt.Fprintf(stderr, "pie: %v\n", err)
		return exitFailure
	}

	logger, closeLog := newLogger(cfg.debug, stderr)
	defer closeLog()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()

	extensionPath := ""
	if state, stateErr := stateDir(); stateErr == nil {
		if extension, ensureErr := bridge.Ensure(state); ensureErr == nil {
			extensionPath = extension
			logger.logf("bridge extension: %s", extension)
		} else {
			logger.logf("bridge extension unavailable: %v", ensureErr)
		}
	}

	piCommand := piArgs(cfg)
	if extensionPath != "" {
		piCommand = append(piCommand, "-e", extensionPath)
	}

	client, err := rpc.Start(ctx, rpc.Options{
		Bin:    piBinary,
		Args:   piCommand,
		Dir:    cwd,
		Stderr: nil,
		Logf:   logger.logf,
	})
	if err != nil {
		fmt.Fprintf(stderr, "pie: could not start %s: %v\n", piBinary, err)
		return exitFailure
	}

	restartConfig := cfg
	restartConfig.session = ""
	restartConfig.name = ""
	restartArgs := piArgs(restartConfig)
	if extensionPath != "" {
		restartArgs = append(restartArgs, "-e", extensionPath)
	}
	restart := func(dir string) (ui.Client, error) {
		return rpc.Start(ctx, rpc.Options{
			Bin:  piBinary,
			Args: restartArgs,
			Dir:  dir,
			Logf: logger.logf,
		})
	}

	model := ui.New(client, ui.Options{
		SessionDir: cfg.sessionDir,
		CWD:        cwd,
		Version:    version,
		PiBin:      piBinary,
		Restart:    restart,
		Mouse:      !cfg.noMouse,
	})

	options := []tea.ProgramOption{
		tea.WithAltScreen(),
		tea.WithContext(ctx),
	}
	if !cfg.noMouse {
		options = append(options, tea.WithMouseCellMotion())
	}

	program := tea.NewProgram(model, options...)
	if _, err := program.Run(); err != nil && !errors.Is(err, context.Canceled) {
		logger.logf("ui: %v", err)
		if tail := client.StderrTail(); len(tail) > 0 {
			fmt.Fprintf(stderr, "pi: %s\n", tail[len(tail)-1])
		}
		_ = client.Close()
		return exitFailure
	}

	// The alternate screen is gone, so the card printed here stays visible at
	// the shell prompt and records which conversation was just left.
	fmt.Fprint(os.Stdout, "\n"+model.ExitSummary()+"\n")

	shutdownStart := time.Now()
	if err := client.Close(); err != nil {
		logger.logf("shutdown: %v", err)
	}
	logger.logf("shutdown complete in %s", time.Since(shutdownStart).Round(time.Millisecond))
	return exitOK
}

func parseFlags(args []string, stderr io.Writer) (config, error) {
	var cfg config

	fs := flag.NewFlagSet("pie", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&cfg.bin, "pi", "", "path to the pi binary (default: $"+binEnv+" or pi on PATH)")
	fs.StringVar(&cfg.provider, "provider", "", "provider passed to pi")
	fs.StringVar(&cfg.model, "model", "", "model passed to pi")
	fs.StringVar(&cfg.name, "name", "", "session name passed to pi")
	fs.StringVar(&cfg.session, "session", "", "session file to resume")
	fs.StringVar(&cfg.sessionDir, "session-dir", "", "session storage directory")
	fs.StringVar(&cfg.cwd, "cwd", "", "working directory for the session (default: current directory)")
	fs.BoolVar(&cfg.noSession, "no-session", false, "run without persisting a session")
	fs.BoolVar(&cfg.noMouse, "no-mouse", false, "disable mouse capture (wheel scrolling and in-app selection)")
	fs.BoolVar(&cfg.debug, "debug", false, "write protocol diagnostics to the state directory")
	fs.BoolVar(&cfg.showVersion, "version", false, "print the version and exit")

	fs.Usage = func() {
		fmt.Fprintf(stderr, "pie %s - a thin terminal client for pi\n\n", version)
		fmt.Fprintf(stderr, "usage: pie [flags]\n\nflags:\n")
		fs.PrintDefaults()
	}

	if err := fs.Parse(args); err != nil {
		return cfg, err
	}
	if fs.NArg() > 0 {
		return cfg, fmt.Errorf("unexpected arguments: %v", fs.Args())
	}
	return cfg, nil
}

// resolvePi finds the pi executable without embedding anything.
func resolvePi(explicit string) (string, error) {
	candidate := explicit
	if candidate == "" {
		candidate = os.Getenv(binEnv)
	}
	if candidate == "" {
		candidate = "pi"
	}

	path, err := exec.LookPath(candidate)
	if err != nil {
		return "", fmt.Errorf("%s not found on PATH", candidate)
	}
	return path, nil
}

func piArgs(cfg config) []string {
	args := []string{"--mode", "rpc"}
	if cfg.provider != "" {
		args = append(args, "--provider", cfg.provider)
	}
	if cfg.model != "" {
		args = append(args, "--model", cfg.model)
	}
	if cfg.name != "" {
		args = append(args, "--name", cfg.name)
	}
	if cfg.session != "" {
		args = append(args, "--session", cfg.session)
	}
	if cfg.sessionDir != "" {
		args = append(args, "--session-dir", cfg.sessionDir)
	}
	if cfg.noSession {
		args = append(args, "--no-session")
	}
	return args
}

// enterWorkingDir changes into the requested directory so the client, the pi
// child, and every relative configuration path agree. It returns the resolved
// absolute directory.
func enterWorkingDir(dir string) (string, error) {
	if dir == "" {
		return os.Getwd()
	}
	if dir == "~" || strings.HasPrefix(dir, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home directory: %w", err)
		}
		if dir == "~" {
			dir = home
		} else {
			dir = filepath.Join(home, dir[2:])
		}
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("resolve working directory: %w", err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", fmt.Errorf("working directory: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("working directory %s is not a directory", absolute)
	}
	if err := os.Chdir(absolute); err != nil {
		return "", fmt.Errorf("change working directory: %w", err)
	}
	return absolute, nil
}

func printDependencyHelp(stderr io.Writer, err error) {
	fmt.Fprintf(stderr, "pie: %v\n\n", err)
	fmt.Fprintln(stderr, "pie is a host shell and needs the pi CLI installed:")
	fmt.Fprintln(stderr, "  npm install -g @earendil-works/pi-coding-agent")
	fmt.Fprintln(stderr, "")
	fmt.Fprintln(stderr, "Point the client at a specific binary instead:")
	fmt.Fprintf(stderr, "  pie --pi <path-to-pi>  (or set %s)\n", binEnv)
}

// debugLogger writes diagnostics to a file, never to stdout, because stdout is
// reserved for the TUI.
type debugLogger struct {
	file *os.File
}

func (l *debugLogger) logf(format string, args ...any) {
	if l == nil || l.file == nil {
		return
	}
	fmt.Fprintf(l.file, "%s ", time.Now().Format("15:04:05.000"))
	fmt.Fprintf(l.file, format, args...)
	fmt.Fprintln(l.file)
}

func newLogger(enabled bool, stderr io.Writer) (*debugLogger, func()) {
	if !enabled {
		return &debugLogger{}, func() {}
	}
	path, err := logPath()
	if err != nil {
		fmt.Fprintf(stderr, "pie: cannot resolve log directory: %v\n", err)
		return &debugLogger{}, func() {}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		fmt.Fprintf(stderr, "pie: cannot create log directory: %v\n", err)
		return &debugLogger{}, func() {}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		fmt.Fprintf(stderr, "pie: cannot open log file: %v\n", err)
		return &debugLogger{}, func() {}
	}
	logger := &debugLogger{file: file}
	logger.logf("pie %s started", version)
	fmt.Fprintf(stderr, "pie: logging to %s\n", path)
	return logger, func() { _ = file.Close() }
}

func stateDir() (string, error) {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(base, "pie"), nil
}

func logPath() (string, error) {
	dir, err := stateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "pie.log"), nil
}
