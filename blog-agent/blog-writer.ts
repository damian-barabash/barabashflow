// ═══════════════════════════════════════════════════════════════════════════
// BarabashFlow blog agent — runs daily on the Mac Studio (launchd).
//
// Pipeline:
//   1. pull config + recent posts/keywords from the blog-ingest Edge Function
//   2. keyword research: live Google Autosuggest (PL) + admin seed topics
//   3. local LLM (Ollama qwen3.5:27b) picks N fresh topics with search intent
//   4. writes each post in PL (SEO: keyword-led title, meta excerpt, question
//      H2s, FAQ for AEO, internal links), then translates to EN and RU
//      (two separate calls — one combined EN+RU response used to overflow
//      num_predict and truncate the JSON)
//   5. finds a CC-licensed cover on Openverse (commercial-use licenses only)
//      and downloads it LOCALLY — the Edge Function's Fly.io egress 502s on
//      many Flickr shards while the Mac fetches them fine (2026-07-06: a post
//      shipped with no cover after 4 consecutive edge-side 502s)
//   6. publishes via blog-ingest (cover travels as base64 in the payload)
//   7. logs the day's keyword research to seo_keywords
//   8. triggers a GitHub Pages rebuild (repository_dispatch) if a PAT is set,
//      then VERIFIES the new posts actually serve 200 on the live site —
//      GH Pages deployments can report success while the CDN keeps serving
//      the previous build (2026-07-06 incident); one re-dispatch, then alert
//   9. reports run status to the admin panel (site_settings.blog_agent_status);
//      a failed run also emails office@ via the Edge Function
//
// Reliability contract:
//   - launchd runs it at 08:40 AND 13:40; the second run is a catch-up — the
//     script counts posts already published today and only writes the missing
//     ones (idempotent, safe to run any number of times per day)
//   - a single failing post never kills the run: keyword logging, the GitHub
//     dispatch and the status report always execute
//   - qwen3.5 is a THINKING model: every request sends think:false, otherwise
//     reasoning tokens silently eat the num_predict budget and the JSON comes
//     back truncated ("Unexpected EOF" — the 2026-07-05 incident)
//
// Run manually:  ~/.bun/bin/bun ~/blog-agent/blog-writer.ts
// Force count :  FORCE_POSTS=1 ~/.bun/bin/bun ~/blog-agent/blog-writer.ts
//                (FORCE_POSTS skips the already-published-today check)
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs';

const CONFIG = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const UA = 'BarabashflowBlogBot/1.0 (+https://barabashflow.pl)';
const TODAY = new Date().toISOString().slice(0, 10);
const STARTED = Date.now();

const DEFAULT_SEEDS = [
  'strona internetowa dla firmy',
  'tworzenie stron internetowych',
  'ile kosztuje strona internetowa',
  'sklep internetowy',
  'strona wizytówka',
  'aplikacja webowa dla firmy',
  'panel administracyjny strony',
  'landing page',
  'pozycjonowanie strony',
  'strona www cena',
  'modernizacja strony internetowej',
  'strona internetowa z CMS',
];

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...a);

// ── Edge Function client ─────────────────────────────────────────────────────
async function edge(action: string, body: Record<string, unknown> = {}) {
  const r = await fetch(CONFIG.edgeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-blog-secret': CONFIG.secret,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(`edge ${action}: ${data.error || r.status}`);
  return data;
}

// Status report → admin panel. Best-effort: must never throw (it runs in error
// paths too) and must not depend on anything else having succeeded.
async function reportStatus(status: Record<string, unknown>) {
  try {
    await edge('report_status', {
      status: { day: TODAY, ts: new Date().toISOString(), duration_s: Math.round((Date.now() - STARTED) / 1000), ...status },
    });
  } catch (err) {
    log('status report failed:', String(err));
  }
}

// ── LLM (local Ollama) ───────────────────────────────────────────────────────
// The model answers with JSON only. Salvage pass strips code fences / stray
// prose around the object before giving up.
function parseJsonLoose(text: string): any {
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* next */ }
  }
  return undefined;
}

