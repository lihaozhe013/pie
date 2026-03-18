import { defineConfig } from 'vite';
import { root } from './scripts/build-info.mjs';

/**
 * The Node server bundle.
 *
 * Everything in `node_modules` stays external: the Pi SDK, undici, and the SQLite driver are
 * runtime dependencies that must not be bundled. Only Pie's own source is compiled, which is
 * what resolves the `@` alias and keeps the shipped server a single file.
 */
export default defineConfig({
  // The interface and its public files belong to the client build.
  publicDir: false,
  resolve: {
    alias: { '@': root }
  },
  build: {
    ssr: 'server/index.ts',
    outDir: 'build/server',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: { entryFileNames: 'index.mjs' }
    }
  }
});
