import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import {
  CANONICAL_CODING_TOOLS,
  PIE_EXTENSION_TOOL_NAMES,
  PRESET_DEFAULT,
  PRESET_FULL,
  PRESET_READ_ONLY,
  isSelectableToolName,
  sortToolNames,
  type ToolEntry
} from '@/lib/tool-presets';
import {
  CUSTOM_TOOL_PRESET_MAX_COUNT,
  CUSTOM_TOOL_PRESET_TOOLS,
  customPresetNameError,
  makeCustomToolPresetId,
  type CustomToolPreset
} from '@/lib/custom-tool-presets-shared';
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailTitle,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigFooterStatus,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSectionTitle,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView
} from './SettingsUi';

/** The shell tool is stored canonically as `bash` and shown as one "shell" entry. */
const SHELL_TOOL = 'bash';

const START_TOOLS: Record<'read-only' | 'default' | 'full', readonly string[]> = {
  'read-only': ['read', 'grep', 'find', 'ls'],
  default: ['read', SHELL_TOOL, 'edit', 'write'],
  full: CUSTOM_TOOL_PRESET_TOOLS
};

const EXTENSION_TOOL_NAMES = new Set<string>(PIE_EXTENSION_TOOL_NAMES);

type ToolGroup = 'coding' | 'extension';

interface ToolRow {
  name: string;
  group: ToolGroup;
  description: string;
  /** Present in the current session's registered tools. */
  available: boolean;
}

/**
 * The built-in presets, shown read-only beside the user's own so the list
 * doubles as a reference. Ids carry a `builtin:` prefix, which custom ids
 * (letters, digits, `_`, `-`) can never collide with. `tools: null` means the
 * preset pins no list of its own.
 */
const BUILT_IN_PRESETS: {
  id: string;
  name:
    | 'configured'
    | 'plan'
    | 'autonomous'
    | 'orchestrator'
    | 'chat-only'
    | 'read-only'
    | 'default'
    | 'full';
  descriptionKey: string;
  tools: readonly string[] | null;
}[] = [
  { id: 'configured', name: 'configured', descriptionKey: 'chat.configuredTools', tools: null },
  { id: 'plan', name: 'plan', descriptionKey: 'chat.planModeTools', tools: PRESET_READ_ONLY },
  {
    id: 'autonomous',
    name: 'autonomous',
    descriptionKey: 'chat.autonomousModeTools',
    tools: PRESET_FULL
  },
  {
    id: 'orchestrator',
    name: 'orchestrator',
    descriptionKey: 'chat.orchestratorModeTools',
    tools: PRESET_FULL
  },
  { id: 'chat-only', name: 'chat-only', descriptionKey: 'chat.chatOnly', tools: [] },
  {
    id: 'read-only',
    name: 'read-only',
    descriptionKey: 'chat.readOnlyTools',
    tools: PRESET_READ_ONLY
  },
  { id: 'default', name: 'default', descriptionKey: 'chat.builtInTools', tools: PRESET_DEFAULT },
  { id: 'full', name: 'full', descriptionKey: 'chat.allBuiltInTools', tools: PRESET_FULL }
];

interface Props {
  embedded: boolean;
  onClose: () => void;
  /** The list was saved; the session's composer reloads its copy. */
  onSaved: () => void;
  /** The current session's tools, including extension tools, for descriptions and availability. */
  availableTools?: ToolEntry[] | null;
  toolsLoading?: boolean;
}

function toolLabel(name: string): string {
  return name === SHELL_TOOL ? 'shell' : name;
}

/**
 * Settings section for the custom tool presets (`lib/custom-tool-presets.ts`):
 * the built-in presets read-only, the user's presets beside an editor for the
 * selected one. Custom edits stay in the draft until Save replaces the whole
 * server-side list; Delete is a two-step button kept apart from Save.
 */
