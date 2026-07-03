// Minimal client chrome for non-graph pages (blog): theme toggle, language
// switcher, localized content swap and the morphing topbar. The full graph
// engine stays home-page-only.
import { getTheme, toggleTheme, onThemeChange } from './theme';
import { LOCALES, getLocale, setLocale, onLocaleChange, applyDom, type Locale } from './i18n';

export function mountShell() {
  applyDom();
  bindTheme();
  bindLangSwitcher();
  applyBlogLocale();
  setupTopbarMorph();
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
