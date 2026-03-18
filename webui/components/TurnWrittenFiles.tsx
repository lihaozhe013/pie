import { useI18n } from '@/hooks/useI18n';
import type { WrittenFile } from '@/lib/turn-written-files';

/**
 * How many files a turn actually wrote, as one quiet line.
 *
 * Entries come from the turn's successful `write`/`edit`/`apply_patch` tool
 * calls — the reply text is never scanned for paths. The names and their diffs
 * belong to the Runs panel, so the transcript counts them instead of repeating
 * them as chips.
 */
export function TurnWrittenFiles({ files }: { files: WrittenFile[] }) {
  const { t } = useI18n();
  if (files.length === 0) return null;

  return (
    <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-dim)' }}>
      {t('chat.filesChanged', { count: files.length })}
    </p>
  );
}
