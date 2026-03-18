# Interface Principles

## Conversation is the workspace

The interface should feel like a carefully organized agent conversation, not a developer dashboard.
Keep frequent actions nearby and reveal secondary information on demand.

The current layout uses a session sidebar, a central conversation and composer, and an optional
information sidebar opened from the toolbar. The page header carries the workspace switch. Project
groups help locate conversations; they are not project management. A new session chooses a working
directory; Git repository relationships do not change its identity.

The right panel is dedicated exclusively to Runs and execution context (including Goal and
Compaction status) and opens at the sidebar's default width, 260px. It is part of the default
desktop page: it is open on load, before any command runs, and only the user's own collapse in that
page closes it. It overlays the conversation when space is limited and fills phone widths; there it
starts closed so the conversation stays visible, and opens only when the user asks for it. Docked,
its left edge is a resize handle: the panel stretches between 220px and the width that still leaves
the conversation 420px, and it gives way to a sidebar that grows, returning to the size the user
chose when there is room again. That size is remembered in the browser and kept while a smaller
window shows less. The separator takes keyboard focus: the arrow keys resize, `Home` and `End` reach
the limits, and Enter or a double click restores the default. Settings hides the panel without
collapsing it, so closing Settings brings it back. A panel-icon toggle at the toolbar's right edge —
the sidebar's toggle mirrored — reopens a closed panel, and the panel header also includes a
collapse button. A surface that belongs to the default page — the Runs panel — never takes focus;
one the user opens does.

The panel also carries the session actions, as one quiet group above the runs: full history,
generate title, branches when the session has them, system prompt, and tool definitions, plus a
statistics card with input, output, cache read, cost, and the context bar. They describe the session
rather than the next message, and every one of them opens a focused dialog above the conversation:
the dialog is still the place to read, not the panel. The card's tooltip keeps the full breakdown;
the panel keeps only what fits. Collapsing the panel, or opening the conversation on a phone where
the panel starts closed, leaves the actions one click away behind the toolbar's right-edge toggle.
Active goals and compaction state report inside the Runs panel rather than below the chat input,
keeping the main composer clean. The composer options button (`...`) sits in the right toolbar
between the tools preset selector and the sound toggle.

The sidebar's session list scrolls; what belongs to the whole list rather than to one project sits
below it, outside that scroll: the archive's entry holds the bottom edge above the sidebar's own
footer, stays reachable however many projects there are, and reads as the end of the list (a
hairline above it, the count where the rows end) instead of as another project group. It opens the
archive view, which keeps its own bar with Back, the count and its actions; the entry is not shown
over that view, and it is not shown at all while nothing is archived.

## Two workspaces, one shell

The page header carries one segmented control, `Chat | Tasks`, after the sidebar toggle. It is the
only place the two workspaces are chosen: a single choice is active at a time, the active segment is
marked by surface, weight, and accent icon as well as by `aria-current`, and each segment is an
ordinary link to a real URL (`/` and `/?mode=tasks`). Reload, open in new tab, and the Web Push deep
links all land in the right workspace.

The shell does not move between the views. The sidebar keeps its place and its width; in chat it
lists conversations, and in tasks it lists projects. The sidebar toggle and the switch keep their
position in the toolbar, and the right-hand inspector swaps its content: Runs in chat, the Queue in
tasks. Both use the same docked column, width and collapse language, so the center's edge does not
move when the workspace changes. A project picked in the task sidebar switches the board to that
queue; the `Chat` segment returns to the conversation the active project last had open. Settings stays where it always is, in
the sidebar's footer, so the task view has no second Settings entry and no second header row of its
own. Phones keep the same control with shorter padding.

The sidebar's wordmark opens About in a modal over the conversation: the logo, the build's version
and commit, the Pi release in use, the license, and links to the source and to Pi. The wordmark is
plain text; its hover and focus ring show it is a control, and its accessible name says it opens
About. About is a traditional panel: one centered column of logo, name, tagline, version, facts and
links, without cards, frames or gradients.

## The task workspace

`?mode=tasks` replaces the conversation with the per-project task board described in
[Tasks](tasks.md), chosen from the page's `Chat | Tasks` switch. It keeps the app's sidebar frame
and toolbar: the left panel becomes a project list, the center column is the work surface that reads
the selected task or chat, and the same right-hand column that carries Runs in chat carries the
board here. The board has a Chats section above the queue groups, because a conversation is project
work too. A conversation that has a queue task is represented by that task, so the same work never
appears twice. A fresh conversation is visible as a "New chat" row before its first message is
persisted, because task mode includes transient draft runtimes.

