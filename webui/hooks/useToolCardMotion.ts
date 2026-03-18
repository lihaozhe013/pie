import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { prefersReducedMotion } from '@/lib/motion';

/**
 * How long a card that left the transcript keeps fading out
 * (`styles/tool-cards.css`, `.tool-card-exit`).
 */
export const TOOL_CARD_EXIT_MS = 240;

/**
 * How long a leaving card stays fully visible before its fade, counted from
 * when it first appeared. A shell that succeeded in a blink would otherwise be
 * gone before the user saw it run and would read as a flash, not a step; a
 * command that ran long has been on screen all along and leaves at once.
 */
export const TOOL_CARD_MIN_VISIBLE_MS = 2000;

/**
 * How long a card's body takes to open or close (`styles/tool-cards.css`,
 * `.tool-card-body`). The body's content is kept this long after it closes,
 * so it is still there while it folds away.
 */
export const TOOL_CARD_BODY_MS = 200;

/** One item of a card list: what to render, and whether it is on its way out. */
export interface HeldItem<T> {
  item: T;
  exiting: boolean;
  /** An exiting item has spent its visible time and is fading out now. */
  fading: boolean;
}

/**
 * The list to render: the items the transcript has now, in order, plus the ones
 * that just left it — marked `exiting` so they fade out where they stood instead
 * of vanishing in one frame.
 *
 * `previous` is the list rendered last time. An item still there keeps its place;
 * an item only in `previous` is held (once); an item only in `items` goes last,
 * which is where a transcript appends it anyway.
 */
export function holdExitingItems<T>(
  items: readonly T[],
  previous: readonly T[],
  key: (item: T) => string
): HeldItem<T>[] {
  const present = new Map(items.map((item) => [key(item), item]));
  const held: HeldItem<T>[] = [];
  const seen = new Set<string>();
  for (const item of previous) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    const current = present.get(id);
    held.push(
      current === undefined
        ? { item, exiting: true, fading: false }
        : { item: current, exiting: false, fading: false }
    );
  }
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    held.push({ item, exiting: false, fading: false });
  }
  return held;
}

/**
 * A card list that lets the cards which leave it linger, then fade.
 *
 * A card disappears when its call folds out of the transcript (a successful
 * shell), and a list built from the message alone would cut it away mid-paint.
 * The items handed back keep a leaving card where it stood until it has been
 * visible for `minVisibleMs` — so a fast command can still be read — then mark
 * it `fading` for `TOOL_CARD_EXIT_MS` before dropping it. Only the shift itself
 * is animated — a list restored from history is rendered exactly as it is, and
 * under `prefers-reduced-motion` nothing is held at all.
 */
