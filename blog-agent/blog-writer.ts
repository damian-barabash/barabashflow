// Blog agent v2 (2026-11-16) — Mac Studio, launchd every 3 h (idempotent).
//
// Why v2: v1 picked topics from Google Autosuggest and wrote with a local
// 27B model. After 269 posts the niche was exhausted (2026-11-15/16: "no
// usable topics" two days in a row) and the corpus was full of duplicates and
// brand junk. v2:
//   1. EDITORIAL PLAN — Claude plans topics into `blog_topics` (queue ≥ 12)
//      across content pillars × formats, seeing every existing title, so the
//      writer never runs dry; admin "own topics" jump the queue.
//   2. BUFFER — posts are written days ahead as `scheduled` (one per day,
//      `scheduled_for`). Publication itself is cloud-side (pg_cron
//      blog_publish_due() 06:00 UTC → rebuild; watchdog verifies live). A dead
//      Mac costs nothing until the buffer (7 days) runs out — and the
//      watchdog alerts long before.
//   3. QUALITY — Claude Opus writes from real studio data (prices from
//      `services`, case studies from `projects`, internal links only to pages
//      that exist), code-level QA + one repair round, EN/RU translations that
//      must keep the section structure.
//   4. PHOTOS — one Unsplash search per post (50 req/h budget), Claude vision
//      picks a beautiful cover + 2 inline photos, hotlinked with attribution.
// Every run reports to site_settings.blog_agent_status (admin + watchdog
// heartbeat); errors alert by email via edge report_status.
import { CFG, db, log, monthSpend, sleep, claudeJson, reportStatus, searchPhotos, pickPhotos, trackDownload, imageRecord, slugify, h2Count, words, unsplashRemaining, type Photo } from './lib';

const QUEUE_MIN = 12;
const SITE = 'https://barabashflow.pl';
const STARTED = Date.now();

const PILLARS: Record<string, string> = {
  koszty: 'Koszty i budżet — ile kosztuje, z czego wynika cena, jak nie przepłacić, utrzymanie',
  proces: 'Proces i współpraca — etapy, brief, terminy, jak pracować z wykonawcą, umowy, odbiór',
  technologia: 'Technologia po ludzku — CMS, WordPress vs dedykowane, Astro/Next.js, hosting, bezpieczeństwo, szybkość',
  seo: 'Widoczność — SEO własnej strony, Google, AI Overviews/ChatGPT (GEO), lokalne SEO, treści',
  konwersja: 'Konwersja i UX — jak strona ma sprzedawać, formularze, CTA, zaufanie, mobile',
  ecommerce: 'E-commerce — sklepy internetowe, płatności, katalog, integracje, marketplace vs własny sklep',
  branze: 'Strona dla konkretnej branży — co musi mieć strona firmy X (szkolenia, beauty, motoryzacja, gastronomia, prawnicy, medycyna, produkcja, nieruchomości…)',
  case: 'Z praktyki studia — rozbiór realnej realizacji BarabashFlow: problem klienta → decyzje → efekt',
  trendy: 'Trendy i AI — co się zmienia w stronach/aplikacjach w 2026–2027, AI w firmie, automatyzacja',
};
const FORMATS: Record<string, string> = {
  przewodnik: 'przewodnik krok po kroku',
  checklista: 'checklista do odhaczenia (z krótkim uzasadnieniem każdego punktu)',
  porownanie: 'porównanie opcji z tabelą i jasną rekomendacją kiedy co',
  'rozbicie-kosztow': 'rozbicie kosztów z tabelą widełek',
  mity: 'mity kontra fakty',
  bledy: 'najczęstsze błędy, które kosztują (i jak ich uniknąć)',
  'case-study': 'case study realnego projektu (tylko z dostarczonych faktów)',
  'pytania-eksperta': 'odpowiedzi na pytania, które klienci zadają na pierwszej rozmowie',
};

const clamp = (v: unknown, lo: number, hi: number) => Math.min(Math.max(Math.round(Number(v) || lo), lo), hi);

// ── data ────────────────────────────────────────────────────────────────────
type Post = { id: string; slug: string; title_pl: string; status: string; scheduled_for: string | null; published_at: string; pillar: string | null; format: string | null; images: any[]; cover_path: string | null; body_en: string | null; body_ru: string | null };
type Topic = { id: string; title: string; slug: string; primary_keyword: string | null; pillar: string | null; format: string | null; angle: string | null; priority: number; source: string; notes: any };

