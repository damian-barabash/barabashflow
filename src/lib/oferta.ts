// /oferta/?l=<token> — personal offer page for outbound leads. Fetches the
// lead's public data (edge `leads`, action "view": company, city, tailored
// headline/intro/3 points, case, service price, estimator preset), fills the
// static shell and presets the estimator (custom event "est:preset"). The
// estimator reports a sent brief back via data-lead-token (action "brief").
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const set = (key: string, text: string) => { const el = $(`[data-of="${key}"]`); if (el) el.textContent = text; };

export async function mountOferta() {
  const hero = $('.of-hero');
  const token = new URLSearchParams(location.search).get('l') || '';
  const fail = () => { hero?.classList.remove('is-loading'); hero?.classList.add('is-error'); $('.of-error')!.hidden = false; set('company', 'Twojej firmy'); set('headline', 'Strona, która zdobywa klientów — policz wycenę w 40 sekund'); };
  if (!/^[a-z0-9]{8,16}$/.test(token)) { fail(); return; }
  let d: any;
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ action: 'view', token, preview: new URLSearchParams(location.search).has('preview') }),
    });
    d = await r.json();
    if (!r.ok || !d?.landing) throw new Error(d?.error || 'not found');
  } catch { fail(); return; }

  const L = d.landing;
  const short = String(d.company || '').replace(/\s+(sp\. z o\.o\.|sp\.j\.|sp\.k\.|S\.A\.|P\.S\.A\.).*$/i, '');
  set('company', d.company);
  document.querySelectorAll('[data-of="company-short"]').forEach((el) => { el.textContent = short; });
  set('headline', L.headline || '');
  set('intro', L.intro || '');
  set('meta', [d.city, d.industry].filter(Boolean).join(' · '));
  const ol = $('[data-of="bullets"]');
  if (ol) ol.innerHTML = '';
  for (const b of L.bullets || []) { const li = document.createElement('li'); li.textContent = b; ol?.appendChild(li); }
  if (d.service?.price) set('price', `${d.service.price} netto`);
  if (d.case) {
    const a = $<HTMLAnchorElement>('[data-of="case"]')!;
    a.href = d.case.url; a.hidden = false;
    const img = $<HTMLImageElement>('[data-of="case-cover"]');
    if (img && d.case.cover) { img.src = d.case.cover; img.alt = d.case.title; } else img?.remove();
    set('case-title', d.case.title || '');
    set('case-challenge', d.case.challenge || '');
  }
  document.querySelectorAll<HTMLElement>('.of-plan-sec').forEach((el) => { el.hidden = false; });
  hero?.classList.remove('is-loading');
  document.title = `Propozycja dla ${short} | BarabashFlow`;

  const est = $('[data-estimator]');
  if (est) {
    est.dataset.leadToken = token;
    est.dataset.topic = `Oferta: ${d.company}`;
    est.dispatchEvent(new CustomEvent('est:preset', { detail: { type: L.est_type, features: L.est_features || [] } }));
  }
}