The project panel is the task workspace's navigator. Each row is one working directory: its name,
the running task or chat, a status dot and the number queued; projects with a running chat, running
or paused task, or queued work sit in an Active section above the rest. A project with tasks but no
conversation is still a row. "Add project" opens the same directory picker the task form uses. A
click switches `?cwd=`, and the board and the selection move together; a running chat is selected
automatically, so the project that needs attention is the one on screen. The panel uses the
conversation sidebar's header and row language, not a second navigation style.

The queue panel is docked on desktop, open until the person collapses it, and resizable from its
left edge with the same handle, limits and remembered width as the Runs panel. Its own header closes
it. A `Task board` chip in the task bar shows its size and running mark while the panel is closed, and
reopens it; the chip is not repeated while the panel is open, exactly like the Runs panel's toggle.
Settings hides the panel without collapsing it, so closing Settings brings it back, and the queue's
own collapse choice is independent of the Runs panel's.

A chat row uses the same status marker, title, working directory, and message count as a queue
task, with a status word on the right; running chats sort first. Selecting it opens a compact
summary with an "Open chat" action, and double-clicking opens the conversation directly. A queue row
also carries — once it has run — its attempts and elapsed time. The group heading names queued,
running, and blocked work; finished rows live in the separate Finished drawer, and a failed row
names its status because its group also holds blocked ones. The row the surface is reading carries a tint and an accent bar at its left edge; its
`⋯` menu appears on hover, focus, and on the active row, and also opens on right-click at the pointer
and from `Shift+F10`. The arrow keys reorder it inside the pending segment, Enter edits, and Delete
removes it. A running task is locked, and the controls say why.

The task bar above the work surface starts with the project's name and path, so the board is never
ambiguous. Its status cluster puts the queue state (Idle, Running, or Paused) next to the
Standard/Autonomous mode chip, because both describe the current work rather than a setting. A
paused reason and a watching mark stay inline there instead of taking separate banner rows. The
right side keeps the model chip and a row of icon controls: queue defaults, one
primary Start/Pause/Resume control that follows the state, a Stop control, and an add-task plus.
Icon-only controls carry an accessible name and the same tooltip as their visible label. New task
is strong only when the board is empty; otherwise the primary run control is the one strong button.
Starting a queue while a conversation runs is allowed: the queue reports RUNNING, waits for the
conversation to end, and never blocks chat. A slider button opens the global task defaults — model,
timeouts, verification commands, the Autonomous decision mode switch, and the standing task
instructions — in the app's standard dialog shell, with its actions (including "Restore defaults")
pinned to the bottom while the body scrolls. A timeout is a number plus a unit, or an explicit
"No limit" chip that replaces the number with `∞`; the unit converts the number, and the form never
relies on a browser tooltip for a bad value.

Finished work folds into one Finished drawer at the bottom of the queue panel, mirroring the chat
sidebar's archive. Its header keeps the count and the clear-finished action reachable while the
list is closed; opening it reveals the completed rows newest first, and the fold is remembered in
the browser.

The work surface reads one task: its title, a status line with attempts and elapsed time, the
description, and a facts sheet for the working directory, result, verification output, verification
commands, and the linked session. A selected chat instead shows its session id, last activity,
message count, and an Open chat action. The pending question, the running activity line, and the
collapsed live tail sit in the same surface. The task's actions follow that content in a footer that
sticks to the bottom edge while a long tail scrolls. When nothing is selected — including an empty
board — the surface explains what it shows and offers New task, rather than leaving a blank column.

Shift+click extends a selection, Command/Ctrl+click adds one row, so bulk work does not require a
checkbox column that would compete with the status marker. A multi-selection replaces the task
reading with the batch actions and names the count in the surface, because a tint alone is not a
state. Removing several tasks, completed ones included, asks once in the same popover the row menu
uses: the queue has no undo, but the sessions themselves are only linked, never deleted.