async function loadContext() {
  const [posts, services, projects, settings, topics, redirects] = await Promise.all([
    db<Post[]>('blog_posts?select=id,slug,title_pl,status,scheduled_for,published_at,pillar,format,images,cover_path,body_en,body_ru,meta&order=published_at.desc&limit=2000'),
    db<any[]>('services?select=slug,title_pl,price_from,bullets_pl&is_published=eq.true&order=sort_order'),
    db<any[]>('projects?select=slug,title_pl,client,challenge_pl,services,stack,results,url&is_published=eq.true&order=sort_order'),
    db<any[]>('site_settings?select=key,value_meta&key=in.(blog_config)'),
    db<Topic[]>('blog_topics?select=*&status=eq.queued&order=priority.desc,created_at'),
    db<any[]>('blog_redirects?select=from_slug'),
  ]);
  const raw = settings.find((s) => s.key === 'blog_config')?.value_meta || {};
  // Admin → Blog → "Ustawienia generatora" (all optional; sane defaults here).
  const config = {
    enabled: raw.enabled !== false,
    seed_keywords: (raw.seed_keywords || []) as string[],
    buffer_days: clamp(raw.buffer_days ?? CFG.bufferDays ?? 7, 2, 21),
    max_per_run: clamp(raw.max_per_run ?? CFG.maxPerRun ?? 2, 1, 4),
    words_min: clamp(raw.words_min ?? 1300, 600, 4000),
    words_max: clamp(raw.words_max ?? 1900, 800, 5000),
    inline_images: clamp(raw.inline_images ?? 2, 0, 3),
    langs: (Array.isArray(raw.langs) ? raw.langs : ['en', 'ru']).filter((l: string) => l === 'en' || l === 'ru') as ('en' | 'ru')[],
    pillars: Object.fromEntries(Object.keys(PILLARS).map((k) => [k, clamp(raw.pillars?.[k] ?? 2, 0, 3)])) as Record<string, number>,
    formats: Object.fromEntries(Object.keys(FORMATS).map((k) => [k, raw.formats?.[k] !== false])) as Record<string, boolean>,
    style_notes: String(raw.style_notes || '').slice(0, 2000),
    photo_style: String(raw.photo_style || '').slice(0, 600),
    banned_phrases: (raw.banned_phrases || []) as string[],
  };
  if (!Object.values(config.pillars).some((w) => w > 0)) for (const k of Object.keys(config.pillars)) config.pillars[k] = 2;
  if (!Object.values(config.formats).some(Boolean)) for (const k of Object.keys(config.formats)) config.formats[k] = true;
  const recentQueries = posts.filter((p: any) => p.meta?.cover_query).sort((a: any, b: any) => String(b.scheduled_for || b.published_at).localeCompare(String(a.scheduled_for || a.published_at))).map((p: any) => p.meta.cover_query as string);
  return { posts, services, projects, config, topics, recentQueries, archivedSlugs: new Set(redirects.map((r) => r.from_slug as string)) };
}
type Ctx = Awaited<ReturnType<typeof loadContext>>;

const live = (ctx: Ctx) => ctx.posts.filter((p) => p.status === 'published' || p.status === 'scheduled');

// ── topic dedup (code-level, on top of Claude seeing the full list) ─────────
const STOP = new Set(['i', 'w', 'z', 'na', 'do', 'dla', 'jak', 'co', 'czy', 'to', 'o', 'od', 'po', 'sie', 'jest', 'ile', 'oraz', 'a', 'the', 'czym', 'jaka', 'jaki', 'jakie', 'twoja', 'twojej', 'twoj', 'firmy', 'firma', 'strona', 'strony', 'internetowa', 'internetowej', 'internetowe', 'stron', 'internetowych', '2026', '2027', 'przewodnik', 'poradnik', 'kompletny', 'praktyczny']);
const toks = (slug: string) => new Set(slug.split('-').filter((t) => t.length > 2 && !STOP.has(t)).map((t) => t.slice(0, 6)));
function nearDup(slug: string, against: string[]): string | null {
  const a = toks(slug);
  if (!a.size) return null;
  for (const s of against) {
    const b = toks(s);
    if (!b.size) continue;
    const inter = [...a].filter((x) => b.has(x)).length;
    if (inter / Math.min(a.size, b.size) >= 0.8 && inter >= 2) return s;
  }
  return null;
}

// ── planner ─────────────────────────────────────────────────────────────────
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['topics'],
  properties: { topics: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['title', 'slug', 'primary_keyword', 'pillar', 'format', 'angle'],
    properties: {
      title: { type: 'string' }, slug: { type: 'string' }, primary_keyword: { type: 'string' },
      pillar: { type: 'string', enum: Object.keys(PILLARS) }, format: { type: 'string', enum: Object.keys(FORMATS) },
      angle: { type: 'string' },
    },
  } } },
};

