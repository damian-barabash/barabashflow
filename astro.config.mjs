import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// Archived blog posts (cleanup 2026-11-16) → redirect pages to the kept post
// that covers the same intent (or /blog/). Strict: a failed fetch fails the
// build, so a deploy can never silently turn old URLs into 404s.
const SB = 'https://yhtzxkhfqzuaafvappln.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlodHp4a2hmcXp1YWFmdmFwcGxuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2OTE4MDUsImV4cCI6MjA5NTI2NzgwNX0.xCW-p1_LTy9tC8BxkrHfarragLOY4kAWUBbnBBzYI3E';
const redirectRes = await fetch(`${SB}/rest/v1/blog_redirects?select=from_slug,to_path`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}` } });
if (!redirectRes.ok) throw new Error(`[build] blog_redirects fetch failed: HTTP ${redirectRes.status}`);
const blogRedirects = Object.fromEntries((await redirectRes.json()).map((r) => [`/blog/${r.from_slug}`, r.to_path]));
const redirectPaths = new Set(Object.keys(blogRedirects).map((k) => `https://barabashflow.pl${k}/`));

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
    ...blogRedirects,
  },
  integrations: [
    react(),
    sitemap({
      // admin is private (behind auth) — keep it out of the sitemap.
      filter: (page) => !redirectPaths.has(page) && !/\/(admin|404|about|about-us|contact|privacy|privacy-policy|terms|terms-of-service|editorial-policy|services|projects|mail)\/?$/.test(page),
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
