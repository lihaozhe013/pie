/**
 * The provider order the user arranges in Settings › Models.
 *
 * Pi owns which providers exist and their registry order, and models.json only
 * orders a provider's models. The order across providers is therefore a Pie
 * preference: it lives in this browser's local storage and is applied wherever
 * providers are listed (the Settings sidebar and the model selector). Provider
 * ids that are not listed any more stay harmless in the saved array, so signing
 * a provider out and back in does not lose its place.
 */

export const PROVIDER_ORDER_STORAGE_KEY = 'pie:model-provider-order';

export interface ProviderOrderStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): ProviderOrderStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Provider ids in the arranged order; malformed or duplicate entries are dropped. */
export function readProviderOrder(
  storage: ProviderOrderStorage | null = browserStorage()
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PROVIDER_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const order: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string' || !entry || seen.has(entry)) continue;
      seen.add(entry);
      order.push(entry);
    }
    return order;
  } catch {
    return [];
  }
}

export function writeProviderOrder(
  order: readonly string[],
  storage: ProviderOrderStorage | null = browserStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(PROVIDER_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Browser storage is best-effort.
  }
}

/**
 * Sorts items by their provider's place in `order`, keeping the incoming order
 * for providers the preference does not know yet (they follow the known ones).
 */
export function orderByProviderPreference<T>(
  items: readonly T[],
  providerOf: (item: T) => string,
  order: readonly string[] = readProviderOrder()
): T[] {
  if (order.length === 0) return [...items];
  const rank = new Map(order.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index, rank: rank.get(providerOf(item)) }))
    .sort((a, b) => {
      if (a.rank === undefined) return b.rank === undefined ? a.index - b.index : 1;
      if (b.rank === undefined) return -1;
      return a.rank - b.rank || a.index - b.index;
    })
    .map((entry) => entry.item);
}

/**
 * Moves `id` past its visible neighbour and returns the saved order.
 *
 * The rows on screen carry the new arrangement; providers that are not listed
 * now (signed out, or still loading) follow them in their saved relative order,
 * so they come back after the visible ones instead of losing their id.
 */
export function moveProviderOrder(
  order: readonly string[],
  visibleIds: readonly string[],
  id: string,
  offset: number
): string[] {
  const index = visibleIds.indexOf(id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= visibleIds.length) return [...order];

  const nextVisible = [...visibleIds];
  [nextVisible[index], nextVisible[target]] = [nextVisible[target], nextVisible[index]];

  const visible = new Set(visibleIds);
  return [...nextVisible, ...order.filter((entry) => !visible.has(entry))];
}
