// Edge `leads` (verify_jwt: false; auth checked inside) — lead finder.
//
// action "tick"  (pg_cron every 10 min, header x-cron-secret = Vault
//                leads_cron_secret): ONE step of the daily pipeline, whichever
//                is needed first — compose letters for the best scored leads
//                until today's quota (leads_config.per_day) is ready → score
//                raw candidates with Claude → harvest new companies from the
//                public KRS API (daily bulletin → current extract). Idempotent;
//                a failed step is simply retried by the next tick.
// action "send"     (admin JWT) — sends the (edited) letter via Resend from
//                   from_email, no BCC; Reply-To = office+<mail_tag>@reply.barabashflow.pl
//                   so the answer lands in the CRM card (edge mail-in); adds the address
//                   to lead_suppression (never twice) and creates a CRM client.
// action "compose"  (admin JWT) — rewrite one letter, optional instruction.
// action "harvest_now" (admin JWT) — run one tick right away.
//
// Rules: only companies WITH an e-mail, registered ≤ max_age_days ago, in the
// enabled industries / voivodeships, never an address that was contacted,
// opted out or bounced. KRS masks board names — we keep initials + birth decade
// (first PESEL digit) so the owner can judge the lead.
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';
import { createClient } from 'npm:@supabase/supabase-js@2';

