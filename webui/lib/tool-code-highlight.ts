/**
 * turn tool-card text into Prism tokens (`components/ToolCode.tsx`).
 *
 * `refractor/core` is the same instance `react-syntax-highlighter`'s
 * `PrismLight` renders from, so the languages `lib/prism-languages.ts` loads on
 * demand (`loadPrismLanguages()`) are exactly the ones available here, and the
 * colors a tool card uses are the themes a code fence uses. The tool card owns
 * its own frame (padding, colors, scroll), so it renders the tokens itself
 * instead of the fence component's box.
 *
 * The result is the token tree refractor returns; it is structural and tiny, so
 * a card can also tokenize one diff line at a time with it.
 */

import { refractor } from 'refractor/core';

export interface ToolCodeTokenText {
  type: 'text';
  value: string;
}

export interface ToolCodeTokenElement {
  type: 'element';
  tagName: string;
  properties?: { className?: string[] };
  children?: ToolCodeNode[];
}

export type ToolCodeNode = ToolCodeTokenText | ToolCodeTokenElement;

/** True once `lang` can be tokenized (the Prism languages have loaded). */
export function toolCodeLanguageReady(lang: string | undefined): lang is string {
  if (!lang) return false;
  return refractor.registered(lang);
}

/**
 * The tokens of `text` as `lang`, or null when that language is unknown (or
 * its grammar fails on this text). Callers show their plain text then.
 */
export function tokenizeToolCode(text: string, lang: string): ToolCodeNode[] | null {
  if (!toolCodeLanguageReady(lang)) return null;
  try {
    const root = refractor.highlight(text, lang) as unknown as { children?: ToolCodeNode[] };
    return root.children ?? null;
  } catch {
    return null;
  }
}
