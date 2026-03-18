import { useMemo } from 'react';
import { useDiffSideBySide } from '@/hooks/useDiffLayout';
import { useI18n } from '@/hooks/useI18n';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  diffGapLabel,
  parseUnifiedPatch,
  unifiedDiffLines,
  type SplitDiffCell,
  type SplitDiffFile,
  type SplitDiffGap,
  type UnifiedDiffLine
} from '@/lib/patch';
import { toolPathLanguage } from '@/lib/tool-code-language';
import { ToolCodeLanguageProvider, ToolCodeTokens } from './ToolCode';
import { CARD_RULE } from './card-style';

/**
 * The diff views a tool card and the Runs panel share.
 *
 * A write, an edit, and a patch all render the same rows here, so the two
 * surfaces that show a change never drift apart.
 */

/** Two code columns side by side, or one column of patch lines. */
export type PatchDiffLayout = 'split' | 'stacked';

/** A unified patch, split into files when it parses, as patch lines when it does not. */
export function SplitPatchView({ text }: { text: string }) {
  const files = useMemo(() => parseUnifiedPatch(text), [text]);
  if (!files) return <PatchTextView text={text} />;
  return <SplitFilesView files={files} />;
}

/**
 * The patch as the settings and the viewport can show it. Side by side is a
 * choice, off by default: inline draws the same rows as one column — a removed
 * line above the line that replaces it, each with its own number, the way the
 * file viewer's diff has always been drawn. Two columns need two code columns
 * beside each other, which a phone does not have, so there the rows stay
 * stacked whatever the choice says. See `unifiedDiffLines()`.
 */
export function SplitFilesView({ files }: { files: SplitDiffFile[] }) {
  const sideBySide = useDiffSideBySide();
  const isMobile = useIsMobile();
  const layout: PatchDiffLayout = sideBySide && !isMobile ? 'split' : 'stacked';
  return <PatchDiffFiles files={files} layout={layout} />;
}

export function PatchDiffFiles({
  files,
  layout
}: {
  files: SplitDiffFile[];
  layout: PatchDiffLayout;
}) {
  const { t } = useI18n();
  const showFileHeaders = files.length > 1;

  return (
    <div
      className="tool-card-pane"
      style={{
        maxHeight: 560,
        overflowY: 'auto',
        overflowX: 'hidden',
        background: 'var(--tool-card-pane)'
      }}
    >
      {files.map((file, fileIndex) => (
        // each file of a patch carries its own syntax, read off its path.
        <ToolCodeLanguageProvider key={fileIndex} lang={toolPathLanguage(stackedFilePath(file))}>
          <div
            key={fileIndex}
            style={{
              minWidth: 0,
              borderTop: fileIndex === 0 ? 'none' : CARD_RULE,
              fontFamily: 'var(--font-mono)',
              fontWeight: 'var(--font-mono-weight)',
              fontSize: 'var(--font-mono-size, 15px)',
              lineHeight: 1.55
            }}
          >
            {showFileHeaders && layout === 'split' && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  background: 'var(--bg-panel)',
                  borderBottom: CARD_RULE
                }}
              >
                <SplitDiffHeader title={file.oldPath || t('i18n.before')} side="left" />
                <SplitDiffHeader title={file.newPath || t('i18n.after')} side="right" />
              </div>
            )}

            {showFileHeaders && layout === 'stacked' && stackedFilePath(file) && (
              <div
                title={stackedFilePath(file)}
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  padding: '5px 10px',
                  color: 'var(--text-dim)',
                  background: 'var(--bg-panel)',
                  borderBottom: CARD_RULE,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {stackedFilePath(file)}
              </div>
            )}

            {layout === 'split' && (
              <div
                style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}
              >
                {file.rows.map((row, rowIndex) => {
                  if (row.type === 'hunk') {
                    return null;
                  }
                  if (row.type === 'gap') {
                    return <DiffGapRow key={rowIndex} gap={row} />;
                  }

                  return (
                    <div key={rowIndex} style={{ display: 'contents' }}>
                      <SplitDiffCellView cell={row.left} side="left" />
                      <SplitDiffCellView cell={row.right} side="right" />
                    </div>
                  );
                })}
              </div>
            )}

            {layout === 'stacked' &&
              unifiedDiffLines(file).map((line, lineIndex) =>
                line.type === 'gap' ? (
                  <DiffGapRow key={lineIndex} gap={line} />
                ) : (
                  <StackedDiffLineView key={lineIndex} line={line} />
                )
              )}
          </div>
        </ToolCodeLanguageProvider>
      ))}
    </div>
  );
}

/** Unchanged lines the patch leaves out between two hunks, across the whole width. */
function DiffGapRow({ gap }: { gap: SplitDiffGap }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        gridColumn: '1 / -1',
        padding: '0 10px',
        color: 'var(--text-dim)',
        background: 'var(--bg-panel)',
        borderTop: CARD_RULE,
        borderBottom: CARD_RULE,
        userSelect: 'none'
      }}
    >
      {gap.count === null ? '⋯' : `⋯ ${diffGapLabel(gap.count, t)}`}
    </div>
  );
}