The board polls: once a second while any queue or chat runs, or a question waits, otherwise every
five seconds, never while the page is hidden, and once when it returns. Task mode also polls live
session ids, so a new conversation becomes a task-shaped row without a reload. Every poll returns
all project summaries, so the project panel stays current without one request per project. A waiting `ask_user` question renders
through the same panel the composer uses, above the work surface and inside the task's pane, so a
reload or a Web Push notification still finds it. Opening the task's session leaves the workspace
for the ordinary conversation view, where the live transcript is readable and the composer is
disabled until the task finishes. Where
the panel cannot dock, the queue takes the center column and the work surface becomes a full-height
sheet with its own bar and Close button, so the queue stays the page's navigator.

Nothing about this workspace changes the chat view when the parameter is absent. `?mode=tasks`
deliberately skips the remembered-session restore so a reload stays in the task workspace, while
`?cwd=<path>` opens one project and `?task=<id>` opens one task directly (resolving its project when
`cwd` is absent). The per-tab mode memory remains unbuilt.

## Quiet, clear, polished

- Use soft surfaces, restrained corners, and useful whitespace rather than many borders.
- Prioritize readable conversation text; the current default baseline is 16px.
- Use semantic theme variables instead of building another hard-coded skin.
- Do not communicate state through color alone. Keep keyboard focus visible.
- Animate only to explain changes and honor reduced-motion preferences.
- Prefer a good default over unnecessary appearance settings.

## Settings and appearance

Settings stays in a modal over the conversation. Desktop navigation uses a left-hand category list;
phones use a category picker. General contains behavior and language, including how much of a run
the transcript shows; Appearance contains themes, fonts, sizes, conversation width and a live
preview. The theme gallery is a native disclosure, collapsed initially to keep font controls near
the top; a theme search result opens it automatically. Visited categories stay mounted so switching
does not discard an editor's draft.

Interface size (15px default), chat text size (16px) and monospace content size (12px) are
independent. UI text retains its hierarchy relative to the interface baseline. Large UI sizes also
grow virtual session rows. Chat text controls messages and the composer; monospace size controls
inline code, code blocks, diffs and tool output. Font names and weights remain separate for UI and
monospace. The preview reuses the Markdown renderer and code/output styles. Changes are immediate
and stored only in the browser; font-group resets leave the other font and chat size alone.

The settings search matches translated names, descriptions and English/Chinese aliases across
categories. Appearance and general controls have stable destinations; management categories remain
entry points to their own editors and content searches. It does not index configuration values,
credentials, sessions or remote catalogues. Conditional results explain project, platform or sign-in
requirements. Selecting a result focuses and reveals its destination without changing its value.
Escape first clears an active search, then closes Settings on the next press.

## Execution feedback

Show what the agent is doing, whether it finished, and what went wrong without filling the
conversation with every low-level event.

The live run status is one row directly above the composer, outside the transcript: provider
waiting, thinking, reading, execution and compaction report there, aligned to the composer's content
width. It stays visible while the user scrolls history, and its fixed single-line height keeps the
composer still. Concurrent work is summarized as one line (`Reading 3 files · Running bun test`): a
kind with a single running call keeps its concrete detail, a kind with several becomes a count, and
the full text remains in the tooltip. A call the model is still writing is named by its tool
(`Preparing edit…`) instead of leaving the row empty until execution starts. The row also carries
the run's elapsed time, counted from its prompt for the whole run — waits, retries and compaction
included — and frozen at its reading while the row fades out. While reasoning or a call's arguments
stream, the row also carries the reply's live tokens-per-second — the same measurement the streaming
message's header badge shows — and it hides whenever the model is silent. The session statistics
popover shows end-to-end output speed including first-token waits, and approximate streamed output
speed after the first nonempty text, thinking, or tool-argument delta. The streamed metric shows its
response count and excludes responses shorter than 500 ms, missing usage, and older responses
without recorded stream timing. Provider-reported output includes the first chunk and may include
hidden reasoning, so this is not a precise model decode benchmark. A finished turn reports its own
totals once, beside its time: the tokens it billed under the final answer (the hover spells them
out), or in the process group's header when the turn has one. The row keeps its height for the whole
run, dropping only the text while a visible answer streams, so the composer never moves mid-run. It
disappears when the run ends.

Compaction reports the same way. A manual compaction runs without a prompt, so the row opens for it
too and says `Compacting context…` with the elapsed clock running; the result replaces the row's
words as it fades — `Compacted 128k → 41k tokens (87k saved)` — instead of a banner above the
composer. The composer carries no compact button that morphs into a second progress pill: while a
compaction runs the send button becomes **Stop**, the same place a run is stopped, because a
compaction holds the session the way a run does. A compaction error stays a dismissible alert above
the composer, where an error cannot be missed by not opening anything.

