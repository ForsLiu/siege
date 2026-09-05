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
  },
}));
