// Client chrome shared by every public page: language switcher + localized
// content swap, sticky header, burger menu, scroll reveal, counters, FAQ
// accordions, the contact form, cookie notice and first-party page views.
// No framework — a few hundred lines of vanilla TS bundled by Astro.
import { LOCALES, getLocale, setLocale, onLocaleChange, applyDom, t, type Locale } from './i18n';
import { restInsert } from './supabase';

export function mountShell() {
  applyDom();
  bindLangSwitcher();
  setupStickyHeader();
  setupBurger();
  setupReveal();
  setupCounters();
  setupFaq();
  setupProjectFilter();
  bindContactForms();
  setupCookieNotice();
  setupScrollTop();
  setupMascot();
  setupTabAway();
  trackPageView();
}

// ── language ────────────────────────────────────────────────────────────────
function bindLangSwitcher() {
  const wraps = document.querySelectorAll<HTMLElement>('.lang-switch');
  if (!wraps.length) return;
  const paint = () => {
    wraps.forEach((wrap) => {
      wrap.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.locale === getLocale());
        b.setAttribute('aria-pressed', String(b.dataset.locale === getLocale()));
      });
    });
  };
  wraps.forEach((wrap) => {
    wrap.innerHTML = LOCALES.map((l) => `<button type="button" data-locale="${l}">${l.toUpperCase()}</button>`).join('');
    wrap.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-locale]');
      if (b) setLocale(b.dataset.locale as Locale);
    });
  });
  onLocaleChange(() => { paint(); applyDom(); });
  paint();
}

// ── header ──────────────────────────────────────────────────────────────────
function setupStickyHeader() {
  const header = document.querySelector<HTMLElement>('.site-header');
  if (!header) return;
  let ticking = false;
  const apply = () => {
    header.classList.toggle('is-stuck', window.scrollY > 24);
    ticking = false;
  };
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(apply); } }, { passive: true });
  apply();
}

export function setupBurger() {
  const btn = document.getElementById('nav-burger');
  const header = document.querySelector<HTMLElement>('.site-header');
  if (!btn || !header) return;
  const close = () => { header.classList.remove('menu-open'); btn.setAttribute('aria-expanded', 'false'); document.body.classList.remove('nav-locked'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = header.classList.toggle('menu-open');
    btn.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('nav-locked', open);
  });
  document.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (header.classList.contains('menu-open') && !el.closest('.site-nav') && !el.closest('#nav-burger')) close();
  });
  header.querySelector('.site-nav')?.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('a')) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// ── reveal on scroll ────────────────────────────────────────────────────────
function setupReveal() {
  const els = document.querySelectorAll<HTMLElement>('[data-reveal]');
  if (!els.length) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('is-in'));
    return;
  }
  document.documentElement.classList.add('js-reveal');
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      const el = en.target as HTMLElement;
      const delay = Number(el.dataset.revealDelay || 0);
      setTimeout(() => el.classList.add('is-in'), delay);
      io.unobserve(el);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  els.forEach((el) => io.observe(el));
}

// ── counters (stats) ────────────────────────────────────────────────────────
function setupCounters() {
  const els = document.querySelectorAll<HTMLElement>('[data-count]');
  if (!els.length) return;
  const run = (el: HTMLElement) => {
    const target = parseFloat(el.dataset.count || '0');
    const suffix = el.dataset.suffix || '';
    const decimals = (el.dataset.count || '').includes('.') ? 1 : 0;
    const start = performance.now(), dur = 1400;
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = (target * e).toFixed(decimals) + suffix;
      if (k < 1) requestAnimationFrame(step); else el.textContent = el.dataset.final || (target.toFixed(decimals) + suffix);
    };
    requestAnimationFrame(step);
  };
  if (!('IntersectionObserver' in window)) { els.forEach((el) => { el.textContent = el.dataset.final || el.textContent; }); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { run(en.target as HTMLElement); io.unobserve(en.target); } });
  }, { threshold: 0.4 });
  els.forEach((el) => io.observe(el));
}

// ── FAQ: one open at a time (native <details>) ──────────────────────────────
function setupFaq() {
  document.querySelectorAll<HTMLElement>('.faq-list').forEach((list) => {
    list.addEventListener('toggle', (e) => {
      const d = e.target as HTMLDetailsElement;
      if (!d.open) return;
      list.querySelectorAll<HTMLDetailsElement>('details[open]').forEach((o) => { if (o !== d) o.open = false; });
    }, true);
  });
}

