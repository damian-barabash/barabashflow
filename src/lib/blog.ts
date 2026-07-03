// Blog data helpers — used at BUILD TIME by the /blog pages (SSG: every post
// becomes a real static HTML page, which is the whole SEO point).
import { restGet } from './supabase';
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

export async function fetchPostList(): Promise<BlogPost[]> {
  return restGet<BlogPost>(
    `blog_posts?select=${LIST_FIELDS}&status=eq.published&order=published_at.desc&limit=200`,
  );
}

export async function fetchAllPosts(): Promise<BlogPost[]> {
  return restGet<BlogPost>(
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