// JSON schemas passed as Ollama's `format` — constrains generation to valid,
// correctly-shaped JSON. Plain format:'json' still let the model emit
// unparseable output occasionally (2026-07-06: done_reason=stop, invalid JSON).
const TOPICS_SCHEMA = {
  type: 'object',
  required: ['topics'],
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        required: ['primary_keyword', 'category', 'slug', 'image_query_en'],
        properties: {
          primary_keyword: { type: 'string' },
          category: { type: 'string' },
          supporting_keywords: { type: 'array', items: { type: 'string' } },
          slug: { type: 'string' },
          title_hint: { type: 'string' },
          angle: { type: 'string' },
          image_query_en: { type: 'string' },
        },
      },
    },
  },
};

const ARTICLE_SCHEMA = {
  type: 'object',
  required: ['title_pl', 'excerpt_pl', 'body_pl', 'faq', 'tags', 'keywords'],
  properties: {
    title_pl: { type: 'string' },
    excerpt_pl: { type: 'string' },
    body_pl: { type: 'string' },
    faq: {
      type: 'array',
      items: { type: 'object', required: ['q', 'a'], properties: { q: { type: 'string' }, a: { type: 'string' } } },
    },
    tags: { type: 'array', items: { type: 'string' } },
    keywords: { type: 'array', items: { type: 'string' } },
  },
};

const TRANSLATION_SCHEMA = {
  type: 'object',
  required: ['title', 'excerpt', 'body'],
  properties: {
    title: { type: 'string' },
    excerpt: { type: 'string' },
    body: { type: 'string' },
  },
};

async function llmJson(system: string, user: string, temperature = 0.5, maxTokens = 8192, schema?: object): Promise<any> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    // The dominant failure mode is JSON truncated by the output budget
    // (done_reason "length") — retries escalate num_predict instead of
    // repeating the same doomed request.
    const numPredict = Math.round(maxTokens * (1 + 0.5 * (attempt - 1)));
    try {
      // stream:true — generation takes minutes; a non-streaming response sends
      // zero bytes until done, which trips the HTTP client's idle timeout.
      const r = await fetch(`${CONFIG.ollamaUrl}/api/chat`, {
        method: 'POST',
        signal: AbortSignal.timeout(20 * 60 * 1000),
        body: JSON.stringify({
          model: CONFIG.model,
          format: schema ?? 'json',
          stream: true,
          think: false,
          keep_alive: '30m',
          options: { temperature, num_ctx: 16384, num_predict: numPredict },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!r.ok || !r.body) throw new Error(`ollama HTTP ${r.status}`);
      let text = '';
      let buf = '';
      let doneReason = '';
      let evalCount = 0;
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const chunk = JSON.parse(line);
            text += chunk?.message?.content ?? '';
            if (chunk?.done) {
              doneReason = chunk.done_reason || '';
              evalCount = chunk.eval_count || 0;
            }
          } catch { /* partial line */ }
        }
      }
      const parsed = parseJsonLoose(text);
      if (parsed === undefined) {
        log(`unparseable output head: ${JSON.stringify(text.slice(0, 220))}`);
        throw new Error(`unparseable JSON (done_reason=${doneReason || '?'}, ${evalCount} tok out, ${text.length} chars)`);
      }
      if (doneReason === 'length') log(`warning: output hit num_predict=${numPredict} but JSON still parsed`);
      return parsed;
    } catch (err) {
      log(`llm attempt ${attempt} failed (num_predict=${numPredict}):`, String(err));
      if (attempt === 3) throw err;
    }
  }
}

// ── Keyword research (Google Autosuggest, PL) ────────────────────────────────
async function googleSuggest(q: string): Promise<string[]> {
  try {
    // ie/oe=utf-8 is mandatory: without oe Google answers in ISO-8859-1 and
    // Polish diacritics decode to U+FFFD mojibake in the admin panel.
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=pl&gl=pl&ie=utf-8&oe=utf-8&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data?.[1]) ? data[1].map(String) : [];
  } catch {
    return [];
  }
}

