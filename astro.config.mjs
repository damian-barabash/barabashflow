import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// barabashflow.pl — static portfolio on GitHub Pages (root domain).
// Public pages: static Astro + a few KB of vanilla TS; three.js is a lazy chunk for the hero mark.
// /admin is a vanilla SPA served from public/.
export default defineConfig({
  site: 'https://barabashflow.pl',
  base: '/',
  output: 'static',
  trailingSlash: 'ignore',
  // English aliases → canonical Polish URLs (meta-refresh pages on GH Pages).
  redirects: {
    '/about': '/o-mnie/',
    '/about-us': '/o-mnie/',
    '/contact': '/kontakt/',
    '/privacy': '/polityka-prywatnosci/',
    '/privacy-policy': '/polityka-prywatnosci/',
    '/terms': '/regulamin/',
    '/terms-of-service': '/regulamin/',
    '/editorial-policy': '/zasady-redakcyjne/',
    '/services': '/uslugi/',
    '/projects': '/projekty/',
    '/mail': '/admin/',
  },
  integrations: [
    react(),
    sitemap({
      // admin is private (behind auth) — keep it out of the sitemap.
      filter: (page) => !/\/(admin|404|about|about-us|contact|privacy|privacy-policy|terms|terms-of-service|editorial-policy|services|projects|mail)\/?$/.test(page),
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
