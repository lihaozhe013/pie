# Project Instructions

## Product boundary

`pie` is a UX layer over Pi: presentation, navigation, and configuration convenience. It must not
change how Pi executes work. No subagents, no parallel agent runs, no second tool or session
protocol, and no feature that alters the agent loop. The client stays thin: the conversation, tools,
and sessions belong to the `pi` binary.

## Testing

- **AI agents are strictly forbidden from performing any kind of testing.**
  Do not run `go test`, `make test`, test scripts, or any automated checks
  whose purpose is testing.
- **AI agents are also forbidden from manual testing.** Do not drive the TUI
  in a terminal or `tmux`, do not run the binary against fake processes, and
  do not exercise changes to verify them. Never simulate a user session.
- **All testing is done by the human user, and only by the human user.**
  The agent's job ends when the code change is written; verification is
  exclusively the user's responsibility.
- Compiling (`go build ./...`) to confirm the code is well-formed is not a
  test and is allowed.