// ── project filter chips (/projekty/) ───────────────────────────────────────
function setupProjectFilter() {
  const bar = document.querySelector<HTMLElement>('.filter-bar');
  const grid = document.querySelector<HTMLElement>('.projects-grid');
  if (!bar || !grid) return;
  bar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-filter]');
    if (!btn) return;
    const f = btn.dataset.filter || 'all';
    bar.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b === btn));
    grid.querySelectorAll<HTMLElement>('[data-services]').forEach((card) => {
      const list = (card.dataset.services || '').split(' ').filter(Boolean);
      card.hidden = f !== 'all' && !list.includes(f);
    });
  });
}

// ── contact forms → contact_submissions, then the "receipt" ─────────────────
// Choreography (mirrors the HawkFix receipt, in BF style): the overlay with
// the printer rises the moment the user submits ("Rejestruję zapytanie…"),
// the paper prints once the row is stored, holds so it can be read, flies up,
// and the form is replaced by a sequential success state. Esc / click skip.
const PRINT_MS = 1700, HOLD_MS = 2300, FLY_MS = 900;

function makeRef(): string {
  const t = Date.now().toString(36).toUpperCase().slice(-5);
  const r = Math.floor(Math.random() * 36).toString(36).toUpperCase();
  return `BF-${t}${r}`;
}
function barsFor(seed: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < 44; i++) out.push(1 + ((seed.charCodeAt(i % seed.length) + i * 7) % 4));
  return out;
}
const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function openReceipt() {
  const el = document.createElement('div');
  el.className = 'rcp';
  el.dataset.phase = 'wait';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `<div class="rcp-stage">
    <div class="rcp-printer" aria-hidden="true"><span class="brand">barabashflow</span><span class="rcp-led"></span><span class="rcp-slot"></span></div>
    <div class="rcp-paperwrap"><div class="rcp-paper"><div class="rcp-inner is-wait"><div class="rcp-brand">BF</div><div class="rcp-sub">${esc(t('receipt.wait'))}</div></div></div></div>
    <div class="rcp-skip">${esc(t('receipt.skip'))}</div>
  </div>`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => el.classList.add('is-open'));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let finished = false;
  let onFinish: (() => void) | null = null;
  const timers: number[] = [];
  const finish = () => {
    if (finished) return; finished = true;
    timers.forEach(clearTimeout);
    el.classList.remove('is-open');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    setTimeout(() => el.remove(), 350);
    onFinish?.();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && el.dataset.phase !== 'wait') finish(); };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', () => { if (el.dataset.phase !== 'wait') finish(); });
  return {
    print(data: { ref: string; name: string; email: string; message: string }, done: () => void) {
      onFinish = done;
      const date = new Date().toLocaleString(document.documentElement.lang || 'pl', { dateStyle: 'medium', timeStyle: 'short' });
      el.querySelector('.rcp-paper')!.innerHTML = `<div class="rcp-inner">
        <div class="rcp-brand">barabashflow</div>
        <div class="rcp-thanks">${esc(t('receipt.thanks'))}</div>
        <div class="rcp-sub">${esc(t('receipt.sub'))}</div>
        <div class="rcp-tear" aria-hidden="true"></div>
        <dl class="rcp-rows">
          <div><dt>${esc(t('receipt.no'))}</dt><dd>${esc(data.ref)}</dd></div>
          <div><dt>${esc(t('receipt.date'))}</dt><dd>${esc(date)}</dd></div>
          <div><dt>${esc(t('receipt.from'))}</dt><dd>${esc(data.name)}<br><small>${esc(data.email)}</small></dd></div>
          <div><dt>${esc(t('receipt.status'))}</dt><dd><span class="rcp-badge">${esc(t('receipt.status.v'))}</span></dd></div>
        </dl>
        <div class="rcp-msg">${esc(data.message.slice(0, 140))}${data.message.length > 140 ? '…' : ''}</div>
        <div class="rcp-code" aria-hidden="true">${barsFor(data.ref).map((w) => `<span style="width:${w}px"></span>`).join('')}</div>
        <div class="rcp-codeno" aria-hidden="true">${esc(data.ref)}</div>
      </div>`;
      // Paper must start collapsed for the 0fr → 1fr transition to run.
      requestAnimationFrame(() => {
        el.dataset.phase = 'print';
        if (reduced) { timers.push(window.setTimeout(finish, 2200)); return; }
        timers.push(window.setTimeout(() => { el.dataset.phase = 'hold'; }, PRINT_MS));
        timers.push(window.setTimeout(() => { el.dataset.phase = 'fly'; }, PRINT_MS + HOLD_MS));
        timers.push(window.setTimeout(finish, PRINT_MS + HOLD_MS + FLY_MS));
      });
    },
    fail() { finished = true; el.classList.remove('is-open'); document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); setTimeout(() => el.remove(), 350); },
  };
}

