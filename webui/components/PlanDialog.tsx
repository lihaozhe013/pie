import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import type { PlanFacts } from '@/lib/plan-file';
import { MarkdownBody } from './MarkdownBody';
import { SessionModal } from './SessionModal';

interface PlanResponse {
  plan: PlanFacts | null;
  content: string;
  truncated: boolean;
  error?: string;
}

export function PlanDialog({
  sessionId,
  onClose
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [plan, setPlan] = useState<PlanFacts | null>(null);
  const [content, setContent] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plan`);
      const body = (await res.json()) as PlanResponse;
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setPlan(body.plan);
      setContent(body.content);
      setTruncated(body.truncated);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SessionModal title={plan?.title || t('chat.planFile')} onClose={onClose} maxWidth={920}>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 12 }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            color: 'var(--text-muted)',
            fontSize: 12
          }}
        >
          {plan && (
            <>
              <span>{plan.status}</span>
              <span aria-hidden="true">·</span>
              <span style={{ overflowWrap: 'anywhere' }}>{plan.path}</span>
            </>
          )}
          <button
            type="button"
            className="hub-button"
            onClick={() => void load()}
            disabled={loading}
            style={{ marginLeft: 'auto' }}
          >
            {t('chat.planRefresh')}
          </button>
        </div>
        {truncated && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{t('chat.planTruncated')}</div>
        )}
        <div
          style={{
            minHeight: 0,
            maxHeight: '70vh',
            overflow: 'auto',
            paddingRight: 4
          }}
        >
          {loading && <div style={{ color: 'var(--text-muted)' }}>{t('chat.planLoading')}</div>}
          {error && <div style={{ color: 'var(--red, #ef4444)' }}>{error}</div>}
          {!loading && !error && !plan && (
            <div style={{ color: 'var(--text-muted)' }}>{t('chat.planNotYet')}</div>
          )}
          {!loading && !error && plan && (
            <MarkdownBody cwd={undefined} isStreaming={false}>
              {content}
            </MarkdownBody>
          )}
        </div>
      </div>
    </SessionModal>
  );
}