async function refillTopics(ctx: Ctx) {
  if (ctx.topics.filter((t) => t.priority > 0 || ((ctx.config.pillars[t.pillar || ''] ?? 2) > 0 && ctx.config.formats[t.format || ''] !== false)).length >= QUEUE_MIN) return;
  const existing = live(ctx).map((p) => `${p.slug} — ${p.title_pl}`);
  const queued = ctx.topics.map((t) => `${t.slug} — ${t.title}`);
  const counts: Record<string, number> = {};
  for (const p of live(ctx).slice(0, 40)) if (p.pillar) counts[p.pillar] = (counts[p.pillar] || 0) + 1;
  const res = await claudeJson<{ topics: any[] }>({
    label: 'blog-plan', model: 'sonnet', effort: 'medium', maxTokens: 16000, schema: PLAN_SCHEMA,
    system: `Jesteś strategiem treści bloga studia BarabashFlow (Damian Barabash, Warszawa): strony internetowe, sklepy, platformy i aplikacje webowe, CMS, SEO, opieka. Blog ma przyciągać z Google i asystentów AI PRAWDZIWYCH klientów (właściciele firm, marketing, startupy w Polsce) i budować zaufanie.
Filary (waga = jak często właściciel chce dany filar: 3 często, 2 normalnie, 1 rzadko): ${Object.entries(PILLARS).filter(([k]) => ctx.config.pillars[k] > 0).map(([k, v]) => `\n- ${k} (waga ${ctx.config.pillars[k]}): ${v}`).join('')}
Formaty: ${Object.entries(FORMATS).filter(([k]) => ctx.config.formats[k]).map(([k, v]) => `\n- ${k}: ${v}`).join('')}
Zasady:
- Każdy temat to konkretny problem/pytanie klienta, którego realnie szuka po polsku (long-tail z intencją zakupową lub decyzyjną). Zero tematów pod cudze marki, zero tematów niezwiązanych z usługami studia.
- Tytuł: do 60 znaków, główna fraza na początku, obiecuje konkretną wartość (liczby, porównanie, checklista). Bez "kompletny przewodnik 2026" i bez clickbaitu.
- angle: 2 zdania — co dokładnie dostanie czytelnik i czym ten tekst różni się od istniejących (inny kąt, inna grupa odbiorców, świeże dane).
- slug: tylko [a-z0-9-], bez polskich znaków, do 60 znaków.
- NIE powtarzaj tematów ani kątów z listy istniejących i zaplanowanych — ani dosłownie, ani "tym samym tekstem innymi słowami".
- Rozłóż tematy po filarach proporcjonalnie do wag (i preferuj te rzadko używane ostatnio) oraz po formatach (różnorodność). Używaj WYŁĄCZNIE filarów i formatów z listy. Case study tylko o projektach studia (lista projektów w danych).`,
    content: `Projekty studia (do case study): ${ctx.projects.map((p) => `${p.slug} (${p.client || p.title_pl}): ${String(p.challenge_pl || '').slice(0, 140)}`).join(' | ')}
Ostatnio użyte filary (40 wpisów): ${JSON.stringify(counts)}
Tematy priorytetowe od właściciela (jeśli są — uwzględnij je najpierw): ${(ctx.config.seed_keywords || []).join('; ') || 'brak'}

ISTNIEJĄCE WPISY (${existing.length}):
${existing.join('\n')}

ZAPLANOWANE W KOLEJCE (${queued.length}):
${queued.join('\n') || '—'}

Zaplanuj 16 nowych tematów.`,
  });
  const allSlugs = [...ctx.posts.map((p) => p.slug), ...ctx.archivedSlugs, ...ctx.topics.map((t) => t.slug)];
  const againstLive = [...live(ctx).map((p) => p.slug), ...ctx.topics.map((t) => t.slug)];
  const seeds = new Set((ctx.config.seed_keywords || []).map((s: string) => s.toLowerCase()));
  const rows: any[] = [];
  for (const t of res.topics || []) {
    const slug = slugify(t.slug || t.title);
    if (slug.length < 3) continue;
    if (!(ctx.config.pillars[t.pillar] > 0) || !ctx.config.formats[t.format]) { log(`plan: drop (pillar/format off) ${slug}`); continue; }
    if (allSlugs.includes(slug)) { log(`plan: drop (slug exists) ${slug}`); continue; }
    const dup = nearDup(slug, [...againstLive, ...rows.map((r) => r.slug)]);
    if (dup) { log(`plan: drop (near-dup of ${dup}) ${slug}`); continue; }
    const fromSeed = [...seeds].some((s) => t.title.toLowerCase().includes(s) || t.primary_keyword.toLowerCase().includes(s));
    rows.push({ title: t.title.slice(0, 120), slug, primary_keyword: t.primary_keyword, pillar: t.pillar, format: t.format, angle: t.angle, source: fromSeed ? 'admin' : 'planner', priority: fromSeed ? 10 : 0 });
  }
  if (!rows.length) throw new Error('planner produced no usable topics');
  const inserted = await db<Topic[]>('blog_topics', { method: 'POST', body: JSON.stringify(rows), prefer: 'return=representation,resolution=ignore-duplicates' });
  log(`plan: +${inserted.length} topics`);
  ctx.topics.push(...inserted);
}

function pickTopic(ctx: Ctx): Topic | null {
  const ok = (t: Topic) => t.priority > 0 || ((!t.pillar || ctx.config.pillars[t.pillar] > 0) && (!t.format || ctx.config.formats[t.format]));
  const pool = ctx.topics.filter((t) => t.status !== 'rejected' && ok(t));
  if (!pool.length) return null;
  const recent = live(ctx).sort((a, b) => String(b.scheduled_for || b.published_at).localeCompare(String(a.scheduled_for || a.published_at))).slice(0, 8);
  const recentPillars = recent.map((p) => p.pillar);
  const lastFormats = recent.slice(0, 3).map((p) => p.format);
  const score = (t: Topic) => t.priority * 100 + (ctx.config.pillars[t.pillar || ''] ?? 2) * 6 - recentPillars.filter((x) => x === t.pillar).length * 10 - (lastFormats.includes(t.format) ? 5 : 0) - (recentPillars[0] === t.pillar ? 20 : 0);
  return [...pool].sort((a, b) => score(b) - score(a))[0];
}