function showSuccess(wrap: HTMLElement, form: HTMLFormElement, ref: string) {
  const box = wrap.querySelector<HTMLElement>('.form-success');
  if (!box) return;
  box.querySelectorAll<HTMLElement>('[data-success-ref]').forEach((b) => { b.textContent = ref; });
  form.hidden = true;
  box.hidden = false;
  const steps = box.querySelectorAll<HTMLElement>('.fs-steps li');
  steps.forEach((li, i) => li.classList.toggle('is-done', i === 0));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    box.classList.add('is-in');
    // step 2 lights up as "in progress" after the list has revealed
    setTimeout(() => steps[1]?.classList.add('is-now'), 2200);
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }));
  box.querySelector('[data-success-again]')?.addEventListener('click', () => {
    box.classList.remove('is-in'); box.hidden = true;
    steps.forEach((li) => li.classList.remove('is-now'));
    form.hidden = false; form.classList.remove('is-sent');
    form.querySelector<HTMLInputElement>('input[name=name]')?.focus();
  }, { once: true });
}

export function bindContactForms() {
  document.querySelectorAll<HTMLFormElement>('form[data-contact-form]').forEach((form) => {
    const wrap = form.closest<HTMLElement>('.contact-form-wrap') || form.parentElement!;
    const status = form.querySelector<HTMLElement>('.form-status');
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    let busy = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const fd = new FormData(form);
      const get = (k: string) => String(fd.get(k) || '').trim();
      const name = get('name'), email = get('email'), message = get('message');
      if (get('website_url')) { form.reset(); return; } // honeypot
      if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !message) { if (status) status.textContent = t('contact.required'); return; }
      busy = true;
      if (submit) submit.disabled = true;
      if (status) status.textContent = '';
      const ref = makeRef();
      const receipt = openReceipt();
      const started = Date.now();
      const { error } = await restInsert('contact_submissions', {
        name, email, message, ref,
        source: form.dataset.contactForm || 'website',
        page: location.pathname.slice(0, 200),
        locale: getLocale(),
      });
      busy = false;
      if (submit) submit.disabled = false;
      if (error) {
        receipt.fail();
        if (status) status.textContent = t('contact.error');
        return;
      }
      // Let the printer "warm up" for at least a beat so the wait state reads.
      const wait = Math.max(0, 700 - (Date.now() - started));
      setTimeout(() => {
        receipt.print({ ref, name, email, message }, () => {
          form.reset();
          form.classList.add('is-sent');
          showSuccess(wrap, form, ref);
        });
      }, wait);
    });
  });
}