export function ToolPresetsSettings({
  embedded,
  onClose,
  onSaved,
  availableTools,
  toolsLoading
}: Props) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<CustomToolPreset[] | null>(null);
  const [draft, setDraft] = useState<CustomToolPreset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const nameErrorId = useId();
  const includeExtensionsId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/tools/presets', {
          cache: 'no-store',
          signal: controller.signal
        });
        const data = (await response.json()) as {
          presets?: CustomToolPreset[];
          error?: string;
        };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (controller.signal.aborted) return;
        const presets = data.presets ?? [];
        setLoaded(presets);
        setDraft(presets.map((preset) => ({ ...preset, tools: [...preset.tools] })));
        // Land on the user's first preset, or on the reference list when none exist yet.
        setSelectedId(presets[0]?.id ?? `builtin:${BUILT_IN_PRESETS[0].id}`);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => controller.abort();
  }, []);

  const liveTools = useMemo(() => {
    const map = new Map<string, ToolEntry>();
    for (const tool of availableTools ?? []) {
      if (tool.exposure === 'hidden' || !isSelectableToolName(tool.name)) continue;
      map.set(tool.name, tool);
    }
    return map;
  }, [availableTools]);

  /**
   * Every tool the editor can show. The coding set is always present; the
   * extension order starts with the tools Pie ships and then keeps whatever
   * the live session registered, such as a project's MCP tools.
   */
  const catalog = useMemo(() => {
    const describe = (name: string, fallback: string | undefined): string => {
      const key = `toolPresets.tool.${name}`;
      const translated = t(key);
      if (translated !== key) return translated;
      return fallback?.trim() || t('toolPresets.unknownTool');
    };
    const rows: ToolRow[] = [];
    for (const name of CANONICAL_CODING_TOOLS) {
      rows.push({
        name,
        group: 'coding',
        description: describe(name, liveTools.get(name)?.description),
        available: availableTools == null || liveTools.has(name)
      });
    }
    for (const name of PIE_EXTENSION_TOOL_NAMES) {
      rows.push({
        name,
        group: 'extension',
        description: describe(name, liveTools.get(name)?.description),
        available: availableTools == null || liveTools.has(name)
      });
    }
    for (const [name, tool] of liveTools) {
      if (CANONICAL_CODING_TOOLS.includes(name) || EXTENSION_TOOL_NAMES.has(name)) continue;
      rows.push({
        name,
        group: 'extension',
        description: tool.description?.trim() || t('toolPresets.unknownTool'),
        available: true
      });
    }
    return rows;
  }, [availableTools, liveTools, t]);

  const autoExtensionRows = useMemo(
    () =>
      catalog.filter(
        (row) =>
          row.group === 'extension' &&
          row.name !== 'task_manager' &&
          (availableTools == null || row.available)
      ),
    [availableTools, catalog]
  );

  const selectedBuiltIn = selectedId?.startsWith('builtin:')
    ? (BUILT_IN_PRESETS.find((preset) => `builtin:${preset.id}` === selectedId) ?? null)
    : null;
  const selected = draft.find((preset) => preset.id === selectedId) ?? null;
  const dirty =
    loaded !== null &&
    (draft.length !== loaded.length ||
      draft.some((preset) => {
        const saved = loaded.find((candidate) => candidate.id === preset.id);
        return (
          !saved ||
          saved.name !== preset.name ||
          saved.includeExtensions !== preset.includeExtensions ||
          saved.tools.length !== preset.tools.length ||
          saved.tools.some((tool, index) => tool !== preset.tools[index])
        );
      }));

  const updateSelected = (changes: Partial<CustomToolPreset>) => {
    if (!selected) return;
    setDraft((current) =>
      current.map((preset) => (preset.id === selected.id ? { ...preset, ...changes } : preset))
    );
    setSavedOk(false);
  };

  const toggleTool = (row: ToolRow) => {
    if (!selected || !isRowEditable(row)) return;
    const tools = selected.tools.includes(row.name)
      ? selected.tools.filter((name) => name !== row.name)
      : sortToolNames([...selected.tools, row.name]);
    updateSelected({ tools });
  };

  const isRowEditable = (row: ToolRow): boolean => {
    if (!selected) return false;
    if (row.group === 'coding') return true;
    // An include-all custom preset keeps every extension tool except task_manager
    // on automatically; the user turns the switch off to choose individually.
    return !(selected.includeExtensions && row.name !== 'task_manager');
  };

  const showingTool = (row: ToolRow): boolean => {
    if (!selected) return false;
    if (row.group === 'extension' && selected.includeExtensions && row.name !== 'task_manager') {
      return true;
    }
    return selected.tools.includes(row.name);
  };

  const customRows = useMemo(() => {
    if (!selected) return catalog;
    const known = new Set(catalog.map((row) => row.name));
    return [
      ...catalog,
      ...selected.tools
        .filter((name) => !known.has(name))
        .map((name) => ({
          name,
          group: 'extension' as const,
          description: t('toolPresets.unknownTool'),
          available: false
        }))
    ];
  }, [catalog, selected, t]);

  const effectivePresetCount = (preset: CustomToolPreset): number =>
    preset.includeExtensions
      ? new Set([...preset.tools, ...autoExtensionRows.map((row) => row.name)]).size
      : preset.tools.length;

  const addPreset = () => {
    const preset: CustomToolPreset = {
      id: makeCustomToolPresetId(),
      name: t('toolPresets.untitled'),
      // A new custom preset is explicit; the old all-extension behavior is available as a switch.
      includeExtensions: false,
      tools: [...START_TOOLS['read-only']]
    };
    setDraft((current) => [...current, preset]);
    setSelectedId(preset.id);
    setConfirmingDelete(false);
    setError(null);
    // A new preset starts by naming it: select the suggestion once the field mounts.
    requestAnimationFrame(() => nameInputRef.current?.select());
  };

  const deleteSelected = () => {
    if (!selected) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setDraft((current) => current.filter((preset) => preset.id !== selected.id));
    setSelectedId((current) => {
      const rest = draft.filter((preset) => preset.id !== current);
      return rest[0]?.id ?? `builtin:${BUILT_IN_PRESETS[0].id}`;
    });
    setConfirmingDelete(false);
    setError(null);
  };

  const save = async () => {
    if (saving) return;
    for (const preset of draft) {
      const nameError = customPresetNameError(draft, preset.id, preset.name);
      if (nameError) {
        setSelectedId(preset.id);
        setError(t(`toolPresets.errorName.${nameError}`));
        requestAnimationFrame(() => {
          nameInputRef.current?.focus();
          nameInputRef.current?.select();
        });
        return;
      }
      if (preset.tools.length === 0) {
        setSelectedId(preset.id);
        setError(t('toolPresets.errorNoTools', { name: preset.name }));
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/tools/presets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, presets: draft })
      });
      const data = (await response.json()) as { presets?: CustomToolPreset[]; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      const presets = data.presets ?? [];
      setLoaded(presets);
      setDraft(presets.map((preset) => ({ ...preset, tools: [...preset.tools] })));
      setSavedOk(true);
      window.setTimeout(() => setSavedOk(false), 2000);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const startFrom = (preset: 'read-only' | 'default' | 'full') => {
    const extras = preset === 'full' ? autoExtensionRows.map((row) => row.name) : [];
    updateSelected({ tools: sortToolNames([...START_TOOLS[preset], ...extras]) });
  };

  const atLimit = draft.length >= CUSTOM_TOOL_PRESET_MAX_COUNT;
  const nameError = selected ? customPresetNameError(draft, selected.id, selected.name) : undefined;
  const builtInName = (preset: (typeof BUILT_IN_PRESETS)[number]): string =>
    preset.name === 'plan'
      ? t('chat.planMode')
      : preset.name === 'autonomous'
        ? t('chat.autonomousMode')
        : preset.name === 'orchestrator'
          ? t('chat.orchestratorMode')
          : preset.name === 'chat-only'
            ? t('chat.chatOnly')
            : preset.name;
  const builtInDescription = (preset: (typeof BUILT_IN_PRESETS)[number]): string =>
    preset.descriptionKey === 'chat.readOnlyTools' || preset.descriptionKey === 'chat.builtInTools'
      ? t(preset.descriptionKey, { count: 4 })
      : t(preset.descriptionKey);

  const builtInRows = (preset: (typeof BUILT_IN_PRESETS)[number]): ToolRow[] => {
    if (preset.tools === null || preset.name === 'chat-only') return [];
    const names = new Set(preset.tools);
    if (preset.name !== 'configured') {
      for (const row of catalog) {
        if (
          row.group === 'extension' &&
          row.name !== 'task_manager' &&
          // Autonomous starts without ask_user; its guard only covers legacy states.
          !(preset.name === 'autonomous' && row.name === 'ask_user') &&
          (availableTools == null || row.available)
        ) {
          names.add(row.name);
        }
      }
    }
    if (preset.name === 'orchestrator') names.add('task_manager');
    return catalog.filter((row) => names.has(row.name));
  };

  const renderToolRows = (rows: ToolRow[], readOnly: boolean) => {
    const coding = rows.filter((row) => row.group === 'coding');
    const extension = rows.filter((row) => row.group === 'extension');
    return (
      <>
        {coding.length > 0 && (
          <fieldset className="tool-presets-tools">
            <ConfigSectionTitle>{t('toolPresets.codingTools')}</ConfigSectionTitle>
            {coding.map((row) => renderToolRow(row, readOnly))}
          </fieldset>
        )}
        {extension.length > 0 && (
          <fieldset className="tool-presets-tools">
            <ConfigSectionTitle>{t('toolPresets.extensionTools')}</ConfigSectionTitle>
            {extension.map((row) => renderToolRow(row, readOnly))}
          </fieldset>
        )}
      </>
    );
  };

  const renderToolRow = (row: ToolRow, readOnly: boolean) => {
    const auto =
      !readOnly &&
      selected !== null &&
      selected.includeExtensions &&
      row.group === 'extension' &&
      row.name !== 'task_manager';
    const checked = readOnly ? true : selected ? showingTool(row) : false;
    const disabled = readOnly || auto;
    return (
      <label
        key={row.name}
        className={`tool-presets-tool${readOnly || auto ? ' is-readonly' : ''}${
          auto ? ' is-auto' : ''
        }`}
        title={row.available ? undefined : t('toolPresets.toolUnavailable')}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          readOnly={disabled}
          onChange={() => toggleTool(row)}
        />
        <code>{toolLabel(row.name)}</code>
        <span>
          {row.description}
          {auto && (
            <span className="tool-presets-auto-label"> · {t('toolPresets.autoIncluded')}</span>
          )}
        </span>
      </label>
    );
  };

  return (
    <ConfigPanelShell
      embedded={embedded}
      title={t('toolPresets.title')}
      closeLabel={t('i18n.close')}
      onClose={onClose}
    >
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
            <ConfigSidebarGroupLabel>{t('toolPresets.builtIn')}</ConfigSidebarGroupLabel>
            {BUILT_IN_PRESETS.map((preset) => (
              <ConfigSidebarItem
                key={preset.id}
                active={selectedBuiltIn?.id === preset.id}
                onClick={() => {
                  setSelectedId(`builtin:${preset.id}`);
                  setConfirmingDelete(false);
                }}
              >
                <ConfigSidebarText className="tool-presets-item-name">
                  {builtInName(preset)}
                </ConfigSidebarText>
                <ConfigSidebarText className="tool-presets-item-count">
                  {preset.tools === null ? '' : builtInRows(preset).length}
                </ConfigSidebarText>
              </ConfigSidebarItem>
            ))}
            <ConfigSidebarGroupLabel>{t('toolPresets.list')}</ConfigSidebarGroupLabel>
            {draft.map((preset) => (
              <ConfigSidebarItem
                key={preset.id}
                active={preset.id === selectedId}
                onClick={() => {
                  setSelectedId(preset.id);
                  setConfirmingDelete(false);
                }}
              >
                <ConfigSidebarText className="tool-presets-item-name">
                  {preset.name || t('toolPresets.untitled')}
                </ConfigSidebarText>
                <ConfigSidebarText className="tool-presets-item-count">
                  {t('chat.toolCount', { count: effectivePresetCount(preset) })}
                </ConfigSidebarText>
              </ConfigSidebarItem>
            ))}
          </ConfigSidebarList>
          <ConfigListAction
            onClick={addPreset}
            disabled={atLimit}
            title={
              atLimit
                ? t('toolPresets.limitReached', { count: CUSTOM_TOOL_PRESET_MAX_COUNT })
                : undefined
            }
          >
            {t('toolPresets.newPreset')}
          </ConfigListAction>
        </ConfigSidebar>

        <ConfigDetail>
          {selectedBuiltIn ? (
            <div className="tool-presets-form">
              <ConfigDetailHeader>
                <ConfigDetailHeaderInfo>
                  <ConfigDetailTitle>{builtInName(selectedBuiltIn)}</ConfigDetailTitle>
                  <span className="tool-presets-tag">{t('toolPresets.builtIn')}</span>
                </ConfigDetailHeaderInfo>
              </ConfigDetailHeader>
              <p className="tool-presets-summary">
                {builtInDescription(selectedBuiltIn)}
                {selectedBuiltIn.tools !== null && selectedBuiltIn.tools.length > 0 && (
                  <>
                    {' · '}
                    {t('toolPresets.summary', { tools: selectedBuiltIn.tools.join(', ') })}
                  </>
                )}
              </p>
              {toolsLoading && (
                <p className="tool-presets-summary">{t('toolPresets.loadingTools')}</p>
              )}
              {selectedBuiltIn.tools !== null && selectedBuiltIn.tools.length > 0
                ? renderToolRows(builtInRows(selectedBuiltIn), true)
                : null}
            </div>
          ) : selected ? (
            <div className="tool-presets-form">
              <ConfigField label={t('toolPresets.name')}>
                <input
                  ref={nameInputRef}
                  type="text"
                  className="tool-presets-name-input"
                  value={selected.name}
                  maxLength={60}
                  aria-invalid={nameError !== undefined || undefined}
                  aria-describedby={nameError ? nameErrorId : undefined}
                  onBlur={() => {
                    // Inline validation on blur, not on every keystroke.
                    if (customPresetNameError(draft, selected.id, selected.name)) setError(null);
                  }}
                  onChange={(event) => updateSelected({ name: event.target.value })}
                />
                {nameError && (
                  <p id={nameErrorId} className="tool-presets-field-error">
                    {t(`toolPresets.errorName.${nameError}`)}
                  </p>
                )}
              </ConfigField>

              <ConfigField label={t('toolPresets.startFrom')}>
                <div className="tool-presets-start">
                  {(['read-only', 'default', 'full'] as const).map((preset) => (
                    <ConfigButton key={preset} size="small" onClick={() => startFrom(preset)}>
                      {t(`toolPresets.start.${preset}`)}
                    </ConfigButton>
                  ))}
                </div>
              </ConfigField>

              <div className="tool-presets-tool tool-presets-include-all">
                <input
                  id={includeExtensionsId}
                  type="checkbox"
                  checked={selected.includeExtensions}
                  onChange={() =>
                    updateSelected({ includeExtensions: !selected.includeExtensions })
                  }
                />
                <label htmlFor={includeExtensionsId} className="tool-presets-include-all-text">
                  <span className="tool-presets-include-all-title">
                    {t('toolPresets.includeExtensions')}
                  </span>
                  <span className="tool-presets-include-all-hint">
                    {t('toolPresets.includeExtensionsHint')}
                  </span>
                </label>
              </div>

              {renderToolRows(customRows, false)}

              <p className="tool-presets-summary">
                {selected.tools.length > 0
                  ? t('toolPresets.summary', {
                      tools: sortToolNames([
                        ...selected.tools,
                        ...(selected.includeExtensions
                          ? autoExtensionRows.map((row) => row.name)
                          : [])
                      ]).join(', ')
                    })
                  : t('toolPresets.summaryEmpty')}
              </p>
              {toolsLoading && (
                <p className="tool-presets-summary">{t('toolPresets.loadingTools')}</p>
              )}
            </div>
          ) : (
            <ConfigEmptyState>
              {loaded === null
                ? t('i18n.loading')
                : draft.length === 0
                  ? t('toolPresets.emptyNew')
                  : t('toolPresets.empty')}
            </ConfigEmptyState>
          )}
        </ConfigDetail>
      </ConfigSplitView>

      <ConfigFooter
        status={
          error ? (
            <ConfigFooterStatus summary={error} tone="error" />
          ) : savedOk && !dirty ? (
            <ConfigFooterStatus summary={t('i18n.saved')} />
          ) : null
        }
      >
        {selected && (
          <>
            <ConfigButton
              variant="danger"
              onClick={deleteSelected}
              onBlur={() => setConfirmingDelete(false)}
            >
              {confirmingDelete ? t('toolPresets.deleteConfirm') : t('toolPresets.delete')}
            </ConfigButton>
            <ConfigButton variant="primary" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? t('toolPresets.saving') : t('toolPresets.save')}
            </ConfigButton>
          </>
        )}
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