Current main-transcript behavior:

- Thinking and exploration calls (`read`, `grep`, `find`, `ls`) draw no card: the composer status
  row carries them while they run, naming the file, search pattern, or directory. The Runs panel
  keeps their history like any other run.
- A tool card appears when the call actually starts executing, and not while the model is still
  writing its arguments: a half-streamed JSON blob would intrude, while a running call's card is the
  progress the user asked for. Writes, edits, and patches are the only calls that keep such a card
  when the cards setting below is on.
- Every other call draws no card in the transcript, running, successful or failed. The composer
  status row names it while it runs, and the Runs panel keeps its history: the panel is part of the
  default page, so it is already open, and the toolbar's panel toggle appears only while it is
  closed. It stays open across sessions and turns; a run never reopens a panel the user collapsed,
  and a reload restores the default. Where the sidebar would overlay the conversation the panel
  starts closed, so a phone shows the conversation; the toggle or a phone action opens it there. The
  panel separates active runs from history, with independent scrolling and newest first in each.
  History starts collapsed into a compact footer, leaving the active area more room; its heading
  toggles the section, and the choice stays in effect when the panel is closed and reopened. An
  expanded history is resizable from its top edge, which is a separator like the panel's: the
  history keeps the height the user drags to, between 120px and the room that leaves the active list
  its title and a card, the active list takes the rest, and the height is remembered in the browser.
  Active cards default open; completed cards remain in the active section for two seconds, showing
  their final status, then move to history and default closed. Multiple runs can remain active at
  once. Active and historical cards use blue for running, green for success, and red for errors,
  alongside status words and marks; cancelled runs remain neutral. Codemode's nested calls use their
  own status colors as compact subcards ahead of a script disclosure. Closing the panel does not
  discard anything.
- Write/edit/patch cards default to expanded. A write that replaces a file shows the changed lines
  as a diff; its final content is not repeated. Diffs draw inline: the removed line above the line
  that replaces it, one column a narrow card fits. `Show diffs side by side` in Settings › General
  switches them to two columns; a phone stays inline whatever it says. The choice is a browser
  preference, display only.
- Settings › General chooses where those cards live
  (`Show write and edit cards in the conversation`, off by default). With it off the transcript
  carries the user's messages and the agent's replies and nothing else, so a reader who never
  inspects the agent's code sees only the conversation. The panel keeps the writes and edits
  like any other run, showing the diff a card would have shown, opened while the run is active and
  through its two-second reading hold, then folded into history. Such a run names the file it
  touched instead of repeating the whole file as arguments. Turning the setting on keeps the cards
  in the transcript. The choice is a browser preference, like
  the other chat options; it changes display only, never stored history, exports, or agent context.
- A turn that wrote files says so in one line (`3 files changed`) under its answer instead of
  listing them as chips: the Runs panel already names the files and carries their diffs.
- A command the user ran themselves (`!`) keeps its live card in the transcript, because its
  progress is the answer they asked for. It also appears in the Runs panel so the history is
  complete.
- Long run output in the Runs panel initially shows its last 40 lines, with access to all output.
- Explicit expansion choices override defaults for retained cards.
- Errors, truncation notices, and necessary warnings remain visible.

Visual filtering must not remove full history, export content, persisted data, or agent context.
Distinguish provider waiting, thinking, reading, execution, and compaction. Clear transient status
when a run ends. Partial output is not success: a running run stays running while its partial output
grows, and it is never shown as a finished result.

Load syntax highlighting on demand. Unknown languages and streaming input must remain readable
without it. Draw tool cards as borderless panes: a surface tint lifts the card off the transcript
and the code, diff or output inside it sits a shade deeper, so color rather than a frame separates
the body from the page. The Runs panel uses the same tinted card surfaces and inset output panes.

