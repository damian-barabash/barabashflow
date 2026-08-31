// Blog data helpers — used at BUILD TIME by the /blog pages (SSG: every post
// becomes a real static HTML page, which is the whole SEO point).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';
import { marked } from 'marked';

export interface BlogPost {
  slug: string;
  title_pl: string;
  title_en?: string | null;
  title_ru?: string | null;
  excerpt_pl?: string | null;
  excerpt_en?: string | null;
  excerpt_ru?: string | null;
  body_pl: string;
  body_en?: string | null;
  body_ru?: string | null;
  cover_path?: string | null;
  cover_alt?: string | null;
  cover_credit?: string | null;
  cover_source_url?: string | null;
  tags: string[];
  keywords: string[];
  faq: { q: string; a: string }[];
  published_at: string;
  updated_at?: string | null;
}

const LIST_FIELDS =
  'slug,title_pl,title_en,title_ru,excerpt_pl,excerpt_en,excerpt_ru,cover_path,cover_alt,tags,published_at,updated_at';

// Strict fetch: THROWS on any failure so the whole build goes red. The public
// graph uses the forgiving restGet (page still renders without data), but for
// the blog "forgiving" means silently deploying a site with missing posts —
// a failed build gets retried/noticed, a quietly empty blog does not.
async function restGetStrict<T>(path: string): Promise<T[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!r.ok) throw new Error(`[blog build] Supabase fetch failed: HTTP ${r.status} for ${path}`);
  return (await r.json()) as T[];
}

export async function fetchPostList(): Promise<BlogPost[]> {
  return restGetStrict<BlogPost>(
    `blog_posts?select=${LIST_FIELDS}&status=eq.published&order=published_at.desc&limit=200`,
  );
}

export async function fetchAllPosts(): Promise<BlogPost[]> {
  return restGetStrict<BlogPost>(
    'blog_posts?select=*&status=eq.published&order=published_at.desc&limit=500',
  );
}

export function formatDatePl(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('pl-PL', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso?.slice(0, 10) ?? '';
  }
}

// Markdown -> HTML at build time. The content comes from our own worker via a
// secret-gated Edge Function, but strip active-content tags anyway.
export function renderMarkdown(md: string): string {
  const safe = String(md ?? '')
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|form)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '');
  return marked.parse(safe, { async: false }) as string;
}

export function escapeXml(s: string): string {
  return String(s ?? '').replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!),
  );
}

// ISO date (YYYY-MM-DD) for <time datetime> — never the raw timestamp.
export function isoDate(iso?: string | null): string {
  return String(iso ?? '').slice(0, 10);
}

// True when the post was materially edited after publication (the DB trigger
// only bumps updated_at on content changes; anything within the same day as
// publication is not a real "update" worth showing).
export function wasUpdated(post: Pick<BlogPost, 'published_at' | 'updated_at'>): boolean {
  if (!post.updated_at) return false;
  const pub = new Date(post.published_at).getTime();
  const upd = new Date(post.updated_at).getTime();
  return Number.isFinite(pub) && Number.isFinite(upd) && upd - pub > 24 * 3600 * 1000;
}

// Related posts by tag overlap (case-insensitive), most recent first on ties;
// falls back to the latest posts so every article gets a cluster section.
export function relatedPosts(post: BlogPost, all: BlogPost[], n = 3): BlogPost[] {
  const norm = (t: string) => String(t ?? '').trim().toLowerCase();
  const mine = new Set((post.tags || []).map(norm).filter(Boolean));
  const scored = all
    .filter((p) => p.slug !== post.slug)
    .map((p) => ({
      p,
      score: (p.tags || []).map(norm).filter((t) => mine.has(t)).length,
      ts: new Date(p.published_at).getTime() || 0,
    }))
    .sort((a, b) => b.score - a.score || b.ts - a.ts);
  const picked = scored.filter((x) => x.score > 0).slice(0, n).map((x) => x.p);
  for (const x of scored) {
    if (picked.length >= n) break;
    if (!picked.includes(x.p)) picked.push(x.p);
  }
  return picked;
}

// First slug from `preferred` that actually exists in the published corpus —
// lets static pages link into the blog without ever producing a 404 when a
// post gets hidden or renamed.
export function pickExistingSlug(preferred: string[], slugs: Set<string>): string | null {
  for (const s of preferred) if (slugs.has(s)) return s;
  return null;
}
