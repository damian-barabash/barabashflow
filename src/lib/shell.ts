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

// ── contact forms (home / contact page / footer) → contact_submissions ──────
export function bindContactForms() {
  document.querySelectorAll<HTMLFormElement>('form[data-contact-form]').forEach((form) => {
    const status = form.querySelector<HTMLElement>('.form-status');
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const get = (k: string) => String(fd.get(k) || '').trim();
      const name = get('name'), email = get('email'), message = get('message');
      // Honeypot: bots fill every field.
      if (get('website_url')) { form.reset(); return; }
      if (!name || !email || !message) { if (status) status.textContent = t('contact.required'); return; }
      if (submit) submit.disabled = true;
      if (status) status.textContent = t('contact.sending');
      const { error } = await restInsert('contact_submissions', {
        name, email, message,
        phone: get('phone') || null,
        company: get('company') || null,
        service: get('service') || null,
        budget: get('budget') || null,
        source: form.dataset.contactForm || 'website',
        page: location.pathname.slice(0, 200),
        locale: getLocale(),
      });
      if (submit) submit.disabled = false;
      if (error) { if (status) status.textContent = t('contact.error'); return; }
      form.reset();
      form.classList.add('is-sent');
      if (status) status.textContent = t('contact.success');
    });
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