// ── writer ──────────────────────────────────────────────────────────────────
const ARTICLE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'excerpt', 'body', 'faq', 'tags', 'keywords', 'estimator_after_h2', 'cover', 'inline_images'],
  properties: {
    title: { type: 'string' }, excerpt: { type: 'string' }, body: { type: 'string' },
    faq: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['q', 'a'], properties: { q: { type: 'string' }, a: { type: 'string' } } } },
    tags: { type: 'array', items: { type: 'string' } }, keywords: { type: 'array', items: { type: 'string' } },
    estimator_after_h2: { type: 'integer' },
    cover: { type: 'object', additionalProperties: false, required: ['query', 'idea', 'alt'], properties: { query: { type: 'string' }, idea: { type: 'string' }, alt: { type: 'string' } } },
    inline_images: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['after_h2', 'idea', 'alt'], properties: { after_h2: { type: 'integer' }, idea: { type: 'string' }, alt: { type: 'string' } } } },
  },
};

function writerSystem(ctx: Ctx) {
  return `Jesteś Damianem Barabashem — właścicielem studia BarabashFlow (Warszawa). Sam projektujesz i wdrażasz strony, sklepy, platformy i aplikacje webowe (Astro, Next.js, Supabase, własny CMS, SEO), bez agencyjnych pośredników. Piszesz bloga dla właścicieli firm i marketerów w Polsce.

GŁOS: ekspert-praktyk, który tłumaczy jak dobremu klientowi przy kawie. Konkret, liczby, przykłady, własne zdanie i rekomendacje ("ja bym…", "u klientów widzę…"). Krótkie akapity (2–4 zdania). Zero lania wody, zero ogólników typu "W dzisiejszych czasach", "W erze cyfrowej", "Podsumowując", "Kluczowe jest", "Warto zauważyć". Nie zaczynaj akapitów od "Pamiętaj". Polszczyzna naturalna, poprawna, bez kalk z angielskiego.

STRUKTURA (markdown, BEZ nagłówka H1):
- Lead: 2–3 zdania przed pierwszym H2 — od razu problem czytelnika i obietnica konkretu.
- 5–7 sekcji "## " (nagłówki jak pytania lub konkretne tezy, nie "Wprowadzenie"/"Podsumowanie"), w razie potrzeby "### ".
- Co najmniej JEDNA tabela markdown (porównanie, widełki, harmonogram) i JEDNA lista punktowana lub numerowana.
- 1–2 ramki "> **Z praktyki:** …" — obserwacje z projektów studia. Jeśli wspominasz konkretny projekt, używaj WYŁĄCZNIE faktów z listy projektów i linkuj do jego strony. Nie wymyślaj klientów, liczb, wyników ani cytatów.
- 3–5 linków wewnętrznych w naturalnym tekście — TYLKO adresy z listy (usługi, projekty, wpisy). Max 2 linki zewnętrzne, tylko do autorytetów (Google Search Central, web.dev, UODO, MDN).
- Ostatnia sekcja: praktyczny następny krok (co zrobić jutro rano). W środku artykułu (po sekcji estimator_after_h2) będzie interaktywny kalkulator wyceny — możesz raz naturalnie do niego odesłać ("policz swój przypadek w kalkulatorze powyżej").
- Długość: ${ctx.config.words_min}–${ctx.config.words_max} słów.
- Ceny: posługuj się cennikiem studia (poniżej) i uczciwymi widełkami rynkowymi; typowy czas realizacji strony firmowej w studiu to 2–3 tygodnie.

SEO/AEO: główna fraza w tytule (na początku), w leadzie i w jednym H2; tytuł max 60 znaków; excerpt = meta description 130–155 znaków z frazą i obietnicą. FAQ: 4 pytania, które ludzie wpisują w Google/ChatGPT, odpowiedzi 1–3 zdania, samodzielne (do featured snippets).

ZDJĘCIA (Unsplash, estetyka editorial/minimal, naturalne światło). Blog ma wyglądać jak magazyn — NIE kolejne biurko z laptopem i kawą, jeśli temat tego nie wymaga; szukaj motywu oddającego temat (architektura, wnętrza, faktury, ludzie w swoim fachu, przedmioty z branży, miasto, światło), wyraźnie innego niż ostatnio użyte zapytania (lista w briefie). cover.query = 2–5 słów PO ANGIELSKU pod wyszukiwarkę Unsplash, nastrojowe i konkretne (np. "architect desk morning light", "minimal ceramic studio"), NIE dosłowne "website cost". Ta sama wyszukiwarka zasili też 2 zdjęcia w treści — więc query ma dawać spójną serię. cover.idea / inline_images[].idea = co ma być na zdjęciu (1 zdanie). alt = opis po polsku (do 120 znaków). inline_images: dokładnie ${ctx.config.inline_images}${ctx.config.inline_images ? ', after_h2 = numer sekcji (1-based), różne, nie w tej samej sekcji co kalkulator' : ' (pusta lista)'}.${ctx.config.photo_style ? `\nSTYL ZDJĘĆ WG WŁAŚCICIELA: ${ctx.config.photo_style}` : ''} estimator_after_h2: numer sekcji (2..liczba sekcji−1), po której pasuje kalkulator (najlepiej po sekcji o kosztach/zakresie).

USŁUGI I CENNIK STUDIA:
${ctx.services.map((s) => `- ${s.title_pl} (${SITE}/uslugi/${s.slug}/): ${s.price_from}; ${(s.bullets_pl || []).slice(0, 4).join('; ')}`).join('\n')}

PROJEKTY STUDIA (fakty do "Z praktyki" i linkowania):
${ctx.projects.map((p) => `- ${p.client || p.title_pl} — ${SITE}/projekty/${p.slug}/ — zadanie: ${String(p.challenge_pl || '').slice(0, 220)}${p.stack?.length ? ` — stack: ${p.stack.slice(0, 5).join(', ')}` : ''}`).join('\n')}

INNE STRONY: ${SITE}/kontakt/ (wycena), ${SITE}/o-mnie/, ${SITE}/projekty/, ${SITE}/uslugi/${ctx.config.style_notes ? `\n\nDODATKOWE WSKAZÓWKI WŁAŚCICIELA (mają pierwszeństwo przed powyższymi, o ile nie każą wymyślać faktów):\n${ctx.config.style_notes}` : ''}${ctx.config.banned_phrases.length ? `\n\nNIE UŻYWAJ FRAZ: ${ctx.config.banned_phrases.join('; ')}` : ''}`;
}