Motion explains a change; it never decorates one. A card fades in when its call starts, its status
mark fades when it changes, and its body folds open and shut. A user-run command that leaves after
its short reading hold fades and folds away where it stood. Only a card that lived in this page
moves: the card remembers whether the call was still running at mount, so restoring a session,
re-reading the same message, scrolling history or re-grouping a turn replays none of it. The run
status row above the composer is always in the stack: it folds open with the run, folds away when
the run ends, and only its words change in between, so the composer never jumps under the user's
cursor. In the Runs panel, new active cards fade in, their bodies fold when toggled, and completed
cards fade and fold out of the active section as their collapsed history cards appear. Restored
history does not replay entrance motion. All motion is opacity, transform or a box size;
`prefers-reduced-motion` makes the transitions instant without changing the two-second reading hold.

## Copying a turn

A turn carries one copy entry under its last message, always visible, never a hover-only fragment.
Per-message copy buttons are gone; a message keeps its own actions (edit, fork), and the space they
and the removed buttons used no longer separates the messages of one turn: they sit 10px apart,
while a turn keeps its own separation from the next.

The entry opens the sidebar's "New" dialog language with three scopes:

- **Conversation**: the prompt and the agent's replies, without tool calls.
- **Kept record**: the replies plus the writes, edits, and patches the default transcript shows,
  with their arguments and stored results. The scope describes that record, not the display mode in
  effect: a turn copies the same kept record whether its tool cards are on screen or in the Runs
  panel.
- **Execution log**: the kept record plus every other tool call the Runs panel lists, with the
  structured details a tool recorded.

Every scope leaves out thinking: it is how the agent worked, not what it did. Exploration calls
(`read`, `grep`, `find`, `ls`) join the execution log as ordinary runs. Tool arguments travel as
JSON and results as stored, so a reader can reopen the work in a new session or keep it in a
document. No scope guesses which failure was a typo; the conversation scope is how a reader leaves
execution noise behind.

A scope copies immediately and closes; a clipboard failure stays in the dialog with its reason and a
retry. Escape, the backdrop and the close button leave the turn unchanged, and focus returns to the
entry.

## Files attached to a prompt

A file dropped onto the chat, pasted from the clipboard, or picked with the composer's attach
button is copied into the working directory without replacing anything already there, and then
shown as a chip beside the composer. Images take the same path: a dropped or pasted picture is a
file like any other, and the agent reads it from disk at its own resolution. A pasted screenshot
arrives named `image.png`, so it is renamed to a timestamped `pasted-…` name before the upload —
otherwise the second screenshot would collide with the first and the chip would reference the
wrong picture; files copied in a file manager keep their own names. The chip carries an icon chosen
by extension (a PDF, a Word
document, the language of a code file, and a plain page for anything unrecognized), the file name,
and a remove button; it is announced as an attached file and its tooltip keeps the relative path.
Removing a chip only drops the reference: the copied file stays in the working directory. `@` typed
in the draft, the file tree's reference button, and line references keep inserting text, because
they belong to a sentence.

The chips are not text, but the prompt is unchanged: a send appends the `@path` mentions the chips
stand for, in chip order and quoted when the path contains spaces, so the agent sees exactly what
dropping a file used to type. A file already attached is not attached twice. Chips belong to the
draft, so parking or rekeying a session keeps them; a submission the agent rejects comes back as the
text it was, its mentions written out again.

## Tool presets in the composer

The composer's tool menu lists the built-in presets first, then the user's custom ones, each named
with its tool count, and ends with a single entry that opens Settings at the Tools section.
Autonomous is the built-ins' self-directed mode: full coding tools, omits `ask_user`, and prompt
guidance to decide and keep working. Orchestrator adds one project-scoped `task_manager` tool for
the queue of the session's own working directory. The control stays visible while a run is in
progress — showing which preset the turn uses — but is disabled so the preset cannot be switched
mid-run. The section lists the built-in presets read-only above the user's own, so the list doubles
as a reference, and shows an editor for the selected custom one: a name, the built-in combinations
to start from, one switch for keeping other installed extension tools, and checkboxes grouped into
coding and extension tools. Rows carry the tool's short description, including the goal, queue,
question, codemode, search, MCP, and other tools the session has registered; the queue tool is
opt-in. The draft stays local until Save replaces the whole list; Delete is a two-step button kept
apart from Save. Deleting a preset keeps the sessions pinned to its tools and resolves their label
to the configured defaults once the composer reloads its copy.

## Questions near the composer

Model-issued `ask_user` questions use a non-modal panel directly above the composer, aligned to its
content width. Options and a free-form answer share one panel; choosing an option does not submit it
until Send answer. The normal composer, its draft, and attachments remain independent. Collapsing or
Escape retains the pending question and local answer; Skip explicitly returns no answer. Submission
disables duplicate sends, retains the answer on transport failure, and offers an inline retry. Focus
is not stolen when a question arrives.