export function useExitingItems<T>(
  items: readonly T[],
  key: (item: T) => string,
  { minVisibleMs = 0 }: { minVisibleMs?: number } = {}
): HeldItem<T>[] {
  const previous = useRef<readonly T[]>([]);
  const firstSeen = useRef(new Map<string, number>());
  const fading = useRef(new Set<string>());
  // A leaving card runs two timers: one ends its visible time, one drops it.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>[]>());
  const heldRef = useRef<HeldItem<T>[]>([]);
  const [, bump] = useReducer((count: number) => count + 1, 0);

  // A card that comes back cancels its own exit instead of arriving twice.
  const present = new Set(items.map(key));
  for (const [id, cardTimers] of timers.current) {
    if (!present.has(id)) continue;
    for (const timer of cardTimers) clearTimeout(timer);
    timers.current.delete(id);
    fading.current.delete(id);
  }

  const heldItems = holdExitingItems(items, prefersReducedMotion() ? [] : previous.current, key);
  const held = heldItems.map((entry): HeldItem<T> =>
    entry.exiting && fading.current.has(key(entry.item)) ? { ...entry, fading: true } : entry
  );
  heldRef.current = held;
  previous.current = held.map((entry) => entry.item);

  // The clock and the timers live here, not in render, so a render stays pure.
  // The fade of a card whose visible time is already spent is marked here too,
  // so its exit fold begins with this very commit. The effect must run after
  // every commit; `items` stays a dep on purpose — a card can only start
  // leaving when the list itself changes, so `items` is the signal that this
  // commit may hold a new leaver to schedule.
  // oxlint-disable react/exhaustive-effect-dependencies
  useLayoutEffect(() => {
    const now = Date.now();
    for (const entry of heldRef.current) {
      const id = key(entry.item);
      if (!entry.exiting) {
        // A card's visible time runs from when it first appeared, so the
        // minimum is what is left of it when it starts leaving.
        if (!firstSeen.current.has(id)) firstSeen.current.set(id, now);
        continue;
      }
      if (timers.current.has(id)) continue;
      const seenAt = firstSeen.current.get(id) ?? now;
      const linger = Math.max(0, minVisibleMs - (now - seenAt));
      const cardTimers: ReturnType<typeof setTimeout>[] = [];
      if (linger > 0) {
        cardTimers.push(
          setTimeout(() => {
            fading.current.add(id);
            bump();
          }, linger)
        );
      } else {
        fading.current.add(id);
        bump();
      }
      cardTimers.push(
        setTimeout(() => {
          timers.current.delete(id);
          fading.current.delete(id);
          firstSeen.current.delete(id);
          previous.current = previous.current.filter((item) => key(item) !== id);
          bump();
        }, linger + TOOL_CARD_EXIT_MS)
      );
      timers.current.set(id, cardTimers);
    }
    // A card held nowhere (a list under reduced motion, a block the message
    // lost) would otherwise leave its entry behind for good.
    const known = new Set(heldRef.current.map((entry) => key(entry.item)));
    for (const id of firstSeen.current.keys()) {
      if (!known.has(id)) firstSeen.current.delete(id);
    }
  }, [items, key, minVisibleMs]);
  // oxlint-enable react/exhaustive-effect-dependencies

  const clearTimers = useCallback(() => {
    for (const cardTimers of timers.current.values()) {
      for (const timer of cardTimers) clearTimeout(timer);
    }
    timers.current.clear();
  }, []);
  useEffect(() => clearTimers, [clearTimers]);
  return held;
}

/**
 * Something that shows, then goes: `open` keeps it rendered while it is here and
 * until it has been visible for `minVisibleMs`, `exiting` says it is on its way
 * out, `fading` that the exit fade is playing now. Used where a single element
 * leaves on its own (the composer's activity row, a command the user ran
 * themselves) — a list uses `useExitingItems` instead.
 */
export function useExitHold(
  active: boolean,
  { minVisibleMs = 0 }: { minVisibleMs?: number } = {}
): { open: boolean; exiting: boolean; fading: boolean } {
  const [hold, setHold] = useState({ held: false, fading: false });
  // When the element first showed, so its minimum visible time counts from there.
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    if (active) {
      shownAt.current ??= Date.now();
      setHold({ held: true, fading: false });
      return;
    }
    // Nothing that never showed can leave, and reduced motion holds nothing.
    if (shownAt.current === null || prefersReducedMotion()) {
      shownAt.current = null;
      setHold({ held: false, fading: false });
      return;
    }
    const linger = Math.max(0, minVisibleMs - (Date.now() - shownAt.current));
    // Both moments are fixed from now: the fade's start and its end.
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (linger > 0) {
      timers.push(setTimeout(() => setHold({ held: true, fading: true }), linger));
    } else {
      setHold({ held: true, fading: true });
    }
    timers.push(
      setTimeout(() => {
        // The element is gone: its next showing counts its own time.
        shownAt.current = null;
        setHold({ held: false, fading: false });
      }, linger + TOOL_CARD_EXIT_MS)
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [active, minVisibleMs]);
  return { open: active || hold.held, exiting: !active && hold.held, fading: hold.fading };
}

/**
 * A card body's content: mounted as the body opens, and kept for
 * `TOOL_CARD_BODY_MS` after it closes so the fold is not a cut. Collapsed cards
 * render nothing, so a long transcript does not build every diff at once.
 */
export function useBodyContent(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), TOOL_CARD_BODY_MS);
    return () => clearTimeout(timer);
  }, [open]);
  return open || mounted;
}