function allowedLinks(ctx: Ctx) {
  const set = new Set<string>(['/', '/kontakt/', '/o-mnie/', '/projekty/', '/uslugi/', '/blog/']);
  ctx.services.forEach((s) => set.add(`/uslugi/${s.slug}/`));
  ctx.projects.forEach((p) => set.add(`/projekty/${p.slug}/`));
  ctx.posts.filter((p) => p.status === 'published').forEach((p) => set.add(`/blog/${p.slug}/`));
  return set;
}

// Internal links → relative, unknown ones unwrapped; external only to an allowlist.
const EXT_OK = /^(https?:\/\/)?(developers\.google\.com|web\.dev|uodo\.gov\.pl|developer\.mozilla\.org|support\.google\.com|search\.google\.com|schema\.org|www\.w3\.org|pagespeed\.web\.dev)\b/;
function fixLinks(md: string, allowed: Set<string>): { md: string; internal: number; removed: string[] } {
  let internal = 0;
  const removed: string[] = [];
  const out = md.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
    let h = String(href).replace(/^https?:\/\/(www\.)?barabashflow\.pl/, '');
    if (h.startsWith('/')) {
      if (!h.endsWith('/') && !h.includes('#') && !h.includes('?')) h += '/';
      if (allowed.has(h.split('#')[0])) { internal++; return `[${text}](${h})`; }
      removed.push(h); return text;
    }
    if (EXT_OK.test(h)) return `[${text}](${h})`;
    removed.push(h); return text;
  });
  return { md: out, internal, removed };
}