const KRS = 'https://api-krs.ms.gov.pl/api/krs';
const SITE = 'https://barabashflow.pl';
// Cost: scoring = Haiku 5.5 (thinking off), letters = Sonnet 5.5 (thinking off,
// effort low) ≈ $0.01 per letter; every call logged to ai_usage and checked
// against site_settings.ai_budget.monthly_usd.
const MODELS = { sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' } as const;
const PRICE = { sonnet: [2, 10], haiku: [0.1, 0.5] } as const;
const T0 = Date.now();
const budgetLeft = () => 115_000 - (Date.now() - T0);

// PKD prefixes per industry bucket ("where a website really pays off").
export const INDUSTRIES: Record<string, { label: string; pkd: string[] }> = {
  beauty: { label: 'Beauty i wellness', pkd: ['96.02', '96.04', '96.09'] },
  gastro: { label: 'Gastronomia', pkd: ['56'] },
  budowa: { label: 'Budowa i remonty', pkd: ['41', '42', '43'] },
  zdrowie: { label: 'Zdrowie i medycyna', pkd: ['86', '75'] },
  edukacja: { label: 'Edukacja i szkolenia', pkd: ['85'] },
  auto: { label: 'Motoryzacja', pkd: ['45', '77.11'] },
  nieruchomosci: { label: 'Nieruchomości (agencje)', pkd: ['68.31', '68.32'] },
  turystyka: { label: 'Turystyka i noclegi', pkd: ['55', '79'] },
  handel: { label: 'Handel detaliczny / e-commerce', pkd: ['47'] },
  uslugi: { label: 'Usługi profesjonalne', pkd: ['69.1', '71', '73', '74', '78', '82.30'] },
  sport: { label: 'Sport i rekreacja', pkd: ['93'] },
  transport: { label: 'Transport i logistyka', pkd: ['49.3', '49.4', '52', '53'] },
  produkcja: { label: 'Produkcja / rzemiosło', pkd: ['10', '11', '16', '23', '25', '31', '32'] },
};

const DEFAULTS = {
  enabled: true, per_day: 10, max_age_days: 21, min_fit: 45,
  industries: Object.keys(INDUSTRIES), voivodeships: [] as string[],
  from_name: 'Damian Barabash', from_email: 'office@barabashflow.pl',
  notify_email: 'dmytrii.barabash@gmail.com', // test sends + brief / reply notifications
  signature: 'Damian Barabash\nBarabashFlow · strony, sklepy i platformy na zamówienie\nbarabashflow.pl',
  instructions: '', test_mode: false,
};
type Cfg = typeof DEFAULTS;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const warsawDay = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }

  // public: personal landing page /oferta/?l=<token> (no auth, token only)
  if (body.action === 'view' || body.action === 'brief') {
    const { data: cfgRow0 } = await svc.from('site_settings').select('value_meta').eq('key', 'leads_config').maybeSingle();
    const cfg0: Cfg = { ...DEFAULTS, ...(cfgRow0?.value_meta || {}) };
    try { return json(body.action === 'view' ? await publicView(svc, String(body.token || ''), !!body.preview) : await publicBrief(svc, cfg0, body)); }
    catch (e) { return json({ error: String((e as any)?.message || e) }, 404); }
  }

  // auth: cron secret OR a signed-in admin
  let isCron = false;
  const cronHdr = req.headers.get('x-cron-secret');
  if (cronHdr) {
    const { data } = await svc.rpc('get_secret', { p_name: 'leads_cron_secret' });
    isCron = !!data && data === cronHdr;
    if (!isCron) return json({ error: 'unauthorized' }, 401);
  } else {
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = await svc.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'unauthorized' }, 401);
  }

  const { data: cfgRow } = await svc.from('site_settings').select('value_meta').eq('key', 'leads_config').maybeSingle();
  const cfg: Cfg = { ...DEFAULTS, ...(cfgRow?.value_meta || {}) };

  try {
    switch (body.action) {
      case 'tick': return json(await tick(svc, cfg, false));
      case 'harvest_now': return json(await tick(svc, cfg, true));
      case 'send': return json(await send(svc, cfg, body));
      case 'compose': {
        if (!(await budgetOk(svc, 0.02)).ok) return json({ error: 'budżet AI wyczerpany — zwiększ limit w Blog → Budżet AI' }, 402);
        const { data: lead } = await svc.from('leads').select('*').eq('id', body.id).single();
        if (!lead) return json({ error: 'lead not found' }, 404);
        const letter = await compose(svc, cfg, lead, String(body.instruction || ''));
        await svc.from('leads').update({ ...letter, status: lead.status === 'sent' ? 'sent' : 'ready', composed_at: lead.composed_at || new Date().toISOString() }).eq('id', lead.id);
        return json({ ok: true, ...letter });
      }
      default: return json({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    console.error('[leads]', e);
    await svc.from('site_settings').upsert({ key: 'leads_status', value_meta: { ok: false, ts: new Date().toISOString(), error: String((e as any)?.message || e).slice(0, 400) } }, { onConflict: 'key' });
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});

// ── pipeline step ───────────────────────────────────────────────────────────
async function tick(svc: any, cfg: Cfg, manual: boolean) {
  if (!cfg.enabled && !manual) return { ok: true, note: 'disabled' };
  const off = new Date().toLocaleString('en-US', { timeZone: 'Europe/Warsaw', timeZoneName: 'shortOffset' }).match(/GMT([+-]\d+)/)?.[1] || '+1';
  const dayStart = new Date(`${warsawDay()}T00:00:00${off.startsWith('-') ? '-' : '+'}${String(Math.abs(Number(off))).padStart(2, '0')}:00`).toISOString();
  const { count: readyToday } = await svc.from('leads').select('id', { count: 'exact', head: true }).gte('composed_at', dayStart);
  const quota = Math.max(0, cfg.per_day - (readyToday ?? 0));
  let step = 'idle';
  const out: Record<string, unknown> = {};
  const budget = await budgetOk(svc);
  if (!budget.ok) {
    const st = { ok: false, ts: new Date().toISOString(), step: 'budget', error: `budżet AI wyczerpany ($${budget.spent.toFixed(2)} / $${budget.cap}) — nowe leady wstrzymane do 1. dnia miesiąca`, ready_today: readyToday ?? 0 };
    await svc.from('site_settings').upsert({ key: 'leads_status', value_meta: st }, { onConflict: 'key' });
    return st;
  }
  if (quota > 0) {
    const { data: best } = await svc.from('leads').select('*').eq('status', 'scored').gte('fit_score', cfg.min_fit).order('fit_score', { ascending: false }).order('registered_at', { ascending: false }).limit(Math.min(quota, 4));
    if (best?.length) {
      step = 'compose';
      let n = 0;
      for (const lead of best) {
        if (budgetLeft() < 30_000) break;
        try {
          const letter = await compose(svc, cfg, lead, '');
          await svc.from('leads').update({ ...letter, status: 'ready', composed_at: new Date().toISOString() }).eq('id', lead.id);
          n++;
        } catch (e) { console.error('compose', lead.id, e); }
      }
      out.composed = n;
    } else {
      const { data: raw } = await svc.from('leads').select('*').eq('status', 'raw').order('registered_at', { ascending: false }).limit(25);
      if (raw?.length) { step = 'score'; out.scored = await scoreBatch(svc, cfg, raw); }
      else { step = 'harvest'; Object.assign(out, await harvest(svc, cfg)); }
    }
  }
  const { count: pending } = await svc.from('leads').select('id', { count: 'exact', head: true }).eq('status', 'ready');
  const status = { ok: true, ts: new Date().toISOString(), step, quota_left: quota, ready_today: readyToday ?? 0, pending: pending ?? 0, ...out };
  await svc.from('site_settings').upsert({ key: 'leads_status', value_meta: status }, { onConflict: 'key' });
  return status;
}

// ── harvest (KRS) ───────────────────────────────────────────────────────────
async function krsGet(path: string) {
  for (const wait of [0, 1500, 4000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const r = await fetch(`${KRS}/${path}`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (r?.ok) return r.json();
    if (r && r.status === 404) return null;
  }
  return null;
}

function industryOf(code: string, enabled: string[]): string | null {
  for (const key of enabled) {
    const ind = INDUSTRIES[key];
    if (ind && ind.pkd.some((p) => code.startsWith(p))) return key;
  }
  return null;
}

async function harvest(svc: any, cfg: Cfg) {
  const nums = new Set<number>();
  for (let d = 1; d <= 4; d++) {
    const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const list = await krsGet(`Biuletyn/${day}`);
    if (Array.isArray(list)) for (const x of list) nums.add(Number(x));
  }
  if (!nums.size) return { harvested: 0, note: 'empty bulletin' };
  // New registrations get the highest KRS numbers.
  const max = Math.max(...nums);
  const fresh = [...nums].filter((n) => n >= max - 4000).sort((a, b) => b - a).slice(0, 900).map((n) => String(n).padStart(10, '0'));
  const seenSet = new Set<string>();
  for (let i = 0; i < fresh.length; i += 150) {
    const { data: seen } = await svc.from('lead_seen').select('ext_id').eq('source', 'krs').in('ext_id', fresh.slice(i, i + 150));
    for (const s of seen || []) seenSet.add(s.ext_id);
  }
  const todo = fresh.filter((k) => !seenSet.has(k)).slice(0, 70);
  const minDate = Date.now() - cfg.max_age_days * 86400000;
  const rows: any[] = [];
  let fetched = 0;
  for (let i = 0; i < todo.length && budgetLeft() > 25_000; i += 7) {
    const chunk = todo.slice(i, i + 7);
    const res = await Promise.all(chunk.map((k) => krsGet(`OdpisAktualny/${k}?rejestr=P&format=json`)));
    fetched += chunk.length;
    await svc.from('lead_seen').upsert(chunk.map((k) => ({ source: 'krs', ext_id: k })), { onConflict: 'source,ext_id', ignoreDuplicates: true });
    res.forEach((d, j) => { const r = parseKrs(d, chunk[j], cfg, minDate); if (r) rows.push(r); });
  }
  let added = 0;
  if (rows.length) {
    const emails = rows.map((r) => r.email);
    const [{ data: sup }, { data: ex }] = await Promise.all([
      svc.from('lead_suppression').select('email').in('email', emails),
      svc.from('leads').select('email').in('email', emails),
    ]);
    const block = new Set([...(sup || []), ...(ex || [])].map((x: any) => String(x.email).toLowerCase()));
    const ok = rows.filter((r) => !block.has(r.email));
    if (ok.length) {
      const { data: ins } = await svc.from('leads').upsert(ok, { onConflict: 'source,ext_id', ignoreDuplicates: true }).select('id');
      added = ins?.length ?? 0;
    }
  }
  return { harvested: added, fetched, candidates: rows.length };
}

function parseKrs(d: any, krs: string, cfg: Cfg, minDate: number) {
  const o = d?.odpis; if (!o) return null;
  const dane = o.dane || {}; const d1 = dane.dzial1 || {}; const s = d1.siedzibaIAdres || {};
  const email = String(s.adresPocztyElektronicznej || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) return null;
  const [dd, mm, yy] = String(o.naglowekA?.dataRejestracjiWKRS || '').split('.');
  const reg = yy ? new Date(`${yy}-${mm}-${dd}T12:00:00Z`) : null;
  if (!reg || reg.getTime() < minDate) return null;
  if (JSON.stringify(dane.dzial6 || {}).includes('likwidac')) return null;
  const main = (dane.dzial3?.przedmiotDzialalnosci?.przedmiotPrzewazajacejDzialalnosci || [])[0] || {};
  const code = `${main.kodDzial || ''}.${main.kodKlasa || ''}.${main.kodPodklasa || ''}`;
  const others = (dane.dzial3?.przedmiotDzialalnosci?.przedmiotPozostalejDzialalnosci || []).slice(0, 6).map((p: any) => ({ code: `${p.kodDzial}.${p.kodKlasa}.${p.kodPodklasa}`, desc: p.opis }));
  let industry = industryOf(code, cfg.industries);
  if (!industry) for (const p of others.slice(0, 3)) { industry = industryOf(p.code, cfg.industries); if (industry) break; }
  if (!industry) return null;
  const voiv = String(s.siedziba?.wojewodztwo || '').toUpperCase();
  if (cfg.voivodeships.length && !cfg.voivodeships.includes(voiv)) return null;
  const sklad = dane.dzial2?.reprezentacja?.sklad || [];
  const board = sklad.slice(0, 5).map((m: any) => {
    const p = String(m.identyfikator?.pesel || '');
    const first = Number(p[0]);
    return { role: m.funkcjaWOrganie, initials: `${(m.imiona?.imie || '?')[0]}. ${(m.nazwisko?.nazwiskoICzlon || '?')[0]}.`, decade: Number.isFinite(first) && p ? (first === 0 ? '2000' : first === 1 ? '1910' : `19${first}0`) : null };
  });
  const a = s.adres || {};
  const cap = d1.kapital?.wysokoscKapitaluZakladowego;
  return {
    source: 'krs', ext_id: krs, status: 'raw',
    name: titleCase(d1.danePodmiotu?.nazwa || ''), legal_form: titleCase(d1.danePodmiotu?.formaPrawna || ''),
    registered_at: reg.toISOString().slice(0, 10),
    city: titleCase(s.siedziba?.miejscowosc || ''), voivodeship: voiv,
    address: [a.ulica, a.nrDomu, a.nrLokalu ? `/${a.nrLokalu}` : '', a.kodPocztowy, a.miejscowosc].filter(Boolean).join(' '),
    email, website: s.adresStronyInternetowej ? String(s.adresStronyInternetowej).toLowerCase() : null,
    nip: d1.danePodmiotu?.identyfikatory?.nip || null, regon: d1.danePodmiotu?.identyfikatory?.regon || null,
    capital: cap ? `${cap.wartosc} ${cap.waluta}` : null,
    pkd_code: code, pkd_desc: capFirst(main.opis || ''), pkd_other: others.map((x: any) => ({ ...x, desc: capFirst(x.desc || '') })),
    board, industry, raw: { krs },
  };
}
const FORMS: [RegExp, string][] = [
  [/\s*spółka z ograniczoną odpowiedzialnością(\s+spółka komandytowa)?/giu, ' sp. z o.o.$1'],
  [/\s*prosta spółka akcyjna/giu, ' P.S.A.'], [/\s*spółka akcyjna/giu, ' S.A.'],
  [/\s*spółka komandytowa/giu, ' sp.k.'], [/\s*spółka jawna/giu, ' sp.j.'], [/\s*spółka partnerska/giu, ' sp.p.'],
];
const titleCase = (s: string) => {
  let t = s.toLowerCase().replace(/\s+/g, ' ').replace(/(^|[\s\-("„])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());
  for (const [re, to] of FORMS) t = t.replace(re, to);
  return t.replace(/(sp\.j\.)\s+sp\.j\./gi, '$1').replace(/\bsp\. z o\.o\. sp\.k\./, 'sp. z o.o. sp.k.').replace(/\s+/g, ' ').trim();
};
const capFirst = (s: string) => { const l = s.toLowerCase(); return l.charAt(0).toUpperCase() + l.slice(1); };

// ── Claude ──────────────────────────────────────────────────────────────────
const claude = () => new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')!, maxRetries: 2, timeout: 90_000 });

async function claudeJson(svc: any, feature: string, model: 'sonnet' | 'haiku', system: string, user: string, schema: object, maxTokens = 4000) {
  const msg = await claude().messages.create({
    model: MODELS[model], max_tokens: maxTokens, system,
    thinking: { type: model === 'haiku' ? 'disabled' : 'between_tools' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }],
  } as any);
  const u: any = msg.usage || {};
  const cost = ((u.input_tokens || 0) * PRICE[model][0] + (u.output_tokens || 0) * PRICE[model][1]) / 1e6;
  await svc.from('ai_usage').insert({ feature, model: MODELS[model], input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cost_usd: Number(cost.toFixed(5)) });
  if (msg.stop_reason === 'refusal') throw new Error('claude refusal');
  const text = msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  return JSON.parse(text);
}

async function budgetOk(svc: any, need = 0.05) {
  const [{ data: spent }, { data: row }] = await Promise.all([svc.rpc('ai_month_spend'), svc.from('site_settings').select('value_meta').eq('key', 'ai_budget').maybeSingle()]);
  const cap = Number(row?.value_meta?.monthly_usd) || 15;
  return { ok: Number(spent || 0) + need <= cap, spent: Number(spent || 0), cap };
}

async function scoreBatch(svc: any, cfg: Cfg, raw: any[]) {
  const schema = { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'fit', 'reason'], properties: { id: { type: 'string' }, fit: { type: 'integer' }, reason: { type: 'string' } } } } } };
  const lines = raw.map((l) => `id=${l.id} | ${l.name} (${l.legal_form}) | ${l.city}, ${l.voivodeship} | zarej. ${l.registered_at} | PKD ${l.pkd_code} ${l.pkd_desc} | inne: ${(l.pkd_other || []).slice(0, 3).map((p: any) => p.desc).join('; ')} | e-mail ${l.email} | www ${l.website || 'brak'} | kapitał ${l.capital || '?'} | zarząd ${(l.board || []).map((b: any) => b.decade ? `ur. ${b.decade}s` : '?').join(', ')}`).join('\n');
  const r = await claudeJson(svc, 'leads-score', 'haiku',
    `Oceniasz świeżo zarejestrowane polskie firmy jako potencjalnych klientów studia BarabashFlow (strony internetowe od 3 500 zł, sklepy od 8 000 zł, platformy od 15 000 zł). fit 0–100 = szansa, że ta firma realnie potrzebuje teraz strony/sklepu/platformy i zapłaci za jakość.
Wysoko: działalność skierowana do klientów (B2C lub usługi B2B), która zdobywa klientów przez internet; brak strony; e-mail we własnej domenie albo marka wyglądająca na realny biznes; branże z rezerwacjami, ofertą, portfolio, sklepem.
Nisko (<35): spółki celowe/holdingowe/inwestycyjne (SPV, "Capital", "Investment", "Holding"), wynajem własnych nieruchomości, spółki-wydmuszki, fundacje bez działalności, komplementariusze, firmy z sektora IT/marketingu (zrobią sobie same), bardzo ogólne PKD bez jasnego profilu.
reason: 1 krótkie zdanie po polsku dla właściciela studia — dlaczego tak (konkret, co mogłaby dostać).`,
    lines, schema, 6000);
  let n = 0;
  for (const it of r.items || []) {
    const lead = raw.find((l) => l.id === it.id); if (!lead) continue;
    const fit = Math.max(0, Math.min(100, Number(it.fit) || 0));
    await svc.from('leads').update({ fit_score: fit, fit_reason: String(it.reason || '').slice(0, 300), status: fit >= cfg.min_fit ? 'scored' : 'rejected' }).eq('id', lead.id);
    n++;
  }
  // anything Claude skipped → back to raw next time is pointless; mark rejected
  const done = new Set((r.items || []).map((i: any) => i.id));
  for (const l of raw) if (!done.has(l.id)) await svc.from('leads').update({ status: 'rejected', fit_reason: 'brak oceny' }).eq('id', l.id);
  return n;
}

async function compose(svc: any, cfg: Cfg, lead: any, instruction: string) {
  const [{ data: services }, { data: projects }] = await Promise.all([
    svc.from('services').select('slug,title_pl,price_from').eq('is_published', true).order('sort_order'),
    svc.from('projects').select('slug,client,title_pl,challenge_pl,services').eq('is_published', true).order('sort_order'),
  ]);
  const caseSlugs = (projects || []).map((p: any) => p.slug);
  const svcSlugs = (services || []).map((s: any) => s.slug);
  const schema = {
    type: 'object', additionalProperties: false, required: ['subject', 'body', 'landing'],
    properties: {
      subject: { type: 'string' }, body: { type: 'string' },
      landing: {
        type: 'object', additionalProperties: false,
        required: ['headline', 'intro', 'bullets', 'est_type', 'est_features', 'case_slug', 'service_slug'],
        properties: {
          headline: { type: 'string' }, intro: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
          est_type: { type: 'string', enum: ['landing', 'site', 'shop', 'platform', 'redesign'] },
          est_features: { type: 'array', items: { type: 'string', enum: ['cms', 'blog', 'i18n', 'booking', 'payments', 'integrations', 'accounts', 'motion'] } },
          case_slug: { type: 'string', enum: caseSlugs.length ? caseSlugs : ['none'] },
          service_slug: { type: 'string', enum: svcSlugs.length ? svcSlugs : ['strony-internetowe'] },
        },
      },
    },
  };
  const r = await claudeJson(svc, 'leads-compose', 'sonnet',
    `Piszesz pierwszy e-mail od Damiana Barabasha (BarabashFlow, Warszawa; sam projektuje i wdraża strony, sklepy i platformy webowe) do świeżo zarejestrowanej firmy. Cel: konkretna, krótka propozycja dopasowana do TEJ firmy, na którą chce się odpisać.
Zasady:
- Po polsku, forma "Państwo" konsekwentnie w całym mailu ("mają Państwo", "u Państwa"; nigdy "macie", "wasz", "Ty"), uprzejmie, po ludzku, bez korpo-żargonu i bez wazeliny. Bez emoji, bez markdown, bez wykrzykników w nadmiarze.
- 80-130 słów, 3-4 krótkie akapity oddzielone JEDNĄ pustą linią. Żadnych podwójnych pustych linii, list punktowanych ani długich odstępów.
- Akapit 1: "Dzień dobry," + jedno zdanie: zauważyłem, że firma niedawno wystartowała (nazwa, czym się zajmuje według PKD, naturalnie, bez cytowania kodów).
- Akapit 2: konkretnie, co strona/sklep/system dałby właśnie im (np. rezerwacje online, galeria realizacji, formularz wyceny, katalog produktów), 2 zdania, z sensem dla branży.
- Akapit 3: jeden pasujący przykład realizacji z listy (sama nazwa, bez linku) ORAZ cena i czas: odpowiednia usługa "od X zł netto", typowo gotowe w 2-3 tygodnie. Potem zdanie z linkiem do strony przygotowanej specjalnie dla nich — wstaw dokładnie znacznik {{LINK}} (np. "Krótką propozycję dla [nazwa firmy] z wyceną i przykładem przygotowałem tutaj: {{LINK}}"). Żadnych innych linków.
- Akapit 4: proste wezwanie, np. "Jeśli to temat na teraz, wystarczy odpisać, a przygotuję wycenę w 24 h."
- ZAKAZ: nigdy nie używaj długiego myślnika (—) ani półpauzy (–), ani w treści, ani w temacie, ani w landing. Zamiast nich przecinek, kropka, dwukropek albo nawias; zakresy liczb z łącznikiem (2-3 tygodnie).
- NIE dopisuj podpisu ani stopki (dodam je sam). Nie wymyślaj faktów o firmie ani wyników projektów.
- Temat: krótki (do 60 znaków), konkretny, z nazwą firmy lub branżą, bez clickbaitu i bez "Oferta".
- landing = treść osobistej strony z propozycją (ta sama obietnica co w mailu): headline (do 70 znaków, z nazwą firmy, np. "Strona z rezerwacjami dla Beztroskiej Zatoki"), intro (2–3 zdania do nich, forma "Państwo"), bullets (dokładnie 3 konkretne elementy, co zbuduję dla nich, każdy do 110 znaków), est_type + est_features (ustawienia kalkulatora pasujące do propozycji), case_slug (ten sam przykład co w mailu), service_slug (usługa, której dotyczy cena).
${cfg.instructions ? `\nDodatkowe wskazówki właściciela: ${cfg.instructions}` : ''}${instruction ? `\nPOLECENIE DO TEJ WERSJI: ${instruction}` : ''}`,
    `FIRMA: ${lead.name} (${lead.legal_form}), ${lead.city}; zarejestrowana ${lead.registered_at}; główna działalność: ${lead.pkd_desc}; inne: ${(lead.pkd_other || []).slice(0, 4).map((p: any) => p.desc).join('; ')}; strona: ${lead.website || 'brak'}; e-mail: ${lead.email}.
Ocena dopasowania: ${lead.fit_reason || '—'}
USŁUGI: ${(services || []).map((s: any) => `${s.title_pl}: ${s.price_from}`).join('; ')}
REALIZACJE: ${(projects || []).map((p: any) => `${p.slug} (${p.client || p.title_pl}): ${String(p.challenge_pl || '').slice(0, 140)}`).join(' | ')}`,
    schema, 2500);
  const clean = String(r.body || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const landing = r.landing || null;
  if (landing) landing.bullets = (landing.bullets || []).slice(0, 3);
  if (landing) {
    for (const k of ['headline', 'intro'] as const) landing[k] = noDash(landing[k]);
    landing.bullets = (landing.bullets || []).map(noDash);
  }
  return { subject: noDash(String(r.subject || '').trim()).slice(0, 120), body: withLink(noDash(clean), lead.public_token), landing };
}

// ── send ────────────────────────────────────────────────────────────────────
// Always present (code, not AI): where to see the work + the site link.
const PORTFOLIO_LINE = 'Wszystkie moje realizacje (strony, sklepy i platformy) można zobaczyć na https://barabashflow.pl/projekty/';
function footer(cfg: Cfg, source: string) {
  const reg = source === 'ceidg' ? 'CEIDG' : 'KRS';
  return `${PORTFOLIO_LINE}\n\n${cfg.signature}\n\nAdres pochodzi z publicznego rejestru ${reg}. Jeśli to nie temat dla Państwa, wystarczy odpisać „NIE”, a więcej nie napiszę.`;
}
// Owner's rule: NEVER an em/en dash in e-mails. Ranges → hyphen, dashes used as
// punctuation → comma, leftovers → hyphen. Applied to everything that is sent.
export const noDash = (t: string) => String(t ?? '')
  .replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2')
  .replace(/[ \t]+[—–][ \t]+/g, ', ')
  .replace(/[—–]/g, '-')
  .replace(/,\s*,/g, ',').replace(/,\s*([.:;!?])/g, '$1').replace(/\(\s*,\s*/g, '(');
const personalUrl = (token: string) => `${SITE}/oferta/?l=${token}`;
// Body always carries the personal link: {{LINK}} → URL; old drafts with the
// calculator link get it replaced; if missing, a line goes before the last paragraph.
function withLink(text: string, token: string) {
  if (!token) return text;
  const url = personalUrl(token);
  let t = text.replace(/\{\{LINK\}\}/g, url).replace(/https:\/\/barabashflow\.pl\/#kalkulator\.?/g, url);
  if (!t.includes('/oferta/?l=')) {
    const parts = t.split('\n\n');
    parts.splice(Math.max(1, parts.length - 1), 0, `Krótką propozycję z wyceną przygotowałem tutaj: ${url}`);
    t = parts.join('\n\n');
  }
  return t;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  // keep '3 500 zł' / '2–3 tygodnie' together in HTML
  .replace(/(\d) (\d{3})(?!\d)/g, '$1&nbsp;$2').replace(/(\d) (zł|tyg|PLN)/g, '$1&nbsp;$2');
// HTML version: plain-looking letter, but the personal-page link becomes a
// bulletproof (table-based) brand button; the text part keeps the raw URL.
const shortName = (name: string) => String(name || '').replace(/\s+(sp\. z o\.o\.|sp\.j\.|sp\.k\.|sp\.p\.|S\.A\.|P\.S\.A\.).*$/i, '').trim();
// Site-style button (like .btn-dark.with-icon): dark pill, lime square with an
// arrow, white label — two table cells so it never wraps, each cell is a link.
const button = (url: string, label: string) => {
  const a = (inner: string, style: string) => `<a href="${url}" target="_blank" style="text-decoration:none;${style}">${inner}</a>`;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:10px 0 18px;border-collapse:separate"><tr>` +
    `<td style="background:#0b0b0b;border-radius:14px;padding:6px 22px 6px 6px;white-space:nowrap">` +
      `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>` +
        `<td width="38" height="38" align="center" valign="middle" style="width:38px;height:38px;background:#98ff03;border-radius:10px;text-align:center;vertical-align:middle">` +
          a('&rarr;', 'display:block;width:38px;line-height:38px;font-family:Arial,Helvetica,sans-serif;font-size:19px;font-weight:700;color:#030712') +
        `</td>` +
        `<td valign="middle" style="padding-left:14px;vertical-align:middle;white-space:nowrap">` +
          a(esc(label), 'display:inline-block;white-space:nowrap;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;line-height:20px;color:#ffffff') +
        `</td>` +
      `</tr></table>` +
    `</td></tr></table>`;
};
const linkify = (html: string) => html
  .replace(/(https:\/\/barabashflow\.pl[^\s<]*?)([.,;:]?)(?=\s|<|$)/g, (_m, url, punct) => `<a href="${url}" style="color:#030712;font-weight:700;text-decoration:underline">${url.replace(/^https:\/\//, '').replace(/\/$/, '')}</a>${punct}`)
  .replace(/(^|\s|<br>)barabashflow\.pl(?=\s|<|$)/g, '$1<a href="https://barabashflow.pl" style="color:#030712;font-weight:700;text-decoration:underline">barabashflow.pl</a>');
const toHtml = (text: string, company = '') => {
  const paras = text.split(/\n\n/);
  const out: string[] = [];
  paras.forEach((p, i) => {
    const last = i === paras.length - 1;
    const m = p.match(/https:\/\/barabashflow\.pl\/oferta\/\?l=[a-z0-9]+/);
    if (m) {
      const sentence = p.replace(m[0], '').replace(/\s*[.,;]\s*$/, '').replace(/\s*[:\-–—]?\s*$/, ':').replace(/\s+:/, ':').replace(/\s{2,}/g, ' ').trim();
      if (sentence.length > 1) out.push(`<p style="margin:0 0 10px">${esc(sentence).replace(/\n/g, '<br>')}</p>`);
      out.push(button(m[0], 'Zobacz propozycję dla Państwa'));
      return;
    }
    out.push(`<p style="margin:0 0 ${last ? 0 : 10}px">${linkify(esc(p).replace(/\n/g, '<br>'))}</p>`);
  });
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">${out.join('')}</div>`;
};

async function send(svc: any, cfg: Cfg, b: any) {
  const { data: lead } = await svc.from('leads').select('*').eq('id', b.id).single();
  if (!lead) throw new Error('lead not found');
  const subject = noDash(String(b.subject ?? lead.subject ?? '').trim());
  const text0 = noDash(String(b.body ?? lead.body ?? '')).replace(/\n{3,}/g, '\n\n').trim();
  if (!subject || text0.length < 40) throw new Error('pusty temat lub treść');
  const test = !!(b.test || cfg.test_mode);
  if (!test) {
    if (lead.status === 'sent') throw new Error('już wysłano');
    const { data: sup } = await svc.from('lead_suppression').select('reason').eq('email', lead.email.toLowerCase()).maybeSingle();
    if (sup) throw new Error(`adres zablokowany (${sup.reason})`);
  }
  const text = noDash(`${withLink(text0, lead.public_token)}\n\n${footer(cfg, lead.source)}`);
  // CRM client first: its mail_tag is the reply address, so the answer lands
  // in the client's card (edge mail-in). A client created here is removed if
  // Resend refuses the e-mail.
  let client: any = null, created = false;
  if (!test) {
    client = (await svc.from('crm_clients').select('id,mail_tag').ilike('email', lead.email).maybeSingle()).data;
    if (!client) {
      const { data: c, error } = await svc.from('crm_clients').insert({ name: lead.name, email: lead.email.toLowerCase(), company: lead.name, website: lead.website, source: 'other', status: 'contact', tags: ['lead-' + lead.source], notes: `${lead.pkd_desc || ''} · ${lead.city || ''} · zarej. ${lead.registered_at}\n${lead.fit_reason || ''}`.trim(), next_action: 'Sprawdzić odpowiedź na ofertę', next_action_at: new Date(Date.now() + 4 * 86400000).toISOString() }).select('id,mail_tag').single();
      if (error) throw error;
      client = c; created = true;
    }
  }
  const inbox = client && (await inboxReady(svc));
  const replyTo = inbox ? `${cfg.from_name} <office+${client.mail_tag}@${REPLY_DOMAIN}>` : cfg.from_email;
  const messageId = `<${crypto.randomUUID()}@barabashflow.pl>`;
  const { data: rkey } = await svc.rpc('get_secret', { p_name: 'resend_api_key' });
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${rkey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${cfg.from_name} <${cfg.from_email}>`,
      to: [test ? (cfg.notify_email || cfg.from_email) : lead.email],
      reply_to: replyTo,
      // no BCC: the whole thread lives in the CRM card
      subject: test ? `[TEST] ${subject}` : subject,
      text, html: toHtml(text, lead.name),
      headers: { 'Message-ID': messageId, 'List-Unsubscribe': `<mailto:${inbox ? `office+${client.mail_tag}@${REPLY_DOMAIN}` : cfg.from_email}?subject=NIE>` },
      tags: [{ name: 'kind', value: 'lead' }],
    }),
  });
  const res = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (created) await svc.from('crm_clients').delete().eq('id', client.id);
    if (!test) await svc.from('leads').update({ status: 'failed', error: JSON.stringify(res).slice(0, 300), subject, body: text0 }).eq('id', lead.id);
    throw new Error(`Resend HTTP ${r.status}: ${res?.message || ''}`);
  }
  if (test) return { ok: true, test: true, to: cfg.notify_email || cfg.from_email };
  await svc.from('leads').update({ status: 'sent', sent_at: new Date().toISOString(), decided_at: new Date().toISOString(), resend_id: res.id, subject, body: text0, error: null, crm_client_id: client.id }).eq('id', lead.id);
  await svc.from('lead_suppression').upsert({ email: lead.email.toLowerCase(), reason: 'contacted' }, { onConflict: 'email', ignoreDuplicates: true });
  // CRM: exactly what was offered, as the first message of the thread
  await svc.from('crm_activities').insert({ client_id: client.id, kind: 'email', body: text0, meta: { dir: 'out', label: 'Oferta', subject, to: lead.email, message_id: messageId, resend_id: res.id, reply_to: replyTo, lead_id: lead.id } });
  return { ok: true, resend_id: res.id, crm_client_id: client.id, reply_to: replyTo };
}

// Reply domain (Resend Receiving on reply.barabashflow.pl, edge mail-in).
// Until its MX is verified, replies go to office@ (Hostinger → Gmail).
const REPLY_DOMAIN = 'reply.barabashflow.pl';
let readyCache: { at: number; ok: boolean } | null = null;
async function inboxReady(svc: any) {
  if (readyCache && Date.now() - readyCache.at < 5 * 60_000) return readyCache.ok;
  try {
    const { data: rk } = await svc.rpc('get_secret', { p_name: 'resend_api_key' });
    const d = await (await fetch('https://api.resend.com/domains/019a6899-eb09-49a8-b170-3176eda0d0eb', { headers: { Authorization: `Bearer ${rk}` } })).json();
    const mx = (d.records || []).find((x: any) => x.record === 'Receiving');
    readyCache = { at: Date.now(), ok: (mx?.status || d.status) === 'verified' };
  } catch { readyCache = { at: Date.now(), ok: false }; }
  return readyCache.ok;
}

// ── personal landing (public) ───────────────────────────────────────────────
async function publicView(svc: any, token: string, preview = false) {
  if (!/^[a-z0-9]{8,16}$/.test(token)) throw new Error('not found');
  const { data: l } = await svc.from('leads').select('id,name,city,industry,landing,views,viewed_at,status,pkd_desc').eq('public_token', token).maybeSingle();
  if (!l || !l.landing) throw new Error('not found');
  const now = new Date().toISOString();
  if (!preview) await svc.from('leads').update({ views: (l.views || 0) + 1, viewed_at: l.viewed_at || now, last_viewed_at: now }).eq('id', l.id);
  const [{ data: proj }, { data: sv }] = await Promise.all([
    svc.from('projects').select('slug,title_pl,client,challenge_pl,cover_path,url').eq('slug', l.landing.case_slug || '').maybeSingle(),
    svc.from('services').select('slug,title_pl,price_from').eq('slug', l.landing.service_slug || 'strony-internetowe').maybeSingle(),
  ]);
  const media = (p?: string | null) => (p ? (/^https?:/.test(p) ? p : `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/media/${p}`) : null);
  return {
    company: l.name, city: l.city, industry: INDUSTRIES[l.industry]?.label || null, activity: l.pkd_desc,
    landing: l.landing,
    case: proj ? { slug: proj.slug, title: proj.client || proj.title_pl, challenge: proj.challenge_pl, cover: media(proj.cover_path), url: `${SITE}/projekty/${proj.slug}/` } : null,
    service: sv ? { slug: sv.slug, title: sv.title_pl, price: sv.price_from } : null,
  };
}

async function publicBrief(svc: any, cfg: Cfg, b: any) {
  const token = String(b.token || '');
  const { data: l } = await svc.from('leads').select('id,name,email,city,subject,body,sent_at,briefed_at,crm_client_id,public_token').eq('public_token', token).maybeSingle();
  if (!l) throw new Error('not found');
  const recent = l.briefed_at && Date.now() - new Date(l.briefed_at).getTime() < 10 * 60_000;
  await svc.from('leads').update({ briefed_at: new Date().toISOString() }).eq('id', l.id);
  if (l.crm_client_id) await svc.from('crm_activities').insert({ client_id: l.crm_client_id, kind: 'note', body: `Zostawił brief na stronie oferty:\n${String(b.summary || '').slice(0, 1500)}` });
  if (!recent) {
    const { data: rkey } = await svc.rpc('get_secret', { p_name: 'resend_api_key' });
    const text = `${l.name} (${l.city || ''}) zostawił brief na swojej stronie oferty.\n\nKontakt: ${String(b.name || '').slice(0, 80)} <${String(b.email || '').slice(0, 120)}>\n\n${String(b.summary || '').slice(0, 2000)}\n\nStrona: ${personalUrl(l.public_token)}\n\n— Twoja oferta (${l.sent_at ? new Date(l.sent_at).toLocaleDateString('pl-PL') : 'niewysłana'}): ${l.subject || ''}\n\n${l.body || ''}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${rkey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `BarabashFlow Leady <${cfg.from_email}>`, to: [cfg.notify_email], reply_to: String(b.email || l.email), subject: `🔥 ${l.name} zostawił brief`, text }),
    }).catch(() => null);
  }
  return { ok: true };
}
