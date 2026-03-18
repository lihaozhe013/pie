import type { AssistantContentBlock } from './types';

// CJK chars ~1 token each (GLM/DeepSeek/GPT-o200k); other chars ~4 chars/token.
const CJK_PATTERN = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}\uac00-\ud7af]/u;

/** A heuristic for "roughly how much", not a measurement: CJK ~1 token, rest ~4 chars. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) cjk++;
    else rest++;
  }
  return cjk + rest / 4;
}

export interface TokenEstimateCacheEntry {
  text: string;
  tokens: number;
}

/** The text whose length stands for a block's output cost. */
export function getTokenEstimateText(block: AssistantContentBlock): string | null {
  if (block.type === 'text') return block.text;
  if (block.type === 'thinking') return block.thinking;
  if (block.type === 'toolCall') return block.rawInput ?? JSON.stringify(block.input ?? {}) ?? '';
  return null;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Counts only what a grown text added since `previous`, so a stream that ticks
 * many times a second pays for its suffix, never for the whole history again.
 */
export function estimateUpdatedTokens(
  previous: TokenEstimateCacheEntry | undefined,
  text: string
): number {
  if (!previous || !text.startsWith(previous.text)) return estimateTokens(text);

  let baseTokens = previous.tokens;
  let suffixStart = previous.text.length;
  // A streamed delta can complete a surrogate pair that was counted as two
  // non-CJK code points in the previous update.
  if (
    suffixStart > 0 &&
    suffixStart < text.length &&
    isHighSurrogate(previous.text.charCodeAt(suffixStart - 1)) &&
    isLowSurrogate(text.charCodeAt(suffixStart))
  ) {
    baseTokens -= 1 / 4;
    suffixStart--;
  }
  return baseTokens + estimateTokens(text.slice(suffixStart));
}

/**
 * One-slot incremental cache for a caller that estimates a single block at a
 * time (the composer status line's current call or thinking). `key` names the
 * slot's owner, so a block switch re-estimates instead of inheriting a prefix.
 */
export interface BlockEstimator {
  estimate(text: string | null, key: number): number;
  reset(): void;
}

export function createBlockEstimator(): BlockEstimator {
  let slot: TokenEstimateCacheEntry | undefined;
  let slotKey: number | null = null;
  return {
    estimate(text, key) {
      if (text === null) {
        slot = undefined;
        slotKey = null;
        return 0;
      }
      const previous = slotKey === key ? slot : undefined;
      const tokens = estimateUpdatedTokens(previous, text);
      slotKey = key;
      slot = { text, tokens };
      return tokens;
    },
    reset() {
      slot = undefined;
      slotKey = null;
    }
  };
}
