import { useI18n } from '@/hooks/useI18n';
import { shortCommit } from '@/lib/app-version';
import { BUILD_COMMIT, BUILD_PI_VERSION, BUILD_VERSION } from '@/lib/build-info';
import { SessionModal } from './SessionModal';

/**
 * About Pie: the mark, the name, the build's version (whose build metadata is
 * the short commit the build came from), the Pi release it runs, and where it
 * comes from. Opened from the sidebar's wordmark (PieTitle).
 *
 * A traditional about panel: one centered column of text, no cards, gradients
 * or frames — the dialog's shell (SessionModal) already gives it a surface.
 */

export const ABOUT_LOGO_SRC = '/icons/icon-512.png';
export const ABOUT_LOGO_SIZE = 64;
export const APP_REPOSITORY_URL = 'https://github.com/lihaozhe013/pie';
export const PI_REPOSITORY_URL = 'https://github.com/earendil-works/pi';
export const APP_LICENSE = 'MIT';

/** Kept as named exports so the About tests and the dialog read one source. */
export { BUILD_COMMIT, BUILD_PI_VERSION, BUILD_VERSION };

function GitHubIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function ArrowUpRightIcon() {
  return (
    <svg
      className="about-link-external"
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const commit = shortCommit(BUILD_COMMIT);

  return (
    <SessionModal title={t('about.title')} onClose={onClose} maxWidth={380}>
      <div className="about-dialog">
        {/* A fixed 64px mark, not content: it needs no loader or sizing logic. */}
        <img
          className="about-logo"
          src={ABOUT_LOGO_SRC}
          alt=""
          width={ABOUT_LOGO_SIZE}
          height={ABOUT_LOGO_SIZE}
        />

        <h3 className="about-name">Pie</h3>
        <p className="about-tagline">{t('about.tagline')}</p>

        {/* The build's version, then what it runs and under which license:
            plain text lines, not boxed fields. */}
        <p className="about-version">
          <span className="about-version-label">{t('about.version')}</span>{' '}
          <span className="about-version-value">{BUILD_VERSION}</span>
          {commit !== 'unknown' && (
            <>
              {' '}
              (<span className="about-version-commit">{commit}</span>)
            </>
          )}
        </p>

        <dl className="about-facts">
          <div className="about-fact">
            <dt>{t('about.piVersion')}</dt>
            <dd>{BUILD_PI_VERSION}</dd>
          </div>
          <div className="about-fact">
            <dt>{t('about.license')}</dt>
            <dd>{APP_LICENSE}</dd>
          </div>
        </dl>

        <nav className="about-links" aria-label={t('about.links')}>
          <a
            className="about-link"
            href={APP_REPOSITORY_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            <GitHubIcon />
            <span>{t('about.repository')}</span>
            <ArrowUpRightIcon />
          </a>
          <a
            className="about-link"
            href={PI_REPOSITORY_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            <GitHubIcon />
            <span>{t('about.piRepository')}</span>
            <ArrowUpRightIcon />
          </a>
        </nav>

        <p className="about-attribution">{t('about.attribution')}</p>
      </div>
    </SessionModal>
  );
}
