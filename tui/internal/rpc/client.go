package rpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

// Client errors.
var (
	// ErrClientClosed reports use of a client whose transport already stopped.
	ErrClientClosed = errors.New("rpc client closed")
	// ErrLineTooLong reports a stdout record larger than the configured limit.
	ErrLineTooLong = errors.New("rpc record exceeds maximum length")
)

const (
	defaultEventBuffer   = 256
	defaultMaxLineBytes  = 32 << 20 // 32 MiB
	shutdownGracePeriod  = 3 * time.Second
	terminateGracePeriod = 2 * time.Second
)

// Command is one JSONL command written to pi's stdin.
type Command map[string]any

// NewCommand starts a command of the given protocol type.
func NewCommand(kind string) Command {
	return Command{"type": kind}
}

// Options configures a Client.
type Options struct {
	// Bin is the pi executable. Empty means "pi", resolved from PATH.
	Bin string
	// Args are extra arguments passed to pi. "--mode rpc" is added when absent.
	Args []string
	// Dir is the working directory of the child process.
	Dir string
	// Env replaces the child environment when non-nil.
	Env []string
	// Stderr, when set, tees the child's diagnostics.
	Stderr io.Writer
	// EventBuffer is the capacity of the event channel. Defaults to 256.
	EventBuffer int
	// MaxLineBytes caps one stdout record. Defaults to 32 MiB.
	MaxLineBytes int
	// Logf receives protocol diagnostics. Nil disables logging.
	Logf func(format string, args ...any)
	// ShutdownGrace bounds the wait after stdin closes. Defaults to 3s.
	ShutdownGrace time.Duration
	// TerminateGrace bounds the wait after SIGTERM. Defaults to 2s.
	TerminateGrace time.Duration
}

// Client owns a `pi --mode rpc` child process.
//
// One goroutine reads stdout and writes frames into Events(); frames must be
// consumed continuously or the child can stall on a full pipe. Do correlates
// commands and responses by ID, so concurrent callers never race for replies.
type Client struct {
	opts Options
	cmd  *exec.Cmd

	stdin    io.WriteCloser
	writeMu  sync.Mutex
	pending  map[string]chan *Response
	pendMu   sync.Mutex
	sequence atomic.Uint64

	events   chan Event
	closeReq chan struct{}
	done     chan struct{}
	stderr   *tailBuffer

	closeOnce sync.Once
	closed    atomic.Bool
	finished  sync.Once

	errMu sync.Mutex
	err   error
}

// Start launches pi in RPC mode and begins reading its event stream.
func Start(ctx context.Context, opts Options) (*Client, error) {
	if opts.EventBuffer <= 0 {
		opts.EventBuffer = defaultEventBuffer
	}
	if opts.MaxLineBytes <= 0 {
		opts.MaxLineBytes = defaultMaxLineBytes
	}
	if opts.Bin == "" {
		opts.Bin = "pi"
	}
	if opts.Logf == nil {
		opts.Logf = func(string, ...any) {}
	}
	if opts.ShutdownGrace <= 0 {
		opts.ShutdownGrace = shutdownGracePeriod
	}
	if opts.TerminateGrace <= 0 {
		opts.TerminateGrace = terminateGracePeriod
	}

	args := normalizeArgs(opts.Args)
	cmd := exec.Command(opts.Bin, args...)
	cmd.Dir = opts.Dir
	if opts.Env != nil {
		cmd.Env = opts.Env
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("open pi stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("open pi stdout: %w", err)
	}

	tail := newTailBuffer(64)
	cmd.Stderr = tail
	if opts.Stderr != nil {
		cmd.Stderr = io.MultiWriter(tail, opts.Stderr)
	}

	setProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", opts.Bin, err)
	}

	client := &Client{
		opts:     opts,
		cmd:      cmd,
		stdin:    stdin,
		pending:  make(map[string]chan *Response),
		events:   make(chan Event, opts.EventBuffer),
		closeReq: make(chan struct{}),
		done:     make(chan struct{}),
		stderr:   tail,
	}

	// A cancelled context means the caller gave up while starting.
	stop := context.AfterFunc(ctx, func() { _ = client.Close() })

	go func() {
		defer stop()
		client.readLoop(stdout)
	}()

	return client, nil
}

func normalizeArgs(args []string) []string {
	mode := []string{"--mode", "rpc"}
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--mode" && args[i+1] == "rpc" {
			return args
		}
	}
	return append(mode, args...)
}

