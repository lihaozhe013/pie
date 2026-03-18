import type { SessionInfo } from '@/lib/types';
import type { SessionStatsInfo } from '@/lib/pi-types';
import { formatActiveDuration, formatCompactCount } from '@/lib/session-stats-format';
import { SessionModal } from './SessionModal';

export type SessionCopyField = 'file' | 'id' | 'projectDir';

interface SessionStatsModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionStats: SessionStatsInfo | null;
  selectedSession: SessionInfo | null;
  contextUsage: {
    percent: number | null;
    contextWindow: number;
    tokens: number | null;
  } | null;
  copiedSessionField: SessionCopyField | null;
  onCopySessionField: (field: SessionCopyField, value: string) => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
  locale: string;
  isMobile: boolean;
}

export function SessionStatsModal({
  isOpen,
  onClose,
  sessionStats,
  selectedSession,
  contextUsage,
  copiedSessionField,
  onCopySessionField,
  translate,
  locale,
  isMobile
}: SessionStatsModalProps) {
  if (!isOpen) return null;

  const totalActiveMs = sessionStats?.totalActiveMs ?? 0;
  const ws = selectedSession;

  const sessionRows = sessionStats
    ? [
        ...(sessionStats.sessionName
          ? [
              {
                label: translate('session.name'),
                value: sessionStats.sessionName,
                copyField: null
              }
            ]
          : []),
        {
          label: translate('session.file'),
          value: sessionStats.sessionFile ?? translate('session.inMemory'),
          copyField: 'file' as const
        },
        {
          label: translate('session.id'),
          value: sessionStats.sessionId,
          copyField: 'id' as const
        },
        ...(totalActiveMs > 0
          ? [
              {
                label: translate('session.totalActive'),
                value: formatActiveDuration(totalActiveMs),
                copyField: null
              }
            ]
          : [])
      ]
    : [];

  const projectRows = ws
    ? [
        {
          label: translate('session.projectDir'),
          value: ws.projectRoot ?? ws.cwd,
          copyField: 'projectDir' as const
        }
      ]
    : [];

  const messageRows = sessionStats
    ? [
        [translate('session.user'), sessionStats.userMessages.toLocaleString(locale)],
        [translate('session.assistant'), sessionStats.assistantMessages.toLocaleString(locale)],
        [translate('session.toolCalls'), sessionStats.toolCalls.toLocaleString(locale)],
        [translate('session.toolResults'), sessionStats.toolResults.toLocaleString(locale)],
        [translate('session.total'), sessionStats.totalMessages.toLocaleString(locale)]
      ]
    : [];

  const tokenRows = sessionStats
    ? [
        [translate('session.input'), sessionStats.tokens.input.toLocaleString(locale)],
        [translate('session.output'), sessionStats.tokens.output.toLocaleString(locale)],
        ...(sessionStats.tokens.cacheRead > 0
          ? [[translate('session.cacheRead'), sessionStats.tokens.cacheRead.toLocaleString(locale)]]
          : []),
        ...(sessionStats.tokens.cacheWrite > 0
          ? [
              [
                translate('session.cacheWrite'),
                sessionStats.tokens.cacheWrite.toLocaleString(locale)
              ]
            ]
          : []),
        [translate('session.total'), sessionStats.tokens.total.toLocaleString(locale)]
      ]
    : [];

  const ctx = contextUsage ?? sessionStats?.contextUsage;
  const speed = sessionStats?.speed;

  const extraTokenRows = sessionStats
    ? [
        ...(sessionStats.cost > 0
          ? [[translate('session.cost'), `$${sessionStats.cost.toFixed(4)}`]]
          : []),
        ...(ctx?.contextWindow
          ? [
              [
                translate('session.context'),
                `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : '?'} / ${formatCompactCount(ctx.contextWindow)}`
              ]
            ]
          : []),
        ...(sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite > 0 &&
        sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input >
          0
          ? [
              [
                translate('session.cacheHitRate'),
                `${((sessionStats.tokens.cacheRead / (sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input)) * 100).toFixed(1)}%`
              ]
            ]
          : []),
        [
          translate('session.avgStreamSpeed'),
          sessionStats.streamSpeed && sessionStats.streamSpeed.streamMs > 0
            ? `${(sessionStats.streamSpeed.outputTokens / (sessionStats.streamSpeed.streamMs / 1000)).toFixed(1)} t/s (${sessionStats.streamSpeed.responses})`
            : '— (0)'
        ],
        ...(speed && speed.generationMs > 0
          ? [
              [
                translate('session.avgOutputSpeed'),
                `${(speed.outputTokens / (speed.generationMs / 1000)).toFixed(1)} t/s`
              ]
            ]
          : [])
      ]
    : [];

  const copyTitleKey: Record<SessionCopyField, string> = {
    file: 'session.copyFile',
    id: 'session.copyId',
    projectDir: 'session.copyProjectDir'
  };

  const copyButton = (field: SessionCopyField, value: string) => {
    const copied = copiedSessionField === field;
    return (
      <button
        type="button"
        title={copied ? translate('session.copied') : translate(copyTitleKey[field])}
        onClick={() => onCopySessionField(field, value)}
        style={{
          alignSelf: 'start',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          marginTop: -2,
          color: copied ? 'var(--accent)' : 'var(--text-dim)',
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 4,
          cursor: 'pointer',
          flex: '0 0 auto',
          transition: 'color 0.12s, border-color 0.12s, background 0.12s'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--accent)';
          e.currentTarget.style.borderColor = 'var(--accent)';
          e.currentTarget.style.background = 'var(--bg-hover)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = copied ? 'var(--accent)' : 'var(--text-dim)';
          e.currentTarget.style.borderColor = 'var(--border)';
          e.currentTarget.style.background = 'transparent';
        }}
      >
        {copied ? (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    );
  };

  const section = (
    title: string,
    sectionRows: string[][],
    valueAlign: 'left' | 'right' = 'left',
    compact = false
  ) => (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: 'var(--text)',
          marginBottom: 8
        }}
      >
        {title}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: compact ? 'max-content max-content' : 'auto minmax(0, 1fr)',
          columnGap: compact ? 16 : 14,
          rowGap: 6,
          justifyContent: compact ? 'start' : undefined
        }}
      >
        {sectionRows.map(([label, value]) => (
          <div key={`${title}:${label}`} style={{ display: 'contents' }}>
            <div style={{ color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{label}</div>
            <div
              style={{
                color: 'var(--text-muted)',
                minWidth: 0,
                overflowWrap: compact ? 'normal' : 'anywhere',
                textAlign: valueAlign,
                whiteSpace: valueAlign === 'right' ? 'nowrap' : 'normal'
              }}
            >
              {value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <SessionModal
      title={translate('session.title')}
      onClose={onClose}
      maxWidth={720}
      icon={
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
      }
    >
      <div
        style={{
          padding: isMobile ? '16px' : '20px 24px',
          background: 'var(--bg)',
          fontSize: 12,
          lineHeight: 1.5,
          fontFamily: 'var(--font-mono)'
        }}
      >
        {sessionStats ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr)',
              gap: isMobile ? 18 : 24
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: isMobile ? 16 : 20
              }}
            >
              {/* Session Info Section */}
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--text)',
                    marginBottom: 8
                  }}
                >
                  {translate('session.infoSection')}
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                    columnGap: 14,
                    rowGap: 8,
                    alignItems: 'start'
                  }}
                >
                  {sessionRows.map((row) => (
                    <div key={`session-info:${row.label}`} style={{ display: 'contents' }}>
                      <div style={{ color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                        {row.label}
                      </div>
                      <div
                        style={{
                          color: 'var(--text-muted)',
                          minWidth: 0,
                          overflowWrap: 'anywhere',
                          wordBreak: 'break-word',
                          whiteSpace: 'normal'
                        }}
                      >
                        {row.value}
                      </div>
                      <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Project Info Section */}
              {projectRows.length > 0 && (
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: 'var(--text)',
                      marginBottom: 8
                    }}
                  >
                    {translate('session.projectSection')}
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                      columnGap: 14,
                      rowGap: 8,
                      alignItems: 'start'
                    }}
                  >
                    {projectRows.map((row) => (
                      <div key={`project-info:${row.label}`} style={{ display: 'contents' }}>
                        <div style={{ color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                          {row.label}
                        </div>
                        <div
                          style={{
                            color: 'var(--text-muted)',
                            minWidth: 0,
                            overflowWrap: 'anywhere',
                            wordBreak: 'break-word',
                            whiteSpace: 'normal'
                          }}
                        >
                          {row.value}
                        </div>
                        <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: 20
              }}
            >
              {section(translate('session.messages'), messageRows)}
              {section(
                translate('session.tokens'),
                [...tokenRows, ...extraTokenRows],
                'right',
                true
              )}
            </div>
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
            {translate('session.load')}
          </div>
        )}
      </div>
    </SessionModal>
  );
}