function qa(a: any, cfg: Ctx['config']): string[] {
  const issues: string[] = [];
  const n = h2Count(a.body);
  const w = words(a.body);
  if (/^# /m.test(a.body)) issues.push('usuń nagłówek H1 (# ) z treści');
  if (n < 5 || n > 8) issues.push(`liczba sekcji H2 = ${n}, wymagane 5–7`);
  if (w < cfg.words_min * 0.88) issues.push(`za krótko: ${w} słów, wymagane ${cfg.words_min}–${cfg.words_max}`);
  if (w > cfg.words_max * 1.25) issues.push(`za długo: ${w} słów, max ${cfg.words_max}`);
  if (!/^\|.+\|\s*$/m.test(a.body)) issues.push('brak tabeli markdown');
  if (!/^>\s*\*\*Z praktyki/m.test(a.body)) issues.push('brak ramki "> **Z praktyki:**"');
  if (a.title.length > 62) issues.push(`tytuł ma ${a.title.length} znaków (max 60)`);
  if (a.excerpt.length < 110 || a.excerpt.length > 160) issues.push(`excerpt ma ${a.excerpt.length} znaków (130–155)`);
  if ((a.faq || []).length < 3) issues.push('FAQ: wymagane 4 pytania');
  if ((a.inline_images || []).length !== cfg.inline_images) issues.push(`inline_images: wymagane dokładnie ${cfg.inline_images}`);
  const banned = ['W dzisiejszych czasach', 'W erze cyfrowej', 'Podsumowując', 'Warto zauważyć', 'nie ulega wątpliwości', ...cfg.banned_phrases];
  for (const b of banned) if (a.body.toLowerCase().includes(b.toLowerCase())) issues.push(`usuń frazę "${b}"`);
  return issues;
}

async function writeArticle(ctx: Ctx, topic: Topic) {
  const allowed = allowedLinks(ctx);
  const postsList = ctx.posts.filter((p) => p.status === 'published').slice(0, 150).map((p) => `- ${SITE}/blog/${p.slug}/ — ${p.title_pl}`).join('\n');
  const system = writerSystem(ctx);
  const brief = `TEMAT: ${topic.title}
Główna fraza: ${topic.primary_keyword || topic.title}
Filar: ${topic.pillar} — ${PILLARS[topic.pillar || ''] || ''}
Format: ${topic.format} — ${FORMATS[topic.format || ''] || ''}
Kąt / czym ma się wyróżniać: ${topic.angle || '—'}

OSTATNIO UŻYTE ZAPYTANIA ZDJĘĆ (unikaj podobnych motywów): ${ctx.recentQueries.slice(0, 25).join(' · ') || '—'}

WPISY NA BLOGU (do linkowania; nie powtarzaj ich treści):
${postsList}`;
  let art = await claudeJson<any>({ label: 'blog-write', model: 'opus', effort: 'medium', maxTokens: 32000, schema: ARTICLE_SCHEMA, system, content: brief });
  let issues = qa(art, ctx.config);
  if (issues.length) {
    log(`qa round 1: ${issues.join(' | ')}`);
    art = await claudeJson<any>({
      label: 'blog-repair', model: 'sonnet', effort: 'medium', maxTokens: 24000, schema: ARTICLE_SCHEMA, system,
      content: `${brief}\n\nTwoja poprzednia wersja (JSON):\n${JSON.stringify(art)}\n\nPopraw TYLKO te problemy, resztę zachowaj:\n- ${issues.join('\n- ')}`,
    });
    issues = qa(art, ctx.config);
    if (issues.length) log(`qa round 2 (accepted with warnings): ${issues.join(' | ')}`);
  }
  const links = fixLinks(art.body, allowed);
  if (links.removed.length) log(`links unwrapped: ${links.removed.join(', ')}`);
  art.body = links.md;
  art.title = art.title.trim().replace(/\.$/, '');
  art.qa = { warnings: issues, internal_links: links.internal, words: words(art.body), h2: h2Count(art.body) };
  return art;
}

// ── translation ─────────────────────────────────────────────────────────────
const TR_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'excerpt', 'body', 'faq', 'alts'],
  properties: {
    title: { type: 'string' }, excerpt: { type: 'string' }, body: { type: 'string' },
    faq: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['q', 'a'], properties: { q: { type: 'string' }, a: { type: 'string' } } } },
    alts: { type: 'array', items: { type: 'string' } },
  },
};

async function translate(art: { title: string; excerpt: string; body: string; faq: any[]; alts: string[] }, lang: 'en' | 'ru') {
  const name = lang === 'en' ? 'English (international business reader)' : 'Russian (русскоязычный предприниматель в Польше/ЕС)';
  for (const [attempt, model] of [[1, 'haiku'], [2, 'sonnet']] as const) {
    const tr = await claudeJson<any>({
      label: `blog-translate ${lang}`, model, effort: 'low', maxTokens: 16000, schema: TR_SCHEMA,
      system: `You are a senior editor translating a Polish blog article of a web studio into ${name}. Write natural, idiomatic copy (not literal), keep the author's voice and all facts. Keep markdown EXACTLY structured: same number of "## " and "### " headings in the same order, same tables, lists and blockquotes, the same link URLs (translate only link text). Keep prices in PLN/zł as numbers (write "PLN" in English, "злотых"/"zł" in Russian). Keep "> **Z praktyki:**" callouts translated as "> **From practice:**" / "> **Из практики:**". Translate faq items and the image alt texts in the same order.`,
      content: JSON.stringify(art),
    });
    if (h2Count(tr.body) === h2Count(art.body) && tr.faq?.length === art.faq.length) return tr;
    log(`translate-${lang}: structure mismatch (h2 ${h2Count(tr.body)} vs ${h2Count(art.body)}) attempt ${attempt}`);
  }
  return null;
}

// ── photos ──────────────────────────────────────────────────────────────────
function usedPhotoIds(ctx: Ctx): Set<string> {
  const s = new Set<string>();
  for (const p of ctx.posts) for (const i of p.images || []) if (i?.id) s.add(i.id);
  return s;
}

async function photosFor(ctx: Ctx, title: string, cover: { query: string; idea: string }, inlineIdeas: string[]): Promise<{ cover: Photo; inline: Photo[] }> {
  const used = usedPhotoIds(ctx);
  let cands = await searchPhotos(cover.query, used);
  if (cands.length < 6) {
    log(`photos: only ${cands.length} for "${cover.query}", widening`);
    const wide = cover.query.split(/\s+/).slice(0, 2).join(' ');
    cands = [...cands, ...(await searchPhotos(`${wide} minimal`, used))].filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i);
  }
  const pick = await pickPhotos(cands, { title, coverIdea: cover.idea, inline: inlineIdeas, style: ctx.config.photo_style });
  for (const p of [pick.cover, ...pick.inline]) await trackDownload(p);
  return pick;
}