/** The file a stacked section is named for: the new path, the one that survives, unless the file was deleted. */
function stackedFilePath(file: SplitDiffFile): string {
  if (file.newPath && file.newPath !== '/dev/null') return file.newPath;
  return file.oldPath || file.newPath || '';
}

function StackedDiffLineView({ line }: { line: UnifiedDiffLine }) {
  return (
    <SplitDiffCellView
      side="right"
      cell={{
        // One gutter, so a removed line keeps the old number and everything else the new one.
        lineNo: line.type === 'removed' ? line.oldLineNo : line.newLineNo,
        text: line.text,
        type: line.type
      }}
    />
  );
}

function SplitDiffHeader({ title, side }: { title: string; side: 'left' | 'right' }) {
  return (
    <div
      title={title}
      style={{
        padding: '5px 10px',
        color: 'var(--text-dim)',
        borderRight: side === 'left' ? CARD_RULE : 'none',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
    >
      {title}
    </div>
  );
}

function SplitDiffCellView({ cell, side }: { cell: SplitDiffCell; side: 'left' | 'right' }) {
  const bg =
    cell.type === 'added'
      ? 'rgba(34,197,94,0.12)'
      : cell.type === 'removed'
        ? 'rgba(248,113,113,0.13)'
        : cell.type === 'empty'
          ? 'var(--bg-subtle)'
          : 'transparent';
  const marker = cell.type === 'added' ? '+' : cell.type === 'removed' ? '-' : ' ';
  const markerColor =
    cell.type === 'added' ? '#22c55e' : cell.type === 'removed' ? '#f87171' : 'var(--text-dim)';

  return (
    <div
      style={{
        display: 'flex',
        minWidth: 0,
        background: bg,
        borderRight: side === 'left' ? CARD_RULE : 'none'
      }}
    >
      <span
        style={{
          width: 42,
          padding: '0 6px',
          textAlign: 'right',
          color: 'var(--text-dim)',
          userSelect: 'none',
          background: 'var(--bg-panel)',
          borderRight: CARD_RULE,
          flexShrink: 0
        }}
      >
        {cell.lineNo ?? ''}
      </span>
      <span
        style={{
          width: 18,
          padding: '0 5px',
          color: markerColor,
          userSelect: 'none',
          fontWeight: cell.type === 'context' || cell.type === 'empty' ? 400 : 700,
          flexShrink: 0
        }}
      >
        {marker}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          padding: '0 10px 0 0',
          color: cell.type === 'empty' ? 'var(--text-dim)' : 'var(--text)',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere'
        }}
      >
        {cell.text ? <ToolCodeTokens text={cell.text} budget={false} /> : '\u00a0'}
      </span>
    </div>
  );
}

/** A patch that does not parse as a unified diff, drawn line by line. */
function PatchTextView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);

  return (
    <div
      className="tool-card-pane"
      style={{
        maxHeight: 520,
        overflowY: 'auto',
        overflowX: 'hidden',
        fontFamily: 'var(--font-mono)',
        fontWeight: 'var(--font-mono-weight)',
        fontSize: 'var(--font-mono-size, 15px)',
        lineHeight: 1.55,
        minWidth: 0,
        background: 'var(--tool-card-pane)'
      }}
    >
      {lines.map((line, i) => {
        const kind = line.startsWith('@@')
          ? 'hunk'
          : line.startsWith('+') && !line.startsWith('+++')
            ? 'added'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'removed'
              : 'context';
        const bg =
          kind === 'added'
            ? 'rgba(34,197,94,0.12)'
            : kind === 'removed'
              ? 'rgba(248,113,113,0.13)'
              : kind === 'hunk'
                ? 'rgba(96,165,250,0.12)'
                : 'transparent';
        const color =
          kind === 'added'
            ? '#22c55e'
            : kind === 'removed'
              ? '#f87171'
              : kind === 'hunk'
                ? 'var(--accent)'
                : 'var(--text)';

        return (
          <div
            key={i}
            style={{
              display: 'flex',
              background: bg,
              borderLeft:
                kind === 'added'
                  ? '3px solid #22c55e'
                  : kind === 'removed'
                    ? '3px solid #f87171'
                    : kind === 'hunk'
                      ? '3px solid var(--accent)'
                      : '3px solid transparent'
            }}
          >
            <span
              style={{
                width: 48,
                padding: '0 8px',
                color: 'var(--text-dim)',
                background: 'var(--bg-panel)',
                borderRight: CARD_RULE,
                textAlign: 'right',
                userSelect: 'none',
                flexShrink: 0
              }}
            >
              {i + 1}
            </span>
            <span
              style={{ padding: '0 10px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color }}
            >
              {line || '\u00a0'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
