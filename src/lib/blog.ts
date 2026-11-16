// Blog data helpers — used at BUILD TIME by the /blog pages (SSG: every post
// becomes a real static HTML page, which is the whole SEO point).
import { SUPABASE_URL, SUPABASE_ANON_KEY, mediaUrl } from './supabase';
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
  images?: PostImage[] | null;
  estimator_after_h2?: number | null;
}

// Unsplash photos are hotlinked (API guidelines) — `url` is the raw
// images.unsplash.com URL, sized per use via imgix params (see imgUrl()).
export interface PostImage {
  role: 'cover' | 'inline';
  slot?: number;
  after_h2?: number;       // inline: inserted at the end of this H2 section (1-based)
  id?: string;
  url: string;
  width?: number;
  height?: number;
  color?: string | null;
  alt_pl?: string | null;
  alt_en?: string | null;
  alt_ru?: string | null;
  author?: string | null;
  author_url?: string | null;
  page_url?: string | null;
}

const UTM = 'utm_source=barabashflow&utm_medium=referral';
const isUnsplash = (u?: string | null) => !!u && /^https:\/\/images\.unsplash\.com\//.test(u);

// Sized image URL: Unsplash → imgix params (webp/avif via auto=format, crop to
// the box); anything else → Supabase public media URL untouched.
export function imgUrl(path: string | null | undefined, w: number, h?: number, q = 72): string | null {
  if (!path) return null;
  if (isUnsplash(path)) {
    const u = new URL(path);
    for (const k of ['w', 'h', 'q', 'fit', 'crop', 'auto', 'fm', 'dpr']) u.searchParams.delete(k);
    u.searchParams.set('auto', 'format');
    u.searchParams.set('q', String(q));
    u.searchParams.set('w', String(w));
    if (h) { u.searchParams.set('h', String(h)); u.searchParams.set('fit', 'crop'); u.searchParams.set('crop', 'entropy'); }
    return u.toString();
  }
  return mediaUrl(path);
}
export function imgSrcset(path: string | null | undefined, widths: number[], ratio?: number): string | undefined {
  if (!isUnsplash(path)) return undefined;
  return widths.map((w) => `${imgUrl(path, w, ratio ? Math.round(w / ratio) : undefined)} ${w}w`).join(', ');
}
export const withUtm = (u?: string | null) => (u ? `${u}${u.includes('?') ? '&' : '?'}${UTM}` : 'https://unsplash.com/?' + UTM);

function figureHtml(img: PostImage, locale: 'pl' | 'en' | 'ru'): string {
  const alt = escapeXml((img as any)[`alt_${locale}`] || img.alt_pl || '');
  const ratio = img.width && img.height ? img.width / img.height : 1.5;
  const h = Math.round(1200 / Math.max(1.2, Math.min(ratio, 1.8)));
  const src = imgUrl(img.url, 1200, h)!;
  const set = imgSrcset(img.url, [640, 960, 1200, 1600], 1200 / h);
  const by = { pl: 'Fot.', en: 'Photo:', ru: 'Фото:' }[locale];
  const credit = img.author
    ? `<figcaption class="post-credit">${by} <a href="${escapeXml(withUtm(img.author_url))}" rel="noopener nofollow" target="_blank">${escapeXml(img.author)}</a> / <a href="${escapeXml(withUtm('https://unsplash.com/'))}" rel="noopener nofollow" target="_blank">Unsplash</a></figcaption>`
    : '';
  const bg = img.color ? ` style="background:${escapeXml(img.color)}"` : '';
  return `<figure class="post-figure"><img src="${escapeXml(src)}"${set ? ` srcset="${escapeXml(set)}" sizes="(max-width: 900px) 100vw, 820px"` : ''} alt="${alt}" width="1200" height="${h}" loading="lazy" decoding="async"${bg} />${credit}</figure>`;
}

// Splits rendered HTML into H2 sections: [intro, h2#1 section, h2#2 section, …].
function splitSections(html: string): string[] {
  const parts = html.split(/(?=<h2[\s>])/i);
  return parts.length ? parts : [html];
}

// Article body → two halves around the estimator, with inline photos placed at
// the end of their H2 section. Positions live in data (not as markers inside
// the markdown) so the text stays clean for RSS, translations and old builds.
export function renderPostBody(
  md: string | null | undefined,
  images: PostImage[] | null | undefined,
  estimatorAfter: number | null | undefined,
  locale: 'pl' | 'en' | 'ru',
): { before: string; after: string } {
  const sections = splitSections(renderMarkdown(md || ''));
  const h2count = sections.length - 1;
  for (const img of (images || []).filter((i) => i.role === 'inline' && i.url)) {
    const at = Math.min(Math.max(1, img.after_h2 || 1), Math.max(h2count, 0));
    sections[at] = (sections[at] || '') + figureHtml(img, locale);
  }
  if (h2count < 2) return { before: sections.join(''), after: '' };
  const split = Math.min(Math.max(1, estimatorAfter ?? Math.ceil(h2count / 2)), h2count - 1);
  return { before: sections.slice(0, split + 1).join(''), after: sections.slice(split + 1).join('') };
}

const LIST_FIELDS =
  'slug,title_pl,title_en,title_ru,excerpt_pl,excerpt_en,excerpt_ru,cover_path,cover_alt,tags,published_at,updated_at,images';

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
    `blog_posts?select=${LIST_FIELDS}&status=eq.published&order=published_at.desc&limit=1000`,
  );
}

export async function fetchAllPosts(): Promise<BlogPost[]> {
  return restGetStrict<BlogPost>(
    'blog_posts?select=*&status=eq.published&order=published_at.desc&limit=1000',
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

// SEO budgets: <title> ≤ 60 chars, meta description ≤ 158 — cut at a word
// boundary with an ellipsis (the H1 / on-page text keeps the full string).
export function clampTitle(s: string, max = 60): string {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf(':'), cut.lastIndexOf('—'));
  return (at > 30 ? cut.slice(0, at) : cut).replace(/[\s:—,-]+$/, '') + '…';
}
export function clampDescription(s: string, max = 158): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const dot = cut.lastIndexOf('. ');
  if (dot > 80) return cut.slice(0, dot + 1);
  const sp = cut.lastIndexOf(' ');
  return cut.slice(0, sp > 60 ? sp : max - 1).replace(/[\s,;:-]+$/, '') + '…';
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