// ── scheduling ──────────────────────────────────────────────────────────────
const dayOf = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
function nextFreeSlot(ctx: Ctx): string {
  const taken = new Set(live(ctx).map((p) => dayOf(p.scheduled_for || p.published_at)));
  const now = new Date();
  // Today is still fillable before the 06:00 UTC publish run.
  const start = now.getUTCHours() < 5 ? 0 : 1;
  for (let d = start; d < 400; d++) {
    const day = new Date(now.getTime() + d * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
    if (!taken.has(day)) return `${day}T05:00:00Z`;
  }
  throw new Error('no free slot');
}
function bufferDepth(ctx: Ctx) {
  return ctx.posts.filter((p) => p.status === 'scheduled' && p.scheduled_for && new Date(p.scheduled_for) > new Date()).length;
}

// ── one post end-to-end ─────────────────────────────────────────────────────
async function produce(ctx: Ctx): Promise<string> {
  await refillTopics(ctx);
  const topic = pickTopic(ctx);
  if (!topic) throw new Error('topic queue empty');
  log(`topic: ${topic.title} [${topic.pillar}/${topic.format}]`);
  await db(`blog_topics?id=eq.${topic.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'writing' }) });
  try {
    const art = await writeArticle(ctx, topic);
    const slugBase = slugify(topic.slug || art.title);
    const taken = new Set([...ctx.posts.map((p) => p.slug), ...ctx.archivedSlugs]);
    const slug = taken.has(slugBase) ? `${slugBase.slice(0, 66)}-${Date.now().toString(36).slice(-4)}` : slugBase;

    const alts = [art.cover.alt, ...art.inline_images.map((i: any) => i.alt)];
    const src = { title: art.title, excerpt: art.excerpt, body: art.body, faq: art.faq, alts };
    const tr = (l: 'en' | 'ru') => (ctx.config.langs.includes(l) ? translate(src, l).catch((e) => (log(`translate ${l} failed`, String(e)), null)) : Promise.resolve(null));
    const [en, ru] = await Promise.all([tr('en'), tr('ru')]);

    let images: any[] = [];
    let coverPath: string | null = null;
    if (unsplashRemaining >= 6) {
      try {
        const pick = await photosFor(ctx, art.title, art.cover, (art.inline_images || []).slice(0, ctx.config.inline_images).map((i: any) => i.idea));
        const altFor = (i: number) => ({ alt_pl: alts[i], alt_en: en?.alts?.[i] || null, alt_ru: ru?.alts?.[i] || null });
        images = [
          imageRecord(pick.cover, 'cover', altFor(0)),
          ...pick.inline.map((p, i) => imageRecord(p, 'inline', { slot: i + 1, after_h2: art.inline_images[i].after_h2, ...altFor(i + 1) })),
        ];
        coverPath = pick.cover.url;
      } catch (e) { log('photos failed (repair pass will retry):', String(e)); }
    } else log(`photos deferred: unsplash budget ${unsplashRemaining}`);

    const slot = nextFreeSlot(ctx);
    const faq = art.faq.map((f: any, i: number) => ({ q: f.q, a: f.a, q_en: en?.faq?.[i]?.q, a_en: en?.faq?.[i]?.a, q_ru: ru?.faq?.[i]?.q, a_ru: ru?.faq?.[i]?.a }));
    const row = {
      slug, status: 'scheduled', scheduled_for: slot, published_at: slot,
      title_pl: art.title, excerpt_pl: art.excerpt, body_pl: art.body,
      title_en: en?.title ?? null, excerpt_en: en?.excerpt ?? null, body_en: en?.body ?? null,
      title_ru: ru?.title ?? null, excerpt_ru: ru?.excerpt ?? null, body_ru: ru?.body ?? null,
      faq, tags: art.tags.slice(0, 5), keywords: art.keywords.slice(0, 10),
      cover_path: coverPath, cover_alt: art.cover.alt, cover_credit: images[0] ? `Fot. ${images[0].author} / Unsplash` : null, cover_source_url: images[0]?.page_url ?? null,
      images, estimator_after_h2: art.estimator_after_h2, pillar: topic.pillar, format: topic.format, topic_id: topic.id,
      meta: { agent: 'blog-writer-v2', model: 'claude-opus-5-5', primary_keyword: topic.primary_keyword, cover_query: art.cover.query, angle: topic.angle, qa: art.qa, day: slot.slice(0, 10) },
    };
    const [ins] = await db<any[]>('blog_posts', { method: 'POST', body: JSON.stringify(row), prefer: 'return=representation' });
    await db(`blog_topics?id=eq.${topic.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'used', used_at: new Date().toISOString(), post_id: ins.id }) });
    ctx.posts.unshift(ins);
    ctx.recentQueries.unshift(art.cover.query);
    ctx.topics = ctx.topics.filter((t) => t.id !== topic.id);
    log(`scheduled ${slug} for ${slot} (${art.qa.words} words, ${art.qa.h2} sections, ${images.length} photos, en:${!!en} ru:${!!ru})`);
    return slug;
  } catch (e) {
    await db(`blog_topics?id=eq.${topic.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'queued' }) }).catch(() => {});
    throw e;
  }
}

// Scheduled posts missing photos or a translation get fixed before their day.
async function repair(ctx: Ctx, errors: string[]) {
  const due = ctx.posts.filter((p) => p.status === 'scheduled' && (!p.cover_path || ctx.config.langs.some((l) => !(p as any)[`body_${l}`])));
  for (const p of due.slice(0, 2)) {
    try {
      const [full] = await db<any[]>(`blog_posts?id=eq.${p.id}&select=*`);
      const patch: Record<string, unknown> = {};
      const inline = (full.images || []).filter((i: any) => i.role === 'inline');
      const alts = [full.cover_alt || full.title_pl, ...inline.map((i: any) => i.alt_pl || '')];
      const src = { title: full.title_pl, excerpt: full.excerpt_pl, body: full.body_pl, faq: (full.faq || []).map((f: any) => ({ q: f.q, a: f.a })), alts };
      for (const l of ctx.config.langs) {
        if (full[`body_${l}`]) continue;
        const tr = await translate(src, l);
        if (!tr) continue;
        Object.assign(patch, { [`title_${l}`]: tr.title, [`excerpt_${l}`]: tr.excerpt, [`body_${l}`]: tr.body });
        patch.faq = (patch.faq as any[] || full.faq || []).map((f: any, i: number) => ({ ...f, [`q_${l}`]: tr.faq[i]?.q, [`a_${l}`]: tr.faq[i]?.a }));
      }
      if (!full.cover_path && unsplashRemaining >= 6) {
        const meta = full.meta || {};
        const q = meta.cover_query || 'minimal workspace natural light';
        const pick = await photosFor(ctx, full.title_pl, { query: q, idea: full.cover_alt || full.title_pl }, Array.from({ length: ctx.config.inline_images }, () => 'zdjęcie pasujące do treści'));
        const n = h2Count(full.body_pl);
        patch.images = [imageRecord(pick.cover, 'cover', { alt_pl: full.cover_alt || full.title_pl }), ...pick.inline.map((ph, i) => imageRecord(ph, 'inline', { slot: i + 1, after_h2: Math.max(1, Math.round(((i + 1) * n) / 3)), alt_pl: full.title_pl }))];
        patch.cover_path = pick.cover.url;
        patch.cover_credit = `Fot. ${pick.cover.author} / Unsplash`;
        patch.cover_source_url = pick.cover.page_url;
      }
      if (Object.keys(patch).length) {
        await db(`blog_posts?id=eq.${p.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
        log(`repaired ${p.slug}: ${Object.keys(patch).join(', ')}`);
      }
    } catch (e) { errors.push(`repair ${p.slug}: ${String((e as any)?.message || e)}`); }
  }
}

