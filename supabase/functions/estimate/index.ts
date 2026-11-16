// Edge `estimate` (verify_jwt: false) — short AI commentary for the blog
// estimator widget (src/lib/estimator.ts).
//
// The browser computes the price/timeline range deterministically and sends
// it here; Claude only writes 2–3 sentences of advice in the visitor's
// language and is told to reuse the given numbers verbatim. Public endpoint →
// rate limited per IP (hashed, never stored raw) and globally per day; on any
// limit/error the widget falls back to a template comment.
import Anthropic from 'npm:@anthropic-ai/sdk@1.8.0';
import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = [/^https:\/\/barabashflow\.pl$/, /^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/];
const PER_IP_PER_HOUR = 8;
const GLOBAL_PER_DAY = 300;

const LANG: Record<string, string> = { pl: 'polsku', en: 'English', ru: 'русском' };

const SYSTEM = `Jesteś Damianem Barabashem (BarabashFlow, Warszawa) — projektujesz i wdrażasz strony, sklepy i platformy webowe (Astro, Next.js, Supabase, własny CMS, SEO). Odwiedzający bloga wypełnił krótki brief w kalkulatorze; kalkulator już policzył widełki budżetu i czasu.
Napisz komentarz do jego briefu: 2–3 zdania, maks. 380 znaków, w pierwszej osobie, konkretnie i po ludzku.
- Co jest sercem tego projektu i od czego zacząłbyś (1 konkretna rada dopasowana do wybranych funkcji/typu).
- Co najbardziej wpływa na cenę w TYM briefie, albo jak obniżyć koszt bez utraty efektu.
Zasady: nie podawaj żadnych NOWYCH kwot ani terminów; jeśli wspominasz liczby, użyj dokładnie tych z kalkulatora. Bez powitań, bez "Świetny wybór", bez emoji, bez markdown. Nie obiecuj niczego, czego nie ma w briefie.`;

function cors(origin: string | null) {
  const ok = origin && ALLOWED_ORIGINS.some((r) => r.test(origin));
  return {
    'Access-Control-Allow-Origin': ok ? origin! : 'https://barabashflow.pl',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

async function sha(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

const fmt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const str = (v: unknown, max = 120) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, max);

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get('origin')), 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method' }), { status: 405, headers });

  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'json' }), { status: 400, headers }); }
  const b = body?.brief || {};
  const e = body?.estimate || {};
  const locale = ['pl', 'en', 'ru'].includes(body?.locale) ? body.locale : 'pl';
  if (!Number.isFinite(e.lo) || !Number.isFinite(e.hi)) return new Response(JSON.stringify({ error: 'estimate' }), { status: 400, headers });

  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const ipHash = await sha(`bf-est:${ip}`);
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  const [{ count: perIp }, { count: global }] = await Promise.all([
    svc.from('estimate_calls').select('id', { count: 'exact', head: true }).eq('ip_hash', ipHash).gte('created_at', hourAgo),
    svc.from('estimate_calls').select('id', { count: 'exact', head: true }).gte('created_at', dayAgo),
  ]);
  // Admin → Blog → Kalkulator: AI on/off + limits (site_settings.estimator_config.ai).
  const { data: cfgRow } = await svc.from('site_settings').select('value_meta').eq('key', 'estimator_config').maybeSingle();
  const ai = { enabled: true, per_ip_hour: PER_IP_PER_HOUR, per_day: GLOBAL_PER_DAY, ...(cfgRow?.value_meta?.ai || {}) };
  const [{ data: spent }, { data: bud }] = await Promise.all([svc.rpc('ai_month_spend'), svc.from('site_settings').select('value_meta').eq('key', 'ai_budget').maybeSingle()]);
  if (Number(spent || 0) >= (Number(bud?.value_meta?.monthly_usd) || 15)) return new Response(JSON.stringify({ text: '', budget: true }), { headers });
  if (!ai.enabled) return new Response(JSON.stringify({ text: '', disabled: true }), { headers });
  if ((perIp ?? 0) >= Number(ai.per_ip_hour) || (global ?? 0) >= Number(ai.per_day)) {
    return new Response(JSON.stringify({ text: '', limited: true }), { headers });
  }

  const brief = [
    `Język odpowiedzi: ${LANG[locale]}.`,
    `Temat artykułu, z którego przyszedł: ${str(body?.topic, 160)}`,
    `Typ: ${str(b.type, 30)}; podstrony: ${str(b.pages, 10)}; funkcje: ${(Array.isArray(b.features) ? b.features : []).map((x: unknown) => str(x, 20)).join(', ') || 'brak'}; treści: ${str(b.content, 10)}; start: ${str(b.start, 10)}.`,
    `Kalkulator: ${fmt(e.lo)}–${fmt(e.hi)} zł netto, ${Number(e.wlo) || 2}–${Number(e.whi) || 3} tygodnie (jeśli podajesz kwoty, pisz je dokładnie w tym formacie, ze spacją co trzy cyfry).`,
  ].join('\n');

  let text = '';
  let ok = true;
  try {
    const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')!, timeout: 10500, maxRetries: 0 });
    // Haiku 5.5, thinking off: ~$0.0003 per comment (budget-safe even at the daily cap).
    const msg = await client.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 400,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      system: SYSTEM,
      messages: [{ role: 'user', content: brief }],
    } as any);
    const u: any = msg.usage || {};
    await svc.from('ai_usage').insert({ feature: 'estimate', model: 'claude-haiku-5-5', input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cost_usd: Number((((u.input_tokens || 0) * 0.1 + (u.output_tokens || 0) * 0.5) / 1e6).toFixed(5)) });
    if (msg.stop_reason !== 'refusal') {
      text = msg.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
    }
  } catch (err) {
    ok = false;
    console.error('[estimate] claude failed', String(err).slice(0, 300));
  }
  await svc.from('estimate_calls').insert({ ip_hash: ipHash, ok });
  return new Response(JSON.stringify({ text }), { headers });
});
