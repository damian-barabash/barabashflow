// Build-time content loaders for the public pages (SSG). Everything the
// admin panel edits lives in Supabase; pages fetch it once at build and bake
// it into static HTML — crawlers, social bots and LLMs see real content.
// PL is rendered in the markup; EN/RU travel in data-lm-* attributes and
// hidden [data-locale] blocks and are swapped client-side (see shell.ts).
import { restGet, mediaUrl } from './supabase';
import { marked } from 'marked';

export type L = 'pl' | 'en' | 'ru';
export const LOCALES: L[] = ['pl', 'en', 'ru'];

export interface Setting { key: string; value_pl: string | null; value_en: string | null; value_ru: string | null; value_meta: any }
export interface Photo { id: string; project_id: string; storage_path: string; alt_pl?: string | null; alt_en?: string | null; alt_ru?: string | null; sort_order: number }
export interface Project {
  id: string; slug: string;
  title_pl: string; title_en?: string | null; title_ru?: string | null;
  category_key: string; category_pl?: string | null; category_en?: string | null; category_ru?: string | null;
  tagline_pl?: string | null; tagline_en?: string | null; tagline_ru?: string | null;
  description_pl?: string | null; description_en?: string | null; description_ru?: string | null;
  body_pl?: string | null; body_en?: string | null; body_ru?: string | null;
  url?: string | null; accent_color?: string | null; sort_order: number; is_published: boolean; is_featured: boolean;
  client?: string | null; year?: number | null; services: string[]; stack: string[];
  results: { value: string; label_pl?: string; label_en?: string; label_ru?: string }[];
  cover_path?: string | null;
  photos: Photo[];
}
export interface Service {
  id: string; slug: string; sort_order: number; icon?: string | null; price_from?: string | null; cover_path?: string | null;
  title_pl: string; title_en?: string | null; title_ru?: string | null;
  tagline_pl?: string | null; tagline_en?: string | null; tagline_ru?: string | null;
  description_pl?: string | null; description_en?: string | null; description_ru?: string | null;
  bullets_pl: string[]; bullets_en: string[]; bullets_ru: string[];
}
export interface Faq { id: string; placement: string; question_pl: string; question_en?: string | null; question_ru?: string | null; answer_pl: string; answer_en?: string | null; answer_ru?: string | null; sort_order: number }

export type Settings = Record<string, Setting>;

export async function fetchSettings(): Promise<Settings> {
  const rows = await restGet<Setting>('site_settings?select=key,value_pl,value_en,value_ru,value_meta');
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

// Localized value with PL fallback; `l` picks a language explicitly.
export function s(settings: Settings, key: string, l: L = 'pl', fallback = ''): string {
  const row = settings[key];
  if (!row) return fallback;
  return (row[`value_${l}`] as string | null) || row.value_pl || fallback;
}
// The three variants for a data-lm-* swap.
export function lm(settings: Settings, key: string, fallback = '') {
  return { 'data-lm-pl': s(settings, key, 'pl', fallback), 'data-lm-en': s(settings, key, 'en', fallback), 'data-lm-ru': s(settings, key, 'ru', fallback) };
}
// Same for any row with <base>_pl/en/ru fields.
export function lmRow(row: Record<string, any> | null | undefined, base: string) {
  const pl = row?.[`${base}_pl`] || '';
  return { 'data-lm-pl': pl, 'data-lm-en': row?.[`${base}_en`] || pl, 'data-lm-ru': row?.[`${base}_ru`] || pl };
}

export async function fetchProjects(): Promise<Project[]> {
  const [projects, photos] = await Promise.all([
    restGet<Project>('projects?select=*&is_published=eq.true&order=sort_order.asc'),
    restGet<Photo>('project_photos?select=*&order=sort_order.asc'),
  ]);
  const byProject = new Map<string, Photo[]>();
  for (const ph of photos) {
    if (!byProject.has(ph.project_id)) byProject.set(ph.project_id, []);
    byProject.get(ph.project_id)!.push(ph);
  }
  return projects.map((p) => ({
    ...p,
    services: p.services || [],
    stack: p.stack || [],
    results: Array.isArray(p.results) ? p.results : [],
    photos: byProject.get(p.id) || [],
  }));
}

export function projectCover(p: Project): string | null {
  return mediaUrl(p.cover_path || p.photos[0]?.storage_path || null);
}

export async function fetchServices(): Promise<Service[]> {
  const rows = await restGet<Service>('services?select=*&is_published=eq.true&order=sort_order.asc');
  return rows.map((r) => ({ ...r, bullets_pl: r.bullets_pl || [], bullets_en: r.bullets_en || [], bullets_ru: r.bullets_ru || [] }));
}

export async function fetchFaq(placement = 'home'): Promise<Faq[]> {
  return restGet<Faq>(`faq_items?select=*&is_published=eq.true&placement=eq.${encodeURIComponent(placement)}&order=sort_order.asc`);
}

// Markdown (services / project bodies) → HTML, same sanitising as the blog.
export function md(src?: string | null): string {
  const safe = String(src ?? '')
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|form)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '');
  return safe.trim() ? (marked.parse(safe, { async: false }) as string) : '';
}

// Plain-text project descriptions were written as paragraphs + "Zakres prac:"
// lists; render them as markdown so line breaks survive.
export function textToMd(src?: string | null): string {
  const t = String(src ?? '').replace(/\r/g, '').trim();
  if (!t) return '';
  return t
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map((x) => x.trim()).filter(Boolean);
      // A heading-like ALL CAPS first line → h3.
      if (lines.length > 1 && /^[A-ZĄĆĘŁŃÓŚŹŻ0-9 —–\-:]+$/.test(lines[0]) && lines[0].length < 80) {
        return `### ${lines[0]}\n\n${lines.slice(1).map((l) => (l.startsWith('-') ? l : `- ${l}`)).join('\n')}`;
      }
      if (/^(zakres|scope|объ[её]м)/i.test(lines[0]) && lines.length > 1) {
        return `**${lines[0]}**\n\n${lines.slice(1).map((l) => (l.startsWith('-') ? l : `- ${l}`)).join('\n')}`;
      }
      return lines.join('  \n');
    })
    .join('\n\n');
}

// First sentence — used where a project has no explicit tagline.
export function firstSentence(src?: string | null, max = 160): string {
  const t = String(src ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,}?[.!?])(\s|$)/);
  const out = m ? m[1] : t;
  return out.length > max ? out.slice(0, max - 1).trimEnd() + '…' : out;
}

export const CATEGORY_LABEL: Record<string, Record<L, string>> = {
  site: { pl: 'Strona', en: 'Website', ru: 'Сайт' },
  shop: { pl: 'Sklep', en: 'Store', ru: 'Магазин' },
  panel: { pl: 'Panel', en: 'Panel', ru: 'Панель' },
  app: { pl: 'Aplikacja', en: 'App', ru: 'Приложение' },
  platform: { pl: 'Platforma', en: 'Platform', ru: 'Платформа' },
  other: { pl: 'Projekt', en: 'Project', ru: 'Проект' },
};
export function categoryLm(p: Project) {
  const fb = CATEGORY_LABEL[p.category_key] || CATEGORY_LABEL.other;
  return {
    'data-lm-pl': p.category_pl || fb.pl,
    'data-lm-en': p.category_en || fb.en,
    'data-lm-ru': p.category_ru || fb.ru,
  };
}
