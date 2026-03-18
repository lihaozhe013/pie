import { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { listenForShowAbout } from '@/lib/about-request';
import { AboutDialog } from './AboutDialog';

/**
 * The sidebar's brand, at the top of the sessions panel: the app's name, and
 * the way into About — the build's version with the commit it came from, and
 * the Pi release it runs. The desktop shell's macOS menu opens the same dialog
 * through a DOM event it dispatches (lib/about-request.ts).
 */

/** The wordmark the brand shows. A name, so the same in every language. */
export const BRAND_TEXT = 'Pie';

export function PieTitle() {
  const { t } = useI18n();
  const [aboutOpen, setAboutOpen] = useState(false);
  const label = t('sidebar.brandLabel');

  useEffect(() => listenForShowAbout(window, () => setAboutOpen(true)), []);

  return (
    <>
      <button
        type="button"
        className="sidebar-brand"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={aboutOpen}
        onClick={() => setAboutOpen(true)}
      >
        <span className="sidebar-brand-text">{BRAND_TEXT}</span>
      </button>
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </>
  );
}
