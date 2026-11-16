// Blog estimator widget (client). 5-step brief → deterministic range from the
// pricing model → short AI commentary from the `estimate` edge function
// (Claude). The AI never sets the numbers; if it is slow/unavailable the
// widget falls back to a templated comment after a few seconds, so the
// result screen always works. Lead → contact_submissions (source
// 'blog-kalkulator') with the whole brief + estimate in the message.
import { estimate, fmtPln, type Brief, type EstimatorConfig, type Estimate } from './estimate-model';
import { t, getLocale, onLocaleChange } from './i18n';
import { SUPABASE_URL, SUPABASE_ANON_KEY, restInsert } from './supabase';
import { openReceipt, makeRef } from './shell';

const AI_TIMEOUT_MS = 12000;
const MIN_LOADING_MS = 2600;

export function setupEstimators() {
  document.querySelectorAll<HTMLElement>('[data-estimator]').forEach(mount);
}

function mount(root: HTMLElement) {
  const cfg = JSON.parse(root.dataset.config || '{}') as EstimatorConfig;
  const form = root.querySelector<HTMLFormElement>('.est-form')!;
  const steps = [...root.querySelectorAll<HTMLFieldSetElement>('.est-step')];
  const back = root.querySelector<HTMLButtonElement>('[data-est-back]')!;
  const next = root.querySelector<HTMLButtonElement>('[data-est-next]')!;
  const nextLabel = root.querySelector<HTMLElement>('[data-est-next-label]')!;
  const bar = root.querySelector<HTMLElement>('.est-bar')!;
  const loading = root.querySelector<HTMLElement>('.est-loading')!;
  const result = root.querySelector<HTMLElement>('.est-result')!;
  const aiEl = root.querySelector<HTMLElement>('[data-est-ai]')!;
  let step = 0;
  let last: { brief: Brief; est: Estimate; ai: string } | null = null;
  let typing = 0;

  const brief = (): Brief => {
    const fd = new FormData(form);
    return {
      type: String(fd.get('type') || 'site'),
      pages: String(fd.get('pages') || 'p1'),
      features: fd.getAll('features').map(String),
      content: String(fd.get('content') || 'ready'),
      start: String(fd.get('start') || 'month'),
    };
  };
  const answered = (i: number) => steps[i].dataset.multi === '1' || !!steps[i].querySelector('input:checked');

  const show = (i: number) => {
    step = i;
    steps.forEach((s, j) => { s.hidden = j !== i; s.classList.toggle('is-in', j === i); });
    back.hidden = i === 0;
    const last = i === steps.length - 1;
    next.hidden = !(steps[i].dataset.multi === '1' || (answered(i) && last));
    nextLabel.dataset.i18n = last ? 'est.calc' : 'est.next';
    nextLabel.textContent = t(nextLabel.dataset.i18n);
    bar.style.transform = `scaleX(${(i + (answered(i) ? 1 : 0)) / steps.length})`;
  };

  // Single choice → auto-advance (feels like a conversation, not a form).
  form.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.type === 'radio') {
      if (step < steps.length - 1) setTimeout(() => show(step + 1), 220);
      else show(step);
    } else show(step);
  });
  next.addEventListener('click', () => (step < steps.length - 1 ? show(step + 1) : calculate()));
  back.addEventListener('click', () => show(Math.max(0, step - 1)));
  root.querySelector('[data-est-again]')?.addEventListener('click', () => {
    result.hidden = true; form.hidden = false; root.classList.remove('is-done');
    show(0);
    root.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  async function calculate() {
    const b = brief();
    const est = estimate(cfg, b);
    form.hidden = true; result.hidden = true; loading.hidden = false;
    root.classList.add('is-loading');
    bar.style.transform = 'scaleX(1)';
    const items = [...loading.querySelectorAll('li')];
    items.forEach((li) => li.classList.remove('is-done', 'is-now'));
    const timers = items.map((li, i) => window.setTimeout(() => {
      items[i - 1]?.classList.replace('is-now', 'is-done');
      li.classList.add('is-now');
    }, i * 850));
    const started = Date.now();
    const ai = await aiComment(b, est, root.dataset.topic || '');
    await new Promise((r) => setTimeout(r, Math.max(0, MIN_LOADING_MS - (Date.now() - started))));
    timers.forEach(clearTimeout);
    last = { brief: b, est, ai };
    loading.hidden = true; root.classList.remove('is-loading'); root.classList.add('is-done');
    renderResult();
    result.hidden = false;
    result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderResult() {
    if (!last) return;
    const { est } = last;
    const loc = getLocale();
    const cur = loc === 'pl' ? 'zł' : 'PLN';
    root.querySelector('[data-est-price]')!.textContent = `${fmtPln(est.lo, loc)}–${fmtPln(est.hi, loc)} ${cur}`;
    root.querySelector('[data-est-weeks]')!.textContent = `${est.wlo}–${est.whi} ${t('est.r.weeks')}`;
    const pre: Record<string, string> = { type: 'est.type.', pages: 'est.page.', feature: 'est.feat.', content: 'est.content.' };
    root.querySelector('[data-est-lines]')!.innerHTML = est.lines.map((l) => {
      const label = (l.group === 'pages' ? t('est.q2.short') + ': ' : '') + t(pre[l.group] + l.id);
      const amount = l.included ? t('est.r.incl') : `${l.group === 'type' ? '' : '+'}${fmtPln(l.amount, loc)} ${cur}`;
      return `<li><span>${esc(label)}</span><b>${esc(amount)}</b></li>`;
    }).join('');
    typeText(last.ai || fallbackComment(last.brief, est));
  }

  function typeText(text: string) {
    window.clearInterval(typing);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { aiEl.textContent = text; return; }
    aiEl.textContent = '';
    aiEl.classList.add('is-typing');
    let i = 0;
    typing = window.setInterval(() => {
      i = Math.min(text.length, i + 3);
      aiEl.textContent = text.slice(0, i);
      if (i >= text.length) { window.clearInterval(typing); aiEl.classList.remove('is-typing'); }
    }, 16);
  }

  // The AI text is written in the locale active at calculation time; on a
  // language switch the numbers re-render and the comment falls back to the
  // template in the new language (no second paid call).
  onLocaleChange(() => { if (last) { last.ai = ''; renderResult(); } show(step); });

  root.querySelector<HTMLFormElement>('.est-lead')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget as HTMLFormElement;
    const fd = new FormData(f);
    const status = f.querySelector<HTMLElement>('.est-status')!;
    if (String(fd.get('website_url') || '')) return;
    const name = String(fd.get('name') || '').trim();
    const email = String(fd.get('email') || '').trim();
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !last) { status.textContent = t('contact.required'); return; }
    const btn = f.querySelector<HTMLButtonElement>('button[type=submit]')!;
    btn.disabled = true; status.textContent = '';
    const { brief: b, est } = last;
    const lines = [
      `KALKULATOR (${location.pathname})`,
      `Typ: ${t('est.type.' + b.type)} · ${t('est.q2.short')}: ${t('est.page.' + b.pages)}`,
      `Funkcje: ${b.features.map((x) => t('est.feat.' + x)).join(', ') || '—'}`,
      `Treści: ${t('est.content.' + b.content)} · Start: ${t('est.start.' + b.start)}`,
      `Wycena: ${est.lo}–${est.hi} zł netto · ${est.wlo}–${est.whi} tyg.`,
      String(fd.get('note') || '').trim() ? `Uwagi: ${String(fd.get('note')).trim()}` : '',
      last.ai ? `AI: ${last.ai}` : '',
    ].filter(Boolean);
    const ref = makeRef();
    const receipt = openReceipt();
    const { error } = await restInsert('contact_submissions', {
      name, email, ref,
      message: lines.join('\n').slice(0, 4000),
      source: root.dataset.source || 'blog-kalkulator',
      service: b.type,
      budget: `${est.lo}–${est.hi} zł`,
      page: location.pathname.slice(0, 200),
      locale: getLocale(),
    });
    btn.disabled = false;
    if (error) { receipt.fail(); status.textContent = t('contact.error'); return; }
    // Outbound lead page: tell the owner right away (e-mail via edge `leads`).
    if (root.dataset.leadToken) {
      fetch(`${SUPABASE_URL}/functions/v1/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ action: 'brief', token: root.dataset.leadToken, name, email, summary: lines.join('\n') }),
      }).catch(() => {});
    }
    receipt.print({ ref, name, email, message: lines.slice(1, 5).join(' · ') }, () => {
      f.reset();
      status.textContent = t('est.f.ok');
      f.classList.add('is-sent');
    });
  });

  // Personal offer page (/oferta/) presets the project type + features for the
  // lead and jumps to the next unanswered step.
  root.addEventListener('est:preset', (e) => {
    const { type, features } = (e as CustomEvent).detail || {};
    const t = form.querySelector<HTMLInputElement>(`input[name="type"][value="${type}"]`);
    if (t) t.checked = true;
    for (const f of features || []) { const c = form.querySelector<HTMLInputElement>(`input[name="features"][value="${f}"]`); if (c) c.checked = true; }
    show(t ? 1 : 0);
  });

  show(0);
}

async function aiComment(b: Brief, est: Estimate, topic: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/estimate`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ locale: getLocale(), brief: b, estimate: est, topic, page: location.pathname }),
    });
    if (!r.ok) return '';
    const j = await r.json();
    return typeof j.text === 'string' ? j.text.trim() : '';
  } catch {
    return '';
  } finally {
    window.clearTimeout(timer);
  }
}

// Template comment (no AI): still specific to the brief.
function fallbackComment(b: Brief, est: Estimate): string {
  const heavy = b.features.filter((f) => ['integrations', 'accounts', 'payments'].includes(f)).length;
  const k = heavy >= 2 ? 'est.fb.heavy' : b.type === 'landing' ? 'est.fb.landing' : b.type === 'shop' ? 'est.fb.shop' : b.type === 'platform' ? 'est.fb.platform' : 'est.fb.site';
  const tail = b.content === 'help' ? ' ' + t('est.fb.content') : '';
  return t(k).replace('{w}', `${est.wlo}–${est.whi}`) + tail;
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