// Events returns the inbound event stream. The channel closes when the child
// exits or the client is closed.
func (c *Client) Events() <-chan Event { return c.events }

// Done is closed once the child process finished and the event stream drained.
func (c *Client) Done() <-chan struct{} { return c.done }

// Err reports why the child stopped. It is nil after a clean shutdown.
func (c *Client) Err() error {
	select {
	case <-c.done:
		c.errMu.Lock()
		defer c.errMu.Unlock()
		return c.err
	default:
		return nil
	}
}

// StderrTail returns the last diagnostic lines written by the child.
func (c *Client) StderrTail() []string { return c.stderr.Lines() }

// PID reports the child process ID, or 0 after it exited.
func (c *Client) PID() int {
	if c.cmd.Process == nil {
		return 0
	}
	return c.cmd.Process.Pid
}

// Do writes one command and waits for its response.
//
// The command ID is generated when the caller did not set one. The returned
// response is never nil when err is nil, but success must still be checked: a
// failed command reports Success false.
func (c *Client) Do(ctx context.Context, command Command) (*Response, error) {
	if command == nil {
		return nil, errors.New("rpc: nil command")
	}
	if kind, _ := command["type"].(string); kind == "" {
		return nil, errors.New("rpc: command without type")
	}

	id, _ := command["id"].(string)
	if id == "" {
		id = fmt.Sprintf("req-%d", c.sequence.Add(1))
		command["id"] = id
	}

	reply := make(chan *Response, 1)
	c.pendMu.Lock()
	if c.closed.Load() {
		c.pendMu.Unlock()
		return nil, ErrClientClosed
	}
	c.pending[id] = reply
	c.pendMu.Unlock()
	defer c.forget(id)

	if err := c.write(command); err != nil {
		return nil, err
	}

	select {
	case response := <-reply:
		if response == nil {
			return nil, ErrClientClosed
		}
		return response, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("%w: %w", ErrRequestTimeout, ctx.Err())
	case <-c.done:
		return nil, c.exitError()
	}
}

// Send writes a command without waiting for a response.
//
// Use it for records that never produce one, such as extension_ui_response.
func (c *Client) Send(command Command) error {
	if command == nil {
		return errors.New("rpc: nil command")
	}
	if kind, _ := command["type"].(string); kind == "" {
		return errors.New("rpc: command without type")
	}
	return c.write(command)
}

// DoOK is Do with an error for unsuccessful responses.
func (c *Client) DoOK(ctx context.Context, command Command) (*Response, error) {
	response, err := c.Do(ctx, command)
	if err != nil {
		return nil, err
	}
	if !response.Success {
		if response.Error == "" {
			return response, fmt.Errorf("rpc: command %s failed", response.Command)
		}
		return response, fmt.Errorf("rpc: command %s failed: %s", response.Command, response.Error)
	}
	return response, nil
}

// Close asks pi to shut down, then escalates to signals when it does not.
//
// Closing stdin is the documented orderly shutdown; pi disposes the runtime and
// exits. Close never blocks longer than the grace periods below and is safe to
// call more than once.
func (c *Client) Close() error {
	c.closeOnce.Do(func() {
		close(c.closeReq)
		c.closed.Store(true)

		_ = c.stdin.Close()
		if c.wait(c.opts.ShutdownGrace) {
			return
		}

		c.opts.Logf("rpc: pi did not exit after stdin close, terminating")
		_ = terminateProcess(c.cmd)
		if c.wait(c.opts.TerminateGrace) {
			return
		}

		c.opts.Logf("rpc: pi ignored termination signal, killing")
		_ = c.cmd.Process.Kill()
		c.wait(c.opts.TerminateGrace)
	})
	return nil
}

func (c *Client) wait(timeout time.Duration) bool {
	if timeout <= 0 {
		select {
		case <-c.done:
			return true
		default:
			return false
		}
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-c.done:
		return true
	case <-timer.C:
		return false
	}
}

func (c *Client) readLoop(stdout io.Reader) {
	reader := bufio.NewReaderSize(stdout, 64*1024)
	defer func() {
		close(c.events)
		waitErr := c.cmd.Wait()
		c.finish(waitErr)
	}()

	for {
		line, err := readLine(reader, c.opts.MaxLineBytes)
		if len(line) > 0 {
			c.handleLine(line)
		}
		if err == nil {
			continue
		}
		if errors.Is(err, ErrLineTooLong) {
			c.opts.Logf("rpc: dropped oversized stdout record")
			continue
		}
		if !errors.Is(err, io.EOF) {
			c.opts.Logf("rpc: stdout read error: %v", err)
			c.setErr(err)
		}
		return
	}
}

