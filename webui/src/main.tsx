import '@fontsource-variable/noto-sans-mono';
import 'katex/dist/katex.min.css';
import '../styles/globals.css';
import '../styles/settings.css';
import '../styles/sidebar.css';
import '../styles/sidebar-menu.css';
import '../styles/new-session-chooser.css';
import '../styles/turn-copy.css';
import '../styles/composer-hub.css';
import '../styles/goal.css';
import '../styles/workspace.css';
import '../styles/about.css';
import '../styles/tool-cards.css';
import '../styles/execution-history.css';
import '../styles/session-panel.css';
import '../styles/tasks.css';
import '../styles/catppuccin.css';
import '../styles/appearance.css';

import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '@/components/AppShell';
import { LoginPage } from '@/components/LoginPage';
import { PwaRegistration } from '@/components/PwaRegistration';
import { I18nProvider } from '@/hooks/useI18n';

/**
 * One bundle serves two entries: the app shell, and the password form the security middleware
 * redirects to. `/login` is a real URL, so the choice is made from the path the server sent,
 * not from anything the client stores.
 */
function isLoginPath(): boolean {
  return window.location.pathname.replace(/\/+$/, '') === '/login';
}

function render() {
  const root = document.getElementById('root');
  if (!root) throw new Error('The app root is missing from index.html');

  createRoot(root).render(
    <>
      {isLoginPath() ? (
        <LoginPage />
      ) : (
        <Suspense>
          <I18nProvider>
            <AppShell />
          </I18nProvider>
        </Suspense>
      )}
      <PwaRegistration />
    </>
  );
}

render();
