// Shared helpers for the blog agent v2 (2026-11-16): Supabase REST (service
// role), Claude (structured JSON), Unsplash (search + aesthetic pick by Claude
// vision + download tracking), status reporting. Runs under Bun on the Mac
// Studio; secrets live only in ./config.json (chmod 600, never in git).
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';

export const CFG: {
  supabaseUrl: string;
  serviceKey: string;
  anthropicKey: string;
  unsplashKey: string;
  edgeUrl: string;
  secret: string;
  bufferDays?: number;
  maxPerRun?: number;
} = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

export const log = (...a: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...a);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Supabase REST ───────────────────────────────────────────────────────────
// Every call retries transient failures (network, 5xx, 429): one hiccup must
// not cost a day (2026-09-12 "vault error" incident). 4xx throws at once.
export async function db<T = any>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
  const delays = [3000, 15000, 45000];
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    let err: unknown = null;
    try {
      res = await fetch(`${CFG.supabaseUrl}/rest/v1/${path}`, {
        ...init,
        headers: {
          apikey: CFG.serviceKey,
          Authorization: `Bearer ${CFG.serviceKey}`,
          'Content-Type': 'application/json',
          ...(init.prefer ? { Prefer: init.prefer } : {}),
          ...(init.headers || {}),
        },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) { err = e; }
    if (res && res.ok) {
      const txt = await res.text();
      return (txt ? JSON.parse(txt) : null) as T;
    }
    const transient = !res || res.status >= 500 || res.status === 429;
    const detail = res ? `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}` : String(err);
    if (!transient || attempt >= delays.length) throw new Error(`db ${init.method || 'GET'} ${path.split('?')[0]}: ${detail}`);
    log(`db transient (${detail}) — retry in ${delays[attempt] / 1000}s`);
    await sleep(delays[attempt]);
  }
}

