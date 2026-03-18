/**
 * Remembers which tool-call cards the user has expanded (or folded), keyed by
 * toolCallId.
 *
 * A streaming assistant message is rendered from the streaming store, then re-rendered
 * from `messages` after `message_end`, and moves into Process details when the run
 * ends. Each of those hops remounts `ToolCallBlock`, and so does the session file's
 * read when the message's key cannot pass to its entry (lib/message-keys.ts), as in
 * a run longer than the first page; otherwise the read keeps the card mounted. Plain
 * component state would collapse a card the user just opened. Keeping the set
 * outside React lets the remounted card start expanded without threading state
 * through every message component.
 *
 * The choice is three-valued (`getToolCallExpansion`): undefined means the user
 * never touched the card, which lets lifecycle defaults from
 * (lib/tool-card-expansion.ts) apply without overriding a user's choice.
 */
const toolCallExpansions = new Map<string, boolean>();

/** The user's own choice for this card, or undefined when they never made one. */
export function getToolCallExpansion(toolCallId: string | undefined): boolean | undefined {
  return toolCallId === undefined ? undefined : toolCallExpansions.get(toolCallId);
}

export function isToolCallExpanded(toolCallId: string | undefined): boolean {
  return getToolCallExpansion(toolCallId) === true;
}

export function setToolCallExpanded(toolCallId: string | undefined, expanded: boolean): void {
  if (!toolCallId) return;
  toolCallExpansions.set(toolCallId, expanded);
}

export function clearExpandedToolCalls(): void {
  toolCallExpansions.clear();
}