async function research(seedExtra: string[]): Promise<string[]> {
  const seeds = [...new Set([...seedExtra, ...DEFAULT_SEEDS])].slice(0, 16);
  const found = new Map<string, number>();
  const add = (s: string) => {
    const k = s.toLowerCase().trim();
    if (k.length < 8 || k.length > 90) return;
    if (k.includes('\uFFFD')) return; // corrupted encoding — never log mojibake
    if (!/stron|sklep|www|aplikacj|platform|landing|seo|internetow|web|cms|e-commerce|wizytówk/.test(k)) return;
    found.set(k, (found.get(k) || 0) + 1);
  };
  for (const seed of seeds) {
    (await googleSuggest(seed)).forEach(add);
    await Bun.sleep(180);
  }
  // Letter expansion on the strongest commercial seeds — surfaces long-tails.
  for (const seed of ['strona internetowa ', 'ile kosztuje strona ', 'sklep internetowy ']) {
    for (const ch of ['a', 'c', 'd', 'i', 'j', 'k', 'n', 'p', 's', 'w', 'z']) {
      (await googleSuggest(seed + ch)).forEach(add);
      await Bun.sleep(150);
    }
  }
  const ranked = [...found.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  log(`research: ${ranked.length} unique suggestions`);
  return ranked;
}

// ── Openverse cover (CC / commercial-use licensed) ───────────────────────────
// Falls back through progressively broader queries — LLM-generated queries are
// sometimes too specific and return zero results.
//
// usedCovers holds cover_source_url of recent posts + every pick made this
// run (also failed downloads). Both 2026-07-05 posts fell back to the same
// generic query and got the IDENTICAL first result — never reuse a photo,
// and never re-pick one whose download already failed.
//
// The image is downloaded HERE, on the Mac — the Edge Function's Fly.io
// egress 502s on many Flickr shards that respond 200 locally. A candidate
// only wins after its bytes are actually in hand, so a published post can no
// longer end up cover-less because of a remote fetch flake.
const coverKey = (x: any) => String(x.foreign_landing_url || x.url);
const MAX_COVER_BYTES = 6 * 1024 * 1024;

// Flickr's CDN answers 502 to fetch()-style clients whose User-Agent contains
// "Bot" (curl with the same UA gets 200 — it keys on the whole fingerprint).
// That was the source of ALL the cover 502s, worker- and edge-side alike. Use
// a browser UA for image downloads only; API calls keep the honest bot UA.
const IMG_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function downloadImage(url: string): Promise<{ b64: string; contentType: string; kb: number }> {
  const r = await fetch(url, {
    headers: { 'User-Agent': IMG_UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const contentType = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\/(jpeg|png|webp|avif|gif)$/.test(contentType)) throw new Error(`not an image: ${contentType}`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_COVER_BYTES) throw new Error(`too big: ${buf.byteLength}`);
  if (buf.byteLength < 1024) throw new Error(`suspiciously small: ${buf.byteLength}`);
  return { b64: Buffer.from(buf).toString('base64'), contentType, kb: Math.round(buf.byteLength / 1024) };
}

async function findCover(query: string, usedCovers: Set<string>) {
  const attempts = [
    query,
    query.split(/\s+/).slice(0, 2).join(' '),
    'modern website laptop',
    'laptop office desk',
  ].filter((q, i, a) => q && a.indexOf(q) === i);

  for (const q of attempts) {
    try {
      const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license_type=commercial&page_size=20`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!r.ok) throw new Error(`openverse ${r.status}`);
      const data = await r.json();
      const results = (data?.results ?? []).filter((x: any) =>
        x.url && (x.width ?? 0) >= 900 && /jpe?g|png|webp/i.test(x.filetype || x.url),
      );
      // Walk the fresh candidates and take the first whose bytes download.
      for (const pick of results) {
        if (usedCovers.has(coverKey(pick))) continue;
        usedCovers.add(coverKey(pick));
        try {
          const img = await downloadImage(String(pick.url));
          log(`openverse: cover for "${q}" (${pick.width}px, ${pick.license}, ${img.kb} KB downloaded locally)`);
          return {
            cover_b64: img.b64,
            cover_content_type: img.contentType,
            cover_credit: `Foto: ${pick.creator || 'autor nieznany'} · ${String(pick.license || 'cc').toUpperCase()} · Openverse`,
            cover_source_url: pick.foreign_landing_url || pick.url,
          };
        } catch (err) {
          log(`cover download failed for "${q}" (${pick.url}):`, String(err));
        }
      }
      log(`openverse: no downloadable fresh results for "${q}"`);
    } catch (err) {
      log(`openverse failed for "${q}":`, String(err));
    }
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function slugify(s: string): string {
  const map: Record<string, string> = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };
  return s.toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (c) => map[c] || c)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 70) || `wpis-${TODAY}`;
}
const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

// One language per call — the combined EN+RU response was the biggest output
// of the whole pipeline and the first thing to truncate.
async function translateInto(art: any, lang: { code: 'en' | 'ru'; name: string }) {
  const out = await llmJson(
    `Jesteś tłumaczem. Odpowiadasz WYŁĄCZNIE poprawnym JSON-em.`,
    `Przetłumacz ten wpis blogowy na ${lang.name} (markdown zachowaj, linki zostaw bez zmian). Zwróć JSON {"title":"...","excerpt":"...","body":"..."}.\n\nTYTUŁ: ${art.title_pl}\nEXCERPT: ${art.excerpt_pl}\nTREŚĆ:\n${art.body_pl}`,
    0.3,
    8192,
    TRANSLATION_SCHEMA,
  );
  if (!out?.title || !out?.body) throw new Error(`empty ${lang.code} translation`);
  return out;
}

async function githubDispatch(): Promise<boolean> {
  try {
    const r = await fetch(`https://api.github.com/repos/${CONFIG.github.repo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.github.pat}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': UA,
      },
      body: JSON.stringify({ event_type: 'blog-publish' }),
    });
    log(`github dispatch: ${r.status}`);
    return r.status < 300;
  } catch (err) {
    log('github dispatch failed:', String(err));
    return false;
  }
}

// Poll the live site until every slug serves 200 (or the deadline passes).
// Returns the slugs that are still missing. The cache-buster query matters:
// GH Pages sits behind Fastly with max-age=600, and a stale cached 404 would
// make a freshly deployed page look missing for another 10 minutes.
async function verifyLive(slugs: string[], timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let missing = [...slugs];
  while (missing.length && Date.now() < deadline) {
    await Bun.sleep(30_000);
    const still: string[] = [];
    for (const slug of missing) {
      try {
        const r = await fetch(`https://barabashflow.pl/blog/${slug}/?live=${Date.now()}`, {
          headers: { 'User-Agent': UA },
          redirect: 'follow',
          signal: AbortSignal.timeout(15000),
        });
        if (r.status !== 200) still.push(slug);
      } catch {
        still.push(slug);
      }
    }
    missing = still;
  }
  return missing;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log('blog agent start');
  const { posts: recentPosts, keywords: recentKw, config } = await edge('recent');
  if (!config.enabled) { log('autopilot disabled in admin — exiting'); return; }

  // Idempotency: launchd fires at 08:40 and again at 13:40 (catch-up). Count
  // what today already has and only write the difference.
  const postsToday = recentPosts.filter((p: any) => String(p.published_at || '').slice(0, 10) === TODAY).length;
  const forced = Number(process.env.FORCE_POSTS);
  const target = Number.isFinite(forced) && forced > 0
    ? forced
    : randInt(config.posts_min ?? 1, config.posts_max ?? 2);
  const n = Number.isFinite(forced) && forced > 0 ? forced : target - postsToday;
  if (n <= 0) {
    log(`already ${postsToday} post(s) published today (target ${target}) — nothing to do`);
    await reportStatus({ ok: true, planned: 0, published: [], errors: [], note: `already ${postsToday}/${target} today` });
    return;
  }
  log(`plan: ${n} post(s) (${postsToday} already today); ${recentPosts.length} recent posts known`);

  const suggestions = await research(config.seed_keywords ?? []);
  const usedSlugs = new Set(recentPosts.map((p: any) => p.slug));
  const usedCovers = new Set<string>(recentPosts.map((p: any) => String(p.cover_source_url || '')).filter(Boolean));
  const recentTitles = recentPosts.slice(0, 40).map((p: any) => p.title_pl);
  const recentPicked = recentKw.filter((k: any) => k.picked).map((k: any) => k.keyword);

  // Mniej wiecej co trzeci run: jeden temat popularny (head/mid-tail) —
  // wysoki wolumen buduje topical authority; reszta zostaje long-tail.
  const includePopular = Math.random() < 0.35;
  const popularHint = includePopular
    ? 'DZISIAJ DODATKOWO: dokladnie JEDEN z tematow zrob POPULARNY zamiast long-tail — krotka, wysokowolumenowa fraza, ktora ludzie wpisuja najczesciej (np. "tworzenie stron internetowych", "strona internetowa dla firmy", "jak zalozyc sklep internetowy"). Mimo wiekszej konkurencji taki wpis buduje topical authority. Zasady roznorodnosci i zakaz powtorki ceny obowiazuja takze dla niego. Pozostale tematy nadal long-tail.\n\n'
    : '';

  // 1) Topic selection
  const topicsResp = await llmJson(
    `Jesteś strategiem SEO polskiego studia web-developmentu BarabashFlow (Dmytrii Barabash, Warszawa; barabashflow.pl; usługi: strony internetowe, platformy/aplikacje webowe, panele CMS, sklepy internetowe). Odpowiadasz WYŁĄCZNIE poprawnym JSON-em.`,
    `Świeże podpowiedzi z Google (co ludzie realnie wpisują dzisiaj):\n${suggestions.slice(0, 90).join('\n')}\n\n` +
    (config.seed_keywords?.length ? `Tematy wskazane przez właściciela (PRIORYTET):\n${config.seed_keywords.join('\n')}\n\n` : '') +
    `Ostatnie wpisy bloga (NIE powtarzaj tematów):\n${recentTitles.join('\n') || '(brak)'}\n\n` +
    `Słowa już użyte:\n${recentPicked.slice(0, 60).join(', ') || '(brak)'}\n\n` +
    `Wybierz ${n} tematów na dzisiejsze wpisy blogowe. Kryteria: intencja komercyjna lub pytanie potencjalnego klienta, długi ogon (mniejsza konkurencja), brak powtórek z ostatnich wpisów.\n\nRÓŻNORODNOŚĆ (najważniejsze kryterium): każdy z dzisiejszych tematów MUSI należeć do INNEJ kategorii intencji, a żaden nie może powtarzać kategorii dominującej w 5 ostatnich wpisach bloga (rozpoznasz ją po tytułach wyżej). Kategorie: (1) cena — "ile kosztuje…"; (2) porównanie — "X czy Y", "co lepsze"; (3) proces — "jak długo trwa", "jak wygląda", "etapy"; (4) wybór wykonawcy — "jak wybrać", "na co uważać"; (5) błędy i checklisty — "najczęstsze błędy", "o czym pamiętać przed…"; (6) technologia prosto wyjaśniona — "co to jest…", "czym różni się…"; (7) SEO i widoczność w Google/AI; (8) strona dla konkretnej branży — "strona internetowa dla <branża>". Tematu o cenie NIE wybieraj, jeśli którykolwiek z 5 ostatnich wpisów był o cenie.\n\n${popularHint}Zwróć JSON:\n` +
    `{"topics":[{"primary_keyword":"...","category":"nazwa kategorii z listy","supporting_keywords":["..."],"slug":"kebab-case-po-polsku-bez-znakow","title_hint":"...","angle":"jedna linia o ujęciu tematu","image_query_en":"2-4 English words for a stock photo"}]}`,
    0.4,
    2048,
    TOPICS_SCHEMA,
  );
  const topics = (topicsResp?.topics ?? []).slice(0, n);
  if (!topics.length) throw new Error('no topics from LLM');

  const published: string[] = [];
  const errors: string[] = [];
  const pickedKw = new Set<string>();

  // Each topic is isolated: one failed post must not kill the others, the
  // keyword log, the rebuild dispatch or the status report.
  for (const t of topics) {
    try {
      let slug = slugify(t.slug || t.primary_keyword || 'wpis');
      if (usedSlugs.has(slug)) slug = `${slug}-${TODAY.replace(/-/g, '')}`.slice(0, 78);

      log(`writing: ${t.primary_keyword} -> ${slug}`);

      // 2) Polish article
      const YEAR = new Date().getFullYear();
      const art = await llmJson(
        `Piszesz blog firmowy studia BarabashFlow (Dmytrii Barabash, Warszawa). Mamy rok ${YEAR} — jeśli podajesz rok, używaj ${YEAR}. Piszesz po polsku, pierwsza osoba liczby pojedynczej, konkretnie, bez lania wody i bez żargonu. Nie wymyślaj nazw klientów ani statystyk. Odpowiadasz WYŁĄCZNIE poprawnym JSON-em.`,
        `Napisz wpis blogowy pod frazę kluczową: "${t.primary_keyword}".\nFrazy wspierające: ${(t.supporting_keywords || []).join(', ')}.\nUjęcie: ${t.angle || '-'}.\n\nWymagania SEO:\n- title_pl: maks. 62 znaki, fraza kluczowa blisko początku, bez clickbaitu\n- excerpt_pl: 140-158 znaków, zachęca do kliknięcia, zawiera frazę (to meta description)\n- body_pl: markdown, MINIMUM 800 słów (docelowo 800-1100). BEZ nagłówka H1 (strona doda tytuł sama). Struktura: krótki lead (2-3 zdania z frazą kluczową), potem 4-6 sekcji H2 sformułowanych jak pytania które ludzie wpisują w Google, listy punktowane, konkretne przedziały cen w PLN gdy temat o kosztach, przykłady. Frazy wspierające wplataj NATURALNIE i gramatycznie — odmieniaj je przez przypadki, nigdy nie wklejaj surowej frazy łamiącej składnię zdania. Dodaj DOKŁADNIE dwa linki wewnętrzne w treści: [strony internetowe — BarabashFlow](https://barabashflow.pl/) oraz [blog BarabashFlow](https://barabashflow.pl/blog/). Zakończ krótkim akapitem-CTA zapraszającym do kontaktu przez formularz na barabashflow.pl.\n- faq: 3 pytania i zwięzłe odpowiedzi (2-3 zdania), sformułowane jak realne zapytania\n- tags: 3-5 krótkich tagów po polsku\n- keywords: 5-10 fraz (primary + supporting + odmiany)\n\nZwróć JSON: {"title_pl":"...","excerpt_pl":"...","body_pl":"...","faq":[{"q":"...","a":"..."}],"tags":["..."],"keywords":["..."]}`,
        0.6,
        8192,
        ARTICLE_SCHEMA,
      );
      if (!art?.title_pl || !art?.body_pl) { log('article missing fields — skipping topic'); errors.push(`${t.primary_keyword}: article missing fields`); continue; }

      // 3) EN/RU translations — independent calls, each optional.
      const tr: Record<string, string> = {};
      for (const lang of [{ code: 'en', name: 'angielski' }, { code: 'ru', name: 'rosyjski' }] as const) {
        try {
          const out = await translateInto(art, lang);
          tr[`title_${lang.code}`] = out.title;
          tr[`excerpt_${lang.code}`] = out.excerpt ?? '';
          tr[`body_${lang.code}`] = out.body;
        } catch (err) {
          log(`translation ${lang.code} failed — publishing without it:`, String(err));
        }
      }

      // 4) Cover from Openverse
      const cover = await findCover(t.image_query_en || 'modern website design laptop', usedCovers);

      // 5) Publish
      const res = await edge('ingest_post', {
        post: {
          slug,
          title_pl: art.title_pl,
          excerpt_pl: art.excerpt_pl,
          body_pl: art.body_pl,
          title_en: tr.title_en ?? null,
          excerpt_en: tr.excerpt_en ?? null,
          body_en: tr.body_en ?? null,
          title_ru: tr.title_ru ?? null,
          excerpt_ru: tr.excerpt_ru ?? null,
          body_ru: tr.body_ru ?? null,
          cover_alt: art.title_pl,
          ...(cover ?? {}),
          tags: art.tags ?? [],
          keywords: art.keywords ?? [],
          faq: art.faq ?? [],
          meta: { agent: 'mac-studio', model: CONFIG.model, primary_keyword: t.primary_keyword, day: TODAY },
        },
      });
      log(`published: /blog/${res.slug}/ (cover: ${res.cover_path || 'none'})`);

      // Every post must have a photo — if the cover still didn't make it
      // (upload-side failure; download flakes are already handled locally),
      // retry with progressively generic queries.
      if (!res.cover_path) {
        for (const q of ['modern website laptop', 'laptop office desk', 'computer work desk']) {
          const c2 = await findCover(q, usedCovers);
          if (!c2) continue;
          try {
            const fix = await edge('set_cover', { slug: res.slug, cover_alt: art.title_pl, ...c2 });
            log(`cover attached retroactively: ${fix.cover_path}`);
            break;
          } catch (err) {
            log('set_cover retry failed:', String(err));
          }
        }
      }

      published.push(res.slug);
      usedSlugs.add(slug);
      [t.primary_keyword, ...(t.supporting_keywords || [])].forEach((k: string) => k && pickedKw.add(k.toLowerCase()));
    } catch (err) {
      log(`post "${t.primary_keyword}" failed:`, String(err));
      errors.push(`${t.primary_keyword}: ${String(err)}`);
    }
  }

  // 6) Log the research (runs even when a post failed — the admin panel shows
  // the day's research either way).
  try {
    const items = [
      ...[...pickedKw].map((k) => ({ keyword: k, picked: true, source: 'llm-pick' })),
      ...suggestions.slice(0, 120).map((k) => ({ keyword: k, picked: pickedKw.has(k), source: 'google-suggest' })),
    ];
    await edge('log_keywords', { day: TODAY, items });
    log(`keywords logged: ${items.length}`);
  } catch (err) {
    log('keyword logging failed:', String(err));
    errors.push(`log_keywords: ${String(err)}`);
  }

  // 7) Rebuild the static site so new posts get real pages — and VERIFY they
  // actually serve. On 2026-07-06 the dispatched build + Pages deployment both
  // reported success while the CDN kept serving the previous day's content;
  // nothing noticed until the owner did. Published-in-DB is not done —
  // reachable-on-the-site is done.
  if (published.length && CONFIG.github?.pat) {
    const dispatched = await githubDispatch();
    if (dispatched) {
      log('verifying new posts on the live site (build usually takes ~2 min)…');
      let missing = await verifyLive(published, 10 * 60_000);
      if (missing.length) {
        log(`still missing after 10 min: ${missing.join(', ')} — re-dispatching once`);
        await githubDispatch();
        missing = await verifyLive(missing, 12 * 60_000);
      }
      if (missing.length) {
        errors.push(`live verification failed: ${missing.map((s) => `/blog/${s}/`).join(', ')} not on the site after rebuild + retry`);
      } else {
        log('live verification OK — all new posts are on the site');
      }
    } else {
      errors.push('github dispatch failed — site not rebuilt');
    }
  } else if (published.length) {
    log('no GitHub PAT configured — site will pick posts up on the next scheduled build');
  }

  // 8) Status → admin panel (+ alert email from the Edge Function on failure)
  await reportStatus({
    ok: errors.length === 0 && published.length >= Math.min(n, 1),
    planned: n,
    published,
    errors: errors.slice(0, 6),
  });

  log(`done: ${published.length}/${n} post(s): ${published.join(', ') || '—'}${errors.length ? ` · ${errors.length} error(s)` : ''}`);
}

main().catch(async (err) => {
  console.error('[blog-agent] FAILED:', err);
  await reportStatus({ ok: false, planned: null, published: [], errors: [String(err?.message || err)] });
  process.exit(1);
});
