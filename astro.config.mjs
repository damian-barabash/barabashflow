import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// barabashflow.pl — static portfolio on GitHub Pages (root domain).
// Public page ships zero framework JS; /admin and /mail hydrate React islands.
export default defineConfig({
  site: 'https://barabashflow.pl',
  base: '/',
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [
    react(),
    sitemap({
      // admin + mail are private (behind auth) — keep them out of the sitemap.
      filter: (page) => !/\/(admin|mail)\/?$/.test(page),
    }),
  ],
  build: {
    inlineStylesheets: 'auto',
  },
  vite: {
    build: {
      // Keep Three.js in its own chunk so the graph engine can lazy-load it.
      chunkSizeWarningLimit: 900,
    },
  },
});