// ── mascot bot ──────────────────────────────────────────────────────────────
// Floating helper bottom-left: opens by itself after MASCOT_DELAY (once per
// session), types the greeting, takes a question + e-mail → contact_submissions
// (source 'mascot-bot'), shows an in-card success with a BF-ref. Closing
// leaves a small avatar button to reopen it.
const MASCOT_DELAY = 45_000;
function typewrite(el: HTMLElement, text: string, speed = 22, done?: () => void) {
  el.classList.add('is-typing');
  el.textContent = '';
  let i = 0;
  const tick = () => {
    el.textContent = text.slice(0, ++i);
    if (i < text.length) setTimeout(tick, speed); else { el.classList.remove('is-typing'); el.classList.add('is-done'); done?.(); }
  };
  tick();
}
function setupMascot() {
  const root = document.getElementById('mascot');
  if (!root) return;
  const KEY = 'bf:mascot-dismissed';
  const card = root.querySelector<HTMLElement>('.mascot-card')!;
  const bubble = root.querySelector<HTMLElement>('[data-typewrite]')!;
  const form = root.querySelector<HTMLFormElement>('[data-mascot-form]')!;
  const status = form.querySelector<HTMLElement>('.form-status');
  const stageAsk = root.querySelector<HTMLElement>('[data-stage="ask"]')!;
  const stageDone = root.querySelector<HTMLElement>('[data-stage="done"]')!;
  let typed = false;
  root.hidden = false;
  const greeting = () => bubble.getAttribute(`data-lm-${getLocale()}`) || bubble.getAttribute('data-lm-pl') || bubble.textContent || '';
  const open = () => {
    root.classList.add('is-open');
    requestAnimationFrame(() => card.classList.add('is-in'));
    if (!typed) { typed = true; typewrite(bubble, greeting(), 20); }
  };
  const close = (remember = true) => {
    card.classList.remove('is-in');
    setTimeout(() => root.classList.remove('is-open'), 300);
    if (remember) { try { sessionStorage.setItem(KEY, '1'); } catch {} }
  };
  root.querySelector('[data-mascot-open]')?.addEventListener('click', () => { if (root.classList.contains('is-open')) close(); else open(); });
  root.querySelector('[data-mascot-close]')?.addEventListener('click', () => close());
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root.classList.contains('is-open')) close(); });
  onLocaleChange(() => { if (typed && !bubble.classList.contains('is-typing')) bubble.textContent = greeting(); });
  let dismissed = false;
  try { dismissed = sessionStorage.getItem(KEY) === '1'; } catch {}
  if (!dismissed && !(navigator as any).webdriver) setTimeout(() => { if (!root.classList.contains('is-open') && !document.querySelector('.rcp')) open(); }, MASCOT_DELAY);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const message = String(fd.get('message') || '').trim(), email = String(fd.get('email') || '').trim();
    if (String(fd.get('website_url') || '')) return;
    if (!message || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { if (status) status.textContent = t('contact.required'); return; }
    const btn = form.querySelector<HTMLButtonElement>('button[type=submit]'); if (btn) btn.disabled = true;
    if (status) status.textContent = t('contact.sending');
    const ref = makeRef();
    const { error } = await restInsert('contact_submissions', { name: email.split('@')[0], email, message, ref, source: 'mascot-bot', page: location.pathname.slice(0, 200), locale: getLocale() });
    if (btn) btn.disabled = false;
    if (error) { if (status) status.textContent = t('contact.error'); return; }
    stageAsk.hidden = true; stageDone.hidden = false;
    stageDone.querySelector<HTMLElement>('[data-mascot-ref]')!.textContent = ref;
    requestAnimationFrame(() => requestAnimationFrame(() => stageDone.classList.add('is-in')));
    try { sessionStorage.setItem(KEY, '1'); } catch {}
  });
}

// ── tab-away title ──────────────────────────────────────────────────────────
// When the visitor switches tabs the title cycles through short on-brand
// lines (localized); the original title comes back on return.
function setupTabAway() {
  const original = document.title;
  let last = -1, cycler = 0;
  const pick = () => {
    let i; do { i = 1 + Math.floor(Math.random() * 5); } while (i === last);
    last = i; return t(`away.${i}`);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      document.title = pick();
      clearInterval(cycler);
      cycler = window.setInterval(() => { document.title = pick(); }, 6000);
    } else { clearInterval(cycler); cycler = 0; document.title = original; }
  });
}

// ── cookie / privacy notice (localStorage only) ─────────────────────────────
function setupCookieNotice() {
  const el = document.getElementById('cookie-notice');
  if (!el) return;
  const KEY = 'bf:cookies-accepted';
  try { if (localStorage.getItem(KEY) === '1') { el.remove(); return; } } catch {}
  setTimeout(() => el.classList.add('is-shown'), 1400);
  el.querySelector('[data-cookie-ok]')?.addEventListener('click', () => {
    try { localStorage.setItem(KEY, '1'); } catch {}
    el.classList.remove('is-shown');
    setTimeout(() => el.remove(), 400);
  });
}

function setupScrollTop() {
  document.querySelectorAll<HTMLElement>('[data-scroll-top]').forEach((b) => {
    b.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  });
}

// First-party, cookie-less analytics: one anonymous row per page view.
// is_session marks the first view in this browser session ("a visit").
export function trackPageView() {
  try {
    if ((navigator as any).webdriver) return;
    const path = (location.pathname.replace(/\/+$/, '') || '/').slice(0, 200);
    let isSession = false;
    try {
      if (!sessionStorage.getItem('bf:sess')) { sessionStorage.setItem('bf:sess', '1'); isSession = true; }
    } catch {}
    const ref = document.referrer && !document.referrer.includes(location.host) ? document.referrer.slice(0, 300) : null;
    void restInsert('page_views', {
      path, referrer: ref,
      locale: document.documentElement.lang || 'pl',
      is_session: isSession,
      is_mobile: window.matchMedia('(max-width: 760px)').matches,
    });
  } catch {}
}
