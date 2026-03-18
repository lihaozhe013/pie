/**
 * The web app manifest.
 *
 * It is served per request rather than written at build time, because `PIE_APP_NAME` is a launch
 * setting: one build serves whatever name the operator started it with.
 */
export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  background_color: string;
  theme_color: string;
  categories: string[];
  lang: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
}

export function webManifest(): WebManifest {
  const appName = process.env.PIE_APP_NAME?.trim() || 'Pie';
  return {
    id: '/',
    name: appName,
    short_name: appName,
    description: 'Local web interface for the pi coding agent',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1a1a1a',
    categories: ['developer', 'productivity'],
    lang: 'en',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any'
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any'
      }
    ]
  };
}