func (c *Client) handleLine(line []byte) {
	event, err := ParseLine(line)
	if err != nil {
		c.opts.Logf("rpc: %v", err)
		return
	}

	if response, ok := event.(*Response); ok && response.ID != "" {
		c.pendMu.Lock()
		reply, waiting := c.pending[response.ID]
		delete(c.pending, response.ID)
		c.pendMu.Unlock()
		if waiting {
			reply <- response
			return
		}
		c.opts.Logf("rpc: response for unknown request %q", response.ID)
	}

	select {
	case c.events <- event:
	case <-c.closeReq:
	}
}

func (c *Client) write(command Command) error {
	payload, err := json.Marshal(command)
	if err != nil {
		return fmt.Errorf("encode command: %w", err)
	}
	payload = append(payload, '\n')

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed.Load() {
		return ErrClientClosed
	}
	if _, err := c.stdin.Write(payload); err != nil {
		return fmt.Errorf("write command: %w", err)
	}
	return nil
}

func (c *Client) forget(id string) {
	c.pendMu.Lock()
	delete(c.pending, id)
	c.pendMu.Unlock()
}

func (c *Client) finish(waitErr error) {
	c.finished.Do(func() {
		if waitErr != nil && !isExitOK(waitErr) {
			c.setErr(waitErr)
		}
		c.pendMu.Lock()
		for id, reply := range c.pending {
			delete(c.pending, id)
			close(reply)
		}
		c.pendMu.Unlock()
		close(c.done)
	})
}

func (c *Client) setErr(err error) {
	c.errMu.Lock()
	if c.err == nil {
		c.err = err
	}
	c.errMu.Unlock()
}

func (c *Client) exitError() error {
	if err := c.Err(); err != nil {
		return fmt.Errorf("%w: %w", ErrClientClosed, err)
	}
	return ErrClientClosed
}

func isExitOK(err error) bool {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		// pi exits non-zero when the session is torn down by a signal we sent.
		return exitErr.ExitCode() == -1
	}
	return false
}

// ErrRequestTimeout wraps the caller context error of a failed Do.
var ErrRequestTimeout = errors.New("rpc request timeout")

// readLine reads one LF-terminated record without ever treating Unicode line or
// paragraph separators as boundaries.
//
// Records larger than limit are consumed and discarded so the stream stays in
// sync; the caller receives ErrLineTooLong afterwards.
func readLine(reader *bufio.Reader, limit int) ([]byte, error) {
	if limit <= 0 {
		limit = defaultMaxLineBytes
	}
	var (
		buf     []byte
		tooLong bool
	)

	for {
		chunk, err := reader.ReadSlice('\n')
		if !tooLong {
			if len(buf)+len(chunk) > limit {
				tooLong = true
				buf = nil
			} else {
				buf = append(buf, chunk...)
			}
		}

		switch {
		case err == nil:
			if tooLong {
				return nil, ErrLineTooLong
			}
			return bytes.TrimRight(buf, "\r\n"), nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		default:
			if tooLong {
				return nil, ErrLineTooLong
			}
			return bytes.TrimRight(buf, "\r\n"), err
		}
	}
}

// tailBuffer keeps the last n diagnostic lines of the child process.
type tailBuffer struct {
	mu    sync.Mutex
	limit int
	lines []string
	carry []byte
}

func newTailBuffer(limit int) *tailBuffer {
	return &tailBuffer{limit: limit}
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.carry = append(t.carry, p...)
	for {
		index := bytes.IndexByte(t.carry, '\n')
		if index < 0 {
			break
		}
		line := string(bytes.TrimRight(t.carry[:index], "\r"))
		t.carry = append(t.carry[:0], t.carry[index+1:]...)
		if line == "" {
			continue
		}
		t.lines = append(t.lines, line)
		if len(t.lines) > t.limit {
			t.lines = t.lines[1:]
		}
	}
	return len(p), nil
}

func (t *tailBuffer) Lines() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]string, len(t.lines))
	copy(out, t.lines)
	return out
}