// Remove files from the public `media` bucket (old Openverse covers replaced
// by Unsplash hotlinks). Best effort — a leftover file only costs storage.
export async function removeMedia(paths: string[]) {
  const list = paths.filter((p) => p && !/^https?:/.test(p));
  if (!list.length) return;
  try {
    await fetch(`${CFG.supabaseUrl}/storage/v1/object/media`, {
      method: 'DELETE',
      headers: { apikey: CFG.serviceKey, Authorization: `Bearer ${CFG.serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: list }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) { log('removeMedia failed', String(e)); }
}

export async function reportStatus(status: Record<string, unknown>) {
  for (const wait of [0, 5000, 20000]) {
    if (wait) await sleep(wait);
    try {
      const r = await fetch(CFG.edgeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-blog-secret': CFG.secret },
        body: JSON.stringify({ action: 'report_status', status }),
        signal: AbortSignal.timeout(30_000),
      });
      if (r.ok) return;
      log('report_status HTTP', r.status);
    } catch (e) { log('report_status failed', String(e)); }
  }
}

// ── Claude ──────────────────────────────────────────────────────────────────
export const claude = new Anthropic({ apiKey: CFG.anthropicKey, maxRetries: 4, timeout: 15 * 60_000 });

type Content = Anthropic.Messages.ContentBlockParam[] | string;

// ── cost control ────────────────────────────────────────────────────────────
// Budget (admin → Blog → "Budżet AI", site_settings.ai_budget.monthly_usd)
// covers blog + leads + estimator. Every call is logged to ai_usage.
export const MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' } as const;
type ModelKey = keyof typeof MODELS;
const PRICE: Record<ModelKey, [number, number]> = { opus: [4, 20], sonnet: [2, 10], haiku: [0.1, 0.5] }; // $/1M in, out

export async function monthSpend(): Promise<{ spent: number; cap: number }> {
  const [spent, rows] = await Promise.all([
    db<number>('rpc/ai_month_spend', { method: 'POST', body: '{}' }),
    db<any[]>('site_settings?select=value_meta&key=eq.ai_budget'),
  ]);
  return { spent: Number(spent) || 0, cap: Number(rows?.[0]?.value_meta?.monthly_usd) || 15 };
}
async function logUsage(feature: string, model: ModelKey, usage: any) {
  const i = usage?.input_tokens || 0, o = usage?.output_tokens || 0;
  const cost = (i * PRICE[model][0] + o * PRICE[model][1]) / 1e6;
  await db('ai_usage', { method: 'POST', body: JSON.stringify({ feature, model: MODELS[model], input_tokens: i, output_tokens: o, cost_usd: Number(cost.toFixed(5)) }) }).catch((e) => log('usage log failed', String(e)));
}

// Structured JSON call. Opus = adaptive thinking (can't be disabled; effort
// controls depth); Sonnet 5.5 = thinking off via `between_tools`; Haiku 5.5 =
// thinking disabled. Streams, validates stop_reason, logs cost, one retry.
export async function claudeJson<T = any>(opts: {
  system: string;
  content: Content;
  schema: Record<string, unknown>;
  model?: ModelKey;
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
  label: string;
}): Promise<T> {
  const model = opts.model ?? 'opus';
  let maxTokens = opts.maxTokens ?? 32000;
  const thinking = model === 'haiku' ? { thinking: { type: 'disabled' } } : model === 'sonnet' ? { thinking: { type: 'between_tools' } } : {};
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    const stream = claude.messages.stream({
      model: MODELS[model],
      max_tokens: maxTokens,
      system: opts.system,
      ...thinking,
      output_config: { effort: opts.effort ?? (model === 'opus' ? 'medium' : 'low'), format: { type: 'json_schema', schema: opts.schema } },
      messages: [{ role: 'user', content: opts.content }],
    } as any);
    const msg = await stream.finalMessage();
    const u = msg.usage as any;
    await logUsage(opts.label.split(' ')[0], model, u);
    log(`claude[${model}] ${opts.label}: ${msg.stop_reason}, in ${u.input_tokens} out ${u.output_tokens} (${Math.round((Date.now() - t0) / 1000)}s)`);
    if (msg.stop_reason === 'refusal') throw new Error(`claude ${opts.label}: refusal`);
    const text = msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    if (msg.stop_reason === 'max_tokens') { maxTokens = Math.min(maxTokens * 2, 64000); continue; }
    try { return JSON.parse(text) as T; }
    catch { log(`claude ${opts.label}: unparseable JSON (${text.slice(0, 160)})`); }
  }
  throw new Error(`claude ${opts.label}: no valid JSON after 2 attempts`);
}

// ── Unsplash ────────────────────────────────────────────────────────────────
// Demo apps get 50 requests/hour (search AND download-tracking both count), so
// one search per post feeds the cover and the inline photos; the remaining
// budget is read from the response header and callers back off on it.
export let unsplashRemaining = 50;
const US = 'https://api.unsplash.com';

async function unsplash(path: string): Promise<any> {
  for (const wait of [0, 4000, 15000]) {
    if (wait) await sleep(wait);
    const r = await fetch(`${US}${path}`, { headers: { Authorization: `Client-ID ${CFG.unsplashKey}`, 'Accept-Version': 'v1' }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!r) continue;
    const rem = Number(r.headers.get('x-ratelimit-remaining'));
    if (Number.isFinite(rem)) unsplashRemaining = rem;
    if (r.status === 403 && unsplashRemaining <= 0) throw new Error('unsplash rate limit exhausted');
    if (r.ok) return r.json();
    if (r.status < 500) throw new Error(`unsplash ${path.split('?')[0]}: HTTP ${r.status}`);
  }
  throw new Error(`unsplash ${path.split('?')[0]}: unreachable`);
}

export interface Photo {
  id: string; url: string; thumb: string; width: number; height: number; color: string | null; likes: number;
  description: string; author: string; author_url: string; page_url: string; download_location: string;
}

export async function searchPhotos(query: string, used: Set<string>): Promise<Photo[]> {
  const q = encodeURIComponent(query.slice(0, 100));
  const j = await unsplash(`/search/photos?query=${q}&per_page=30&orientation=landscape&content_filter=high&order_by=relevant`);
  return (j.results || [])
    .filter((p: any) => !p.premium && !p.plus && !used.has(p.id) && p.width >= 2400 && p.width / p.height >= 1.25)
    .map((p: any) => ({
      id: p.id, url: p.urls.raw, thumb: p.urls.small, width: p.width, height: p.height, color: p.color, likes: p.likes,
      description: (p.alt_description || p.description || '').slice(0, 140),
      author: p.user?.name || 'Unsplash', author_url: p.user?.links?.html || 'https://unsplash.com',
      page_url: p.links?.html, download_location: p.links?.download_location,
    }));
}

// Unsplash API guideline: trigger the download endpoint when a photo is used.
export async function trackDownload(p: Photo) {
  try { await unsplash(p.download_location.replace(US, '')); } catch (e) { log('unsplash track failed', String(e)); }
}

// Claude looks at the candidates and picks the most beautiful, on-brand set:
// a cover + N inline photos that fit given section intents.
const PICK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['cover', 'inline', 'why'],
  properties: {
    cover: { type: 'integer' },
    inline: { type: 'array', items: { type: 'integer' } },
    why: { type: 'string' },
  },
};

export async function pickPhotos(cands: Photo[], brief: { title: string; coverIdea: string; inline: string[]; style?: string }): Promise<{ cover: Photo; inline: Photo[] }> {
  const list = cands.slice(0, 16);
  if (list.length < 1 + brief.inline.length) throw new Error(`too few photo candidates (${list.length})`);
  const content: Anthropic.Messages.ContentBlockParam[] = [];
  list.forEach((p, i) => {
    content.push({ type: 'text', text: `#${i} — ${p.description || 'no description'} (likes ${p.likes})` });
    content.push({ type: 'image', source: { type: 'url', url: p.thumb } } as any);
  });
  content.push({
    type: 'text',
    text: `Artykuł: "${brief.title}".
Okładka: ${brief.coverIdea}
Zdjęcia w treści (po kolei): ${brief.inline.map((x, i) => `[${i + 1}] ${x}`).join(' ')}
Wybierz numer zdjęcia na okładkę i ${brief.inline.length} RÓŻNE numery do treści (w kolejności intencji). Wszystkie numery różne.`,
  });
  try {
    const r = await claudeJson<{ cover: number; inline: number[]; why: string }>({
      label: 'photo-pick',
      model: 'haiku',
      effort: 'low',
      maxTokens: 4000,
      schema: PICK_SCHEMA,
      system: `Jesteś photo-editorem premium studia webowego (estetyka: jasna, editorialowa, minimalistyczna, naturalne światło, dużo powietrza, spokojne kolory; nowoczesne biura, detale, architektura, ludzie przy pracy w naturalnych sytuacjach).
Odrzucaj: kiczowate stocki (uśmiechnięci ludzie do kamery, uścisk dłoni, garnitury z kciukiem w górę), zdjęcia z czytelnym tekstem/logo marek, ekrany z kodem jak z filmów o hakerach, przesycone kolory, niska jakość, mocne winiety.
Okładka ma działać w kadrze 16:9 i jako miniatura — wyraźny motyw, spokojne tło. Zdjęcia w treści mają pasować do intencji sekcji i do siebie stylistycznie.${brief.style ? `\nSTYL WG WŁAŚCICIELA (priorytet): ${brief.style}` : ''}`,
      content,
    });
    const ids = [r.cover, ...r.inline];
    const valid = ids.every((i) => Number.isInteger(i) && i >= 0 && i < list.length) && new Set(ids).size === ids.length && r.inline.length === brief.inline.length;
    if (valid) { log(`photo pick: ${r.why.slice(0, 160)}`); return { cover: list[r.cover], inline: r.inline.map((i) => list[i]) }; }
    log('photo pick: invalid indices, falling back to likes order');
  } catch (e) { log('photo pick failed, falling back to likes order:', String(e)); }
  const byLikes = [...list].sort((a, b) => b.likes - a.likes);
  return { cover: byLikes[0], inline: byLikes.slice(1, 1 + brief.inline.length) };
}

export function imageRecord(p: Photo, role: 'cover' | 'inline', extra: Record<string, unknown>) {
  return {
    role, id: p.id, url: p.url, width: p.width, height: p.height, color: p.color,
    author: p.author, author_url: p.author_url, page_url: p.page_url, ...extra,
  };
}

// ── text utils ──────────────────────────────────────────────────────────────
export function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/ą/g, 'a').replace(/ć/g, 'c').replace(/ę/g, 'e').replace(/ł/g, 'l').replace(/ń/g, 'n')
    .replace(/ó/g, 'o').replace(/ś/g, 's').replace(/[źż]/g, 'z')
    .normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 72).replace(/-$/, '');
}
export const h2Count = (md: string) => (String(md || '').match(/^## /gm) || []).length;
export const words = (md: string) => String(md || '').split(/\s+/).filter(Boolean).length;
