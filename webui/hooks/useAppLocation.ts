import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent
} from 'react';

/**
 * Browser navigation for the single-page app, exposed as `useRouter` and `useSearchParams`: the
 * shape every component in the shell already imports.
 *
 * The URL is the app's own state: `?mode=tasks` selects the workspace, `?session=` opens a
 * session, and `?cwd=` names the project. A history change therefore has to notify React, which
 * is what the event below is for; `popstate` covers the back and forward buttons.
 */
const NAVIGATION_EVENT = 'pie:navigation';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATION_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATION_EVENT, onChange);
  };
}

function notify(): void {
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

function currentSearch(): string {
  return window.location.search;
}

/** The current query string, re-read whenever the URL changes. */
export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, currentSearch, () => '');
  return useMemo(() => new URLSearchParams(search), [search]);
}

export interface AppRouter {
  /** Replace the current history entry, the way the shell records the open view. */
  replace(href: string, options?: { scroll?: boolean }): void;
  /** Add a history entry, used by in-app links that want client-side navigation. */
  push(href: string, options?: { scroll?: boolean }): void;
}

export function useRouter(): AppRouter {
  return useMemo(() => {
    const go = (href: string, mode: 'replace' | 'push', scroll: boolean | undefined) => {
      const url = new URL(href, window.location.href);
      const next = `${url.pathname}${url.search}${url.hash}`;
      if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) {
        return;
      }
      if (mode === 'push') window.history.pushState(null, '', next);
      else window.history.replaceState(null, '', next);
      if (scroll !== false) window.scrollTo(0, 0);
      notify();
    };
    return {
      replace: (href, options) => go(href, 'replace', options?.scroll),
      push: (href, options) => go(href, 'push', options?.scroll)
    };
  }, []);
}

/** Follow an in-app link without a full page load, while leaving modified clicks to the browser. */
export function useInAppClick(): (event: ReactMouseEvent<HTMLAnchorElement>) => void {
  const router = useRouter();
  return useCallback(
    (event) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const href = event.currentTarget.getAttribute('href');
      if (!href || !href.startsWith('/')) return;
      event.preventDefault();
      router.push(href);
    },
    [router]
  );
}
