// Minimal client chrome for non-graph pages (blog): theme toggle, language
// switcher, localized content swap and the morphing topbar. The full graph
// engine stays home-page-only.
import { getTheme, toggleTheme, onThemeChange } from './theme';
import { LOCALES, getLocale, setLocale, onLocaleChange, applyDom, type Locale } from './i18n';
import { restInsert } from './supabase';

export function mountShell() {
  applyDom();
  bindTheme();
  bindLangSwitcher();
  applyBlogLocale();
  setupTopbarMorph();
  setupBurger();
  setupSmoothScroll();
  trackPageView();
}

// Phone/tablet burger: collapses .nav into a dropdown under the topbar.
// Pure class toggle (.topbar.menu-open) — layout and breakpoint live in CSS.
export function setupBurger() {
  const btn = document.getElementById('nav-burger');
  const topbar = document.querySelector<HTMLElement>('.topbar');
  if (!btn || !topbar) return;
  const close = () => {
    topbar.classList.remove('menu-open');
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = topbar.classList.toggle('menu-open');
    btn.setAttribute('aria-expanded', String(open));
  });
  // Tap outside, pick a menu item, or Escape — all close the menu.
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (topbar.classList.contains('menu-open') && !t.closest('.nav') && !t.closest('#nav-burger')) close();
  });
  topbar.querySelector('.nav')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a, button')) close();
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// First-party, cookie-less analytics: one anonymous row per page view.
// is_session marks the first view in this browser session ("a visit").
// No cookies, no fingerprinting, no external scripts — consistent with the
// site's cookie policy. Bots running WebDriver are skipped.
export function trackPageView() {
  try {
    if ((navigator as any).webdriver) return;
    const path = (location.pathname.replace(/\/+$/, '') || '/').slice(0, 200);
    let isSession = false;
    try {
      if (!sessionStorage.getItem('bf:sess')) {
        sessionStorage.setItem('bf:sess', '1');
        isSession = true;
      }
    } catch {}
    const ref = document.referrer && !document.referrer.includes(location.host)
      ? document.referrer.slice(0, 300)
      : null;
    void restInsert('page_views', {
      path,
      referrer: ref,
      locale: document.documentElement.lang || 'pl',
      is_session: isSession,
      is_mobile: window.matchMedia('(max-width: 760px)').matches,
    });
  } catch {}
}

// Inertial wheel scrolling — mouse-wheel steps get eased into a smooth glide
// (Lenis-style, but ~30 lines). Native behavior is kept for touch devices,
// reduced-motion users, inner scrollers (modal, editors) and Ctrl/Cmd+wheel
// (browser zoom + graph zoom).
export function setupSmoothScroll() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) return;

  let target = window.scrollY;
  let current = window.scrollY;
  let raf = 0;

  const maxScroll = () =>
    Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

  const loop = () => {
    current += (target - current) * 0.16;
    if (Math.abs(target - current) < 0.6) {
      current = target;
      window.scrollTo({ top: current, behavior: 'instant' as ScrollBehavior });
      raf = 0;
      return;
    }
    window.scrollTo({ top: current, behavior: 'instant' as ScrollBehavior });
    raf = requestAnimationFrame(loop);
  };

  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) return; // zoom gestures stay native
      const t = e.target as HTMLElement;
      if (t.closest?.('.modal-scroll, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * window.innerHeight : e.deltaY;
      if (!raf) { target = current = window.scrollY; }
      target = Math.max(0, Math.min(maxScroll(), target + dy));
      if (!raf) raf = requestAnimationFrame(loop);
    },
    { passive: false },
  );

  // Keyboard / scrollbar / anchor jumps: resync so the next wheel starts fresh.
  window.addEventListener(
    'scroll',
    () => { if (!raf) { target = current = window.scrollY; } },
    { passive: true },
  );
}

// Topbar morph: squared matte bar glued to the top → floating rounded pill
// once the page scrolls. Pure class toggle; the animation lives in CSS.
export function setupTopbarMorph() {
  let ticking = false;
  const apply = () => {
    document.body.classList.toggle('is-scrolled', window.scrollY > 40);
    ticking = false;
  };
  window.addEventListener(
    'scroll',
    () => {
      if (!ticking) { ticking = true; requestAnimationFrame(apply); }
    },
    { passive: true },
  );
  apply();
}

function bindTheme() {
  const btn = document.getElementById('theme-toggle');
  const icon = document.getElementById('theme-icon');
  if (!btn || !icon) return;
  const moon = `<path d="M14.5 11.5a5.5 5.5 0 0 1-7-7 5.5 5.5 0 1 0 7 7Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  const sun = `<circle cx="10" cy="10" r="3.4" stroke="currentColor" stroke-width="1.4"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M10 2.5v2"/><path d="M10 15.5v2"/><path d="M2.5 10h2"/><path d="M15.5 10h2"/><path d="M4.7 4.7l1.4 1.4"/><path d="M13.9 13.9l1.4 1.4"/><path d="M4.7 15.3l1.4-1.4"/><path d="M13.9 6.1l1.4-1.4"/></g>`;
  const paint = () => { icon.innerHTML = getTheme() === 'light' ? moon : sun; };
  paint();
  btn.addEventListener('click', toggleTheme);
  onThemeChange(paint);
}

function bindLangSwitcher() {
  const wrap = document.querySelector<HTMLElement>('.lang');
  if (!wrap) return;
  wrap.innerHTML = LOCALES.map((l) => `<button type="button" data-locale="${l}">${l}</button>`).join('');
  const updateActive = () => {
    wrap.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.locale === getLocale());
    });
  };
  wrap.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-locale]');
    if (b) setLocale(b.dataset.locale as Locale);
  });
  onLocaleChange(() => {
    updateActive();
    applyDom();
    applyBlogLocale();
  });
  updateActive();
}

// Blog content is statically rendered in PL (that's what Google indexes).
// EN/RU variants are embedded in the page (data-lm-* attributes + hidden
// .post-body[data-locale] blocks) and swapped client-side.
function applyBlogLocale() {
  const loc = getLocale();
  const key = ('lm' + loc[0].toUpperCase() + loc.slice(1)) as 'lmPl' | 'lmEn' | 'lmRu';

  document.querySelectorAll<HTMLElement>('[data-lm-pl]').forEach((el) => {
    const v = el.dataset[key] || el.dataset.lmPl;
    if (v) el.textContent = v;
  });

  const bodies = document.querySelectorAll<HTMLElement>('.post-body[data-locale]');
  if (bodies.length) {
    const has = [...bodies].some((el) => el.dataset.locale === loc && el.innerHTML.trim());
    const show = has ? loc : 'pl';
    bodies.forEach((el) => { el.hidden = el.dataset.locale !== show; });
  }
}
