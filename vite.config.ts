import { defineConfig } from 'vite';
import { devDataPlugin } from './tools/vite-dev-data-plugin.ts';

// The dev data endpoint (POST /__data/<file>) only exists on the dev server.
// `vite build` never includes it: plugins with apply:'serve' are skipped at build time.
// Dev tools in the client are gated on __SIEGE_DEV__, which is true only for `vite` (serve)
// and false for every `vite build`, regardless of NODE_ENV (vitest sets NODE_ENV=test and
// Vite would otherwise report import.meta.env.DEV = true inside a test-driven build).
export default defineConfig(({ command }) => ({
  plugins: [devDataPlugin()],
  define: {
    __SIEGE_DEV__: JSON.stringify(command === 'serve'),
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
    watch: {
      // Sandbox setups (P0-17/P0-18) are dev-authored test fixtures written through the dev
      // data endpoint, not game content the running app depends on: without this, saving one
      // adds a new file under the glob `src/data/browser.ts` eagerly imports, and Vite's
      // default full-reload-on-new-glob-match wipes the in-progress sandbox editor session on
      // every Save. Watching them would matter for a future edit-and-reload workflow (P0-07's
      // Tuner, on existing content files only); a brand-new sandbox file is never that.
      ignored: ['**/data/dev/boards/sandbox-*.json'],
    },
  },
}));