Long question bodies scroll within the panel. The footer stays reachable on narrow screens. The
pending question does not also show a raw tool card in the main transcript; completed results remain
inspectable and raw history is unchanged. Other extensions continue using their existing dialogs and
custom panels.

## The composer hub

The composer footer keeps the controls that shape the next message: attach, the model, the reasoning
level and the tool preset. Compaction acts on the session instead of one prompt, so it does not earn
a permanent slot beside those knobs.

The entry is an unmarked opener that reads **More** and opens one small dialog with one card,
**Compact**, in the shape the sidebar's **New** dialog uses: the card is the only strong element,
and the chrome around it stays flat. Compaction is one action, so its card acts at once and closes
the dialog: it states the session's context size (`64% of 200k`) and the last compaction's result,
then reports in the run status row above the composer. The card is disabled while a run holds the
session, and reads **Stop compaction** while a compaction is running. On phones the footer's own
expander is named **Controls**, so it never reads as this entry.

## Autonomous goals

The goal is written and managed in a dialog, never in an always-visible switch beside the model
picker. The composer's one opener — the dots entry that also holds compaction — opens on two cards,
**Compact** and **Goal**; the goal card opens the goal's own page. A session whose package registers
no goal command has no goal card, and a session with nothing to compact opens the dialog straight on
the goal. A new session offers the goal card before its first message too: the objective written
there becomes the conversation's first work, so the person need not send a message just to make the
card appear.

The goal page states where things stand and takes the commands: the package's status word, the
tokens it counted against the budget it was given, the objective, and one row of actions — **Start
goal** (or **Update goal**) with the objective, **Pause goal**, **Resume goal**, **Mark done**,
**Clear goal**, and **Stop run** while a run is holding the session. A goal that is running cannot
be re-worded: its objective is read-only until it is paused, so an edit never moves the target under
the run in flight. Escape leaves the goal page for the choices and only then closes the dialog; a
package word this build does not know is shown as written rather than guessed into a state.

The loop, the budget and the completion report belong to a Pi goal package, not to Pie. Pie ships
one (`pi-better-goal`) so the page is there on a fresh install, and a person who configures their
own goal package gets that one instead. Labels name the state rather than the mechanism, because
what the commands start is the package's work, and Pie only reads what it wrote.

## Starting a conversation

The sidebar has one entry point for beginning a conversation, the **New** button in its header:
**New** opens a dialog with two large choices, **Add a project** and **Start without a project**;
the footer offers no second "open another project" link.

**Add a project** turns the same dialog into its folder step: the directory browser, with a **Back**
link to the two choices and no "default location" shortcut of its own. Folder rows navigate, while
**Open this folder** commits the location displayed in the footer. The chosen folder starts the
conversation and stays the remembered custom path. Path input suggests matching folders and
automatically displays an existing directory's children; arrow keys and Tab accept a suggestion.
Home navigates to the server user's home directory, and `~` paths are supported. Loading, incomplete
paths and failed navigation disable the commit. A local name filter narrows the displayed folders.
New folders are created inline and browsed before selection, without a second modal. The dialog
contains keyboard focus, restores its opener, and handles Escape locally (closing an unfinished
new-folder form first). Errors stay visible and failed navigation offers Retry. The layout keeps the
destination and action buttons outside the scrolling directory list, including on phones.

**Start without a project** creates today's scratch folder (`~/pi-cwd/YYYYMMDD`) through the
default-directory and validation APIs and starts the conversation there at once; a scratch pick does
not overwrite the remembered custom path. The same two actions stay in the composer's project menu
for a conversation already open, worded as **Add a project…** and **Start without a project**.

## Navigation and accessibility

The conversation directory uses a lightweight overlay entry point rather than a permanent column.
Keep it available even when history fits without scrolling. Its entry point is derived from the
transcript, so it stays visible on desktop widths whenever the conversation has a turn; never let a
layout measurement or a transient mount gate decide whether it exists. Phones keep the chat at full
width and hide the rail. Do not add workspace tabs or agent management panels.

Check desktop, narrow desktop, and phone layouts. Preserve predictable return, close, cancel, and
focus behavior. Do not add modes when simpler interaction suffices.
