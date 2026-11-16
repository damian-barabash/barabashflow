// One-off (resumable) backfill 2026-11-16: give every kept published post a
// beautiful Unsplash cover + 2 inline photos, picked by Claude vision — the
// old covers were random CC photos from Openverse.
//
// Unsplash demo budget is 50 req/h (search + download tracking both count),
// ~4 per post → ~11 posts/hour. Keeps a reserve of RESERVE requests for the
// daily writer; when below it, sleeps until the hourly window resets.
// Safe to kill and re-run: posts that already have photos are skipped.
//   nohup ~/.bun/bin/bun backfill-images.ts >> logs/backfill.log 2>&1 &
import { db, removeMedia, monthSpend, log, sleep, claudeJson, searchPhotos, pickPhotos, trackDownload, imageRecord, h2Count, unsplashRemaining } from './lib';

const RESERVE = 10;

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['cover', 'inline'],
  properties: {
    cover: { type: 'object', additionalProperties: false, required: ['query', 'idea', 'alt_pl', 'alt_en', 'alt_ru'], properties: { query: { type: 'string' }, idea: { type: 'string' }, alt_pl: { type: 'string' }, alt_en: { type: 'string' }, alt_ru: { type: 'string' } } },
    inline: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['after_h2', 'idea', 'alt_pl', 'alt_en', 'alt_ru'], properties: { after_h2: { type: 'integer' }, idea: { type: 'string' }, alt_pl: { type: 'string' }, alt_en: { type: 'string' }, alt_ru: { type: 'string' } } } },
  },
};

const used = new Set<string>();
const recentQueries: string[] = [];
const VARIETY = `RÓŻNORODNOŚĆ (ważne — blog ma wyglądać jak magazyn, nie jak bank zdjęć biurek): NIE proponuj kolejnego biurka z laptopem/kawą/notesem, jeśli temat tego nie wymaga. Szukaj motywu, który oddaje temat: architektura i wnętrza, detale materiałów i faktur, ludzie przy pracy w swoim fachu (rzemiosło, gastronomia, warsztat, gabinet), przedmioty związane z branżą, miasto, natura jako metafora, abstrakcyjne kształty i światło. Każde zapytanie wyraźnie inne niż ostatnie.`;

async function one(p: any) {
  const heads = String(p.body_pl || '').split('\n').filter((l: string) => l.startsWith('## ')).map((l: string, i: number) => `${i + 1}. ${l.slice(3)}`);
  const n = heads.length;
  const plan = await claudeJson<any>({
    label: `blog-photos ${p.slug}`, model: 'haiku', effort: 'low', maxTokens: 3000, schema: PLAN_SCHEMA,
    system: `Jesteś photo-editorem bloga premium studia webowego. Estetyka: editorial, minimal, naturalne światło, spokojne kolory, nowoczesne wnętrza/detale/ludzie przy pracy — bez kiczowatych stocków. Zaproponuj zdjęcia z Unsplash do artykułu.
${VARIETY}
cover.query: 2–5 słów PO ANGIELSKU do wyszukiwarki Unsplash — nastrojowe i konkretne, NIE dosłowne ("website cost" źle; "architect desk morning light" dobrze). Ta jedna wyszukiwarka zasili też zdjęcia w treści, więc query ma dawać spójną serię pasującą do tematu.
inline: dokładnie 2 zdjęcia, after_h2 = numer sekcji (1..${Math.max(n, 1)}), różne, nie pierwsza i nie ostatnia jeśli się da. alt_* = rzeczowy opis tego, co na zdjęciu (do 110 znaków) po polsku/angielsku/rosyjsku.`,
    content: `Tytuł: ${p.title_pl}\nLead: ${p.excerpt_pl || ''}\nSekcje:\n${heads.join('\n')}\n\nOstatnio użyte zapytania (NIE powtarzaj motywów): ${recentQueries.slice(-25).join(' · ') || '—'}`,
  });
  recentQueries.push(plan.cover.query);
  let cands = await searchPhotos(plan.cover.query, used);
  if (cands.length < 6) cands = [...cands, ...(await searchPhotos(`${plan.cover.query.split(' ').slice(0, 2).join(' ')} minimal`, used))].filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
  const inline = (plan.inline || []).slice(0, 2);
  const pick = await pickPhotos(cands, { title: p.title_pl, coverIdea: plan.cover.idea, inline: inline.map((i: any) => i.idea) });
  for (const ph of [pick.cover, ...pick.inline]) { await trackDownload(ph); used.add(ph.id); }
  const clampH2 = (x: number) => Math.min(Math.max(1, x || 1), Math.max(n, 1));
  const images = [
    imageRecord(pick.cover, 'cover', { alt_pl: plan.cover.alt_pl, alt_en: plan.cover.alt_en, alt_ru: plan.cover.alt_ru }),
    ...pick.inline.map((ph, i) => imageRecord(ph, 'inline', { slot: i + 1, after_h2: clampH2(inline[i]?.after_h2), alt_pl: inline[i]?.alt_pl, alt_en: inline[i]?.alt_en, alt_ru: inline[i]?.alt_ru })),
  ];
  await db(`blog_posts?id=eq.${p.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      images, cover_path: pick.cover.url, cover_alt: plan.cover.alt_pl,
      cover_credit: `Fot. ${pick.cover.author} / Unsplash`, cover_source_url: pick.cover.page_url,
      meta: { ...(p.meta || {}), cover_query: plan.cover.query, photos_backfill: '2026-11-16' },
    }),
  });
  await removeMedia([p.cover_path]);
  log(`✓ ${p.slug}: "${plan.cover.query}" → ${pick.cover.author} (+${pick.inline.length} inline, n=${n}) · unsplash left ${unsplashRemaining}`);
}

async function main() {
  const all = await db<any[]>('blog_posts?select=id,slug,title_pl,excerpt_pl,body_pl,images,meta,status,cover_path&status=in.(published,scheduled)&order=published_at.desc&limit=2000');
  for (const p of all) { for (const i of p.images || []) if (i?.id) used.add(i.id); if (p.meta?.cover_query) recentQueries.push(p.meta.cover_query); }
  const todo = all.filter((p) => !(p.images || []).some((i: any) => i.role === 'cover'));
  log(`backfill: ${todo.length} posts without Unsplash photos`);
  let done = 0;
  for (const p of todo) {
    const b = await monthSpend(); if (b.spent > b.cap) { log(`budżet AI wyczerpany ($${b.spent.toFixed(2)}/$${b.cap}) — stop`); break; }
    if (unsplashRemaining < RESERVE + 6) { log(`unsplash budget ${unsplashRemaining} — sleeping 61 min`); await sleep(61 * 60_000); }
    try { await one(p); done++; }
    catch (e) {
      const msg = String((e as any)?.message || e);
      log(`✗ ${p.slug}: ${msg}`);
      if (/rate limit/i.test(msg)) { await sleep(61 * 60_000); }
    }
  }
  log(`backfill done: ${done}/${todo.length}`);
}
await main();
