import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { THEME_INIT_SCRIPT } from './lib/theme.mts';
import { buildInfoDefine, root } from './scripts/build-info.mjs';

// The development URL matches the one a release serves, so a link, a bookmark, and the desktop
// shell all point at the same address in both modes. Vite answers it and forwards the API.
const UI_PORT = 30141;
const API_PORT = 30142;

/**
 * The saved palette has to apply before first paint, so the inline script runs from `<head>`
 * instead of from the bundle. Its source is `lib/theme.mts` so the page and the app apply the
 * same rules.
 */
function themeInit(): Plugin {
  return {
    name: 'pie-theme-init',
    transformIndexHtml(html) {
      return html.replace('<!--theme-init-->', `<script>${THEME_INIT_SCRIPT}</script>`);
    }
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), themeInit()],
  resolve: {
    alias: { '@': root }
  },
  define: buildInfoDefine(),
  build: {
    outDir: 'dist',
    // `browserslist` in package.json says chrome >= 130; esbuild target keeps the output
    // readable for that browser instead of a per-module workaround.
    target: 'chrome130',
    sourcemap: false
  },
  server: {
    host: '127.0.0.1',
    port: UI_PORT,
    strictPort: true,
    proxy: {
      // The API and the manifest are answered by the Node server so both versions share one
      // origin-shaped contract, including the password middleware and `PIE_APP_NAME`.
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
      '/manifest.webmanifest': { target: `http://127.0.0.1:${API_PORT}` }
    }
  }
});