async function main() {
  log('blog agent v2 start');
  const errors: string[] = [];
  const generated: string[] = [];
  let ctx: Ctx | null = null;
  try {
    ctx = await loadContext();
    if (!ctx.config.enabled) { log('disabled in admin — exit'); await reportStatus({ ok: true, ts: new Date().toISOString(), day: new Date().toISOString().slice(0, 10), disabled: true, buffer: bufferDepth(ctx) }); return; }
    await repair(ctx, errors);
    let made = 0;
    const budget = await monthSpend();
    const ARTICLE_COST = 0.3; // measured ≈ $0.2–0.3 (Opus write + Haiku translations)
    if (budget.spent + ARTICLE_COST > budget.cap) {
      const msg = `budżet AI wyczerpany: $${budget.spent.toFixed(2)} / $${budget.cap} — generator czeka (publikacje idą z bufora)`;
      log(msg);
      if (bufferDepth(ctx) < 3) errors.push(msg);
    }
    while (budget.spent + ARTICLE_COST * (made + 1) <= budget.cap && bufferDepth(ctx) < ctx.config.buffer_days && made < ctx.config.max_per_run) {
      try { generated.push(await produce(ctx)); }
      catch (e) { errors.push(`produce: ${String((e as any)?.message || e)}`); log('produce failed:', e); break; }
      made++;
    }
    log(`buffer: ${bufferDepth(ctx)}/${ctx.config.buffer_days} scheduled, queue: ${ctx.topics.length} topics`);
  } catch (e) {
    errors.push(String((e as any)?.message || e));
    log('FATAL', e);
  }
  const buffer = ctx ? bufferDepth(ctx) : null;
  // A failed generation is only an incident when the buffer is getting thin;
  // otherwise it is logged and retried in 3 h (no alert spam).
  const ok = errors.length === 0 || (buffer !== null && buffer >= 4);
  await reportStatus({
    ok,
    ts: new Date().toISOString(), day: new Date().toISOString().slice(0, 10), agent: 'v2',
    generated, buffer, queue: ctx?.topics.length ?? null, errors, unsplash_remaining: unsplashRemaining,
    duration_s: Math.round((Date.now() - STARTED) / 1000),
  });
  log('done', { generated, buffer, errors: errors.length });
}

await main();
