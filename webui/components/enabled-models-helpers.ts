import type {
  EnabledModelsModelView,
  EnabledModelsProviderView,
  EnabledModelsView
} from '@/lib/enabled-models';

/** Rows shown for the current filter, matched on model name and id. */
export function filterEnabledModels(
  models: readonly EnabledModelsModelView[],
  query: string
): EnabledModelsModelView[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter(
    (model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle)
  );
}

export interface EnabledModelsBulkActions {
  /** References the "enable" action would send. */
  enableRefs: string[];
  /** References the "disable" action would send. */
  disableRefs: string[];
  canEnable: boolean;
  canDisable: boolean;
  /**
   * True when switching every shown row off would empty the scope, so the server
   * keeps one model on. The action stays available: pi has no "nothing enabled"
   * state, and a greyed button explains nothing.
   */
  keepsOne: boolean;
}

/**
 * Bulk actions for the rows currently shown.
 *
 * Nothing here is withheld for the last enabled model. The server resolves that
 * case instead — see `setModelsEnabled()` — so the panel never offers a dead
 * button, whichever providers happen to be configured.
 */
export function enabledModelsBulkActions(
  view: EnabledModelsView | null,
  shown: readonly EnabledModelsModelView[]
): EnabledModelsBulkActions {
  const enableRefs = shown.filter((model) => !model.enabled).map((model) => model.ref);
  const disableRefs = shown.filter((model) => model.enabled).map((model) => model.ref);
  const editable = view?.editable === true;
  return {
    enableRefs,
    disableRefs,
    canEnable: editable && enableRefs.length > 0,
    canDisable: editable && disableRefs.length > 0,
    keepsOne:
      editable && disableRefs.length > 0 && (view?.enabledTotal ?? 0) - disableRefs.length < 1
  };
}

export interface EnabledModelsProviderToggle {
  /** True when every model this provider offers is enabled. */
  checked: boolean;
  /** True when the switch cannot move at all: only a read-only project scope. */
  blocked: boolean;
  /** Why it cannot move, as a refusal key, or null while it can. */
  reason: 'project-scope' | null;
}

/**
 * The single switch a models.json provider gets instead of per-model rows.
 *
 * Its two positions are "all of this provider's models" and "none of them",
 * so it reads `checked` from the full count rather than from "any enabled":
 * a partial selection left by the TUI or a hand-edited settings file shows as
 * off, next to the `1/2 enabled` count, and one click completes it.
 *
 * Switching it off never strands the user: when this provider holds the last
 * enabled models, the server keeps one of them on (see `setModelsEnabled()`),
 * so the switch stays live even as the only provider configured.
 */
export function enabledModelsProviderToggle(
  view: EnabledModelsView | null,
  provider: EnabledModelsProviderView
): EnabledModelsProviderToggle {
  const checked = provider.models.length > 0 && provider.enabledCount === provider.models.length;
  const blocked = view?.editable !== true;
  return { checked, blocked, reason: blocked ? 'project-scope' : null };
}

/** True when switching this single model off would empty the scope. */
export function isLastEnabledModel(
  view: EnabledModelsView | null,
  model: EnabledModelsModelView
): boolean {
  return model.enabled && (view?.enabledTotal ?? 0) <= 1;
}

/**
 * Display name of the model a mutation kept on, when it belongs to `providerId`.
 *
 * Naming it is what makes "disable all" honest: the row that stays on is a
 * consequence of pi's empty-scope fallback, not a refused edit.
 */
export function keptModelForProvider(
  view: EnabledModelsView | null,
  providerId: string
): string | null {
  const ref = view?.keptRef;
  if (!ref) return null;
  const provider = findProviderView(view, providerId);
  if (!provider) return null;
  const model = provider.models.find((entry) => entry.ref === ref);
  return model ? model.name : ref;
}

export function findProviderView(
  view: EnabledModelsView | null,
  providerId: string
): EnabledModelsProviderView | undefined {
  return view?.providers.find((provider) => provider.id === providerId);
}

/** `12/40` style badge for a provider row, or null while nothing is scoped. */
export function providerBadgeLabel(
  view: EnabledModelsView | null,
  providerId: string
): string | null {
  if (!view || view.allEnabled) return null;
  const provider = findProviderView(view, providerId);
  if (!provider) return null;
  return `${provider.enabledCount}/${provider.models.length}`;
}
