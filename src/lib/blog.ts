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
}

const LIST_FIELDS =
  'slug,title_pl,title_en,title_ru,excerpt_pl,excerpt_en,excerpt_ru,cover_path,cover_alt,tags,published_at';

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
