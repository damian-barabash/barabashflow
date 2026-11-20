// Admin motion + feedback layer (2026-11-20). One place that decides how every
// action in the panel looks while it runs, when it succeeds and when it fails:
//
//   banner(text, kind)   toast (pending → ok / error morph in place) and, for the
//                        button and card the action started from: spinner,
//                        check / cross on the button, lime sweep or red shake
//                        on the card. Modules keep calling banner() as before.
//   ask(msg)             async confirm dialog (replaces native confirm()).
//   swapList(box, html, sel)
//                        replaces a list's markup with FLIP: rows that stay
//                        glide to their new place, removed rows leave with an
//                        exit animation, new rows fade in.
//   markExit(el, kind)   how a row should leave on the next swapList
//                        ('send' flies away, 'skip' slides aside, default fades).
//   invalid(el)          red field + shake + focus for validation errors.
//
// No imports: admin-core re-exports everything from here.

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const SCOPES = '.lead, .msg, .blog-row, .kcard, .crm-tr, .faq-ed, .file-row, .mail-compose, .modal-card, .editor-pane, .settings-card';
const ICON = {
  pending: '<span class="toast-spin"></span>',
  ok: '<svg viewBox="0 0 20 20" fill="none"><path class="toast-draw" d="M4.5 10.5 8.5 14.5 15.5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/></svg>',
  error: '<svg viewBox="0 0 20 20" fill="none"><path class="toast-draw" d="M5.5 5.5 14.5 14.5M14.5 5.5 5.5 14.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" pathLength="1"/></svg>',
};

// ── Where did the action start? ─────────────────────────────────────────────
// Handlers are plain async functions, so the link between "user clicked this"
// and "banner('ok')" is kept here: the latest interaction, plus every action
// that announced itself as pending and has not finished yet.
let last = null;
const pending = [];

function locator(el) {
  if (!el) return null;
  const a = [...el.attributes].find((x) => x.name.startsWith('data-') && x.value && !x.name.startsWith('data-fx'));
  return a && el.classList[0] ? `.${el.classList[0]}[${a.name}="${CSS.escape(a.value)}"]` : null;
}
function note(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || t.closest('.ask-root, .toasts')) return;
  if (e.type === 'keydown' && e.key !== 'Enter') return;
  const b = t.closest('.btn, .icon-btn');
  const scope = t.closest(SCOPES);
  last = { btn: b, scope, find: locator(scope), at: performance.now(), state: 'idle', toast: null };
}
['click', 'change', 'drop', 'keydown'].forEach((ev) => document.addEventListener(ev, note, true));

const age = (c) => performance.now() - c.at;
function ctxFor(kind) {
  if (!kind) {
    if (last && (last.state === 'pending' || (last.state === 'idle' && age(last) < 5000))) return last;
    return pending[pending.length - 1] || (last = { btn: null, scope: null, find: null, at: performance.now(), state: 'idle', toast: null });
  }
  if (last && last.state === 'pending') return last;
  if (last && last.state === 'idle' && age(last) < 5000) return last;
  if (pending.length) return pending[0];
  if (last && last.state === 'idle' && age(last) < 30000) return last;
  return { btn: null, scope: null, find: null, state: 'idle', toast: null };
}
const scopeOf = (c) => (c.scope && c.scope.isConnected ? c.scope : (c.find && document.querySelector(c.find)) || null);

function pulse(el, cls, ms) {
  if (!el || !el.isConnected) return;
  el.classList.remove('fx-ok', 'fx-err', 'fx-done', 'fx-fail');
  void el.offsetWidth; // restart the animation when the same state repeats
  el.classList.add(cls);
  clearTimeout(el._fxT);
  el._fxT = setTimeout(() => el.classList.remove(cls), ms);
}
function shake(el) {
  if (reduce || !el || !el.isConnected) return;
  el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }], { duration: 420, easing: 'ease-out' });
}

// ── Toasts ──────────────────────────────────────────────────────────────────
function host() {
  let el = document.querySelector('.toasts');
  if (!el) { el = document.createElement('div'); el.className = 'toasts'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
  return el;
}
function dismiss(t) {
  if (!t || t._gone) return;
  t._gone = true; clearTimeout(t._timer);
  t.classList.add('is-leaving');
  setTimeout(() => t.remove(), reduce ? 0 : 320);
}
function toast(t, text, kind) {
  const box = host();
  if (!t || t._gone || !t.isConnected) {
    t = document.createElement('div');
    t.innerHTML = '<span class="toast-ico"></span><span class="toast-text"></span><button type="button" class="toast-x" aria-label="Zamknij">×</button><span class="toast-bar"></span>';
    t.querySelector('.toast-x').addEventListener('click', () => dismiss(t));
    box.appendChild(t);
    const live = [...box.children].filter((x) => !x._gone);
    live.slice(0, Math.max(0, live.length - 4)).forEach(dismiss);
  }
  const morph = t._kind && t._kind !== kind;
  t._kind = kind;
  t.className = `toast is-${kind}${morph ? ' is-morph' : ''}`;
  t.querySelector('.toast-ico').innerHTML = ICON[kind];
  t.querySelector('.toast-text').textContent = text;
  clearTimeout(t._timer);
  if (kind !== 'pending') {
    const ms = kind === 'error' ? 7000 : 2800;
    t.style.setProperty('--toast-ms', `${ms}ms`);
    const bar = t.querySelector('.toast-bar'); bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = '';
    t._timer = setTimeout(() => dismiss(t), ms);
    t.onmouseenter = () => { clearTimeout(t._timer); t.classList.add('is-held'); };
    t.onmouseleave = () => { t.classList.remove('is-held'); t._timer = setTimeout(() => dismiss(t), 1800); };
    if (kind === 'error') { t.setAttribute('role', 'alert'); shake(t); }
  }
  return t;
}

export function banner(text, kind) {
  const c = ctxFor(kind);
  if (!kind) {
    c.state = 'pending';
    if (!pending.includes(c)) pending.push(c);
    if (c.btn && c.btn.isConnected) c.btn.classList.add('fx-busy');
    c.toast = toast(c.toast, text, 'pending');
    clearTimeout(c.guard);
    c.guard = setTimeout(() => { if (c.state === 'pending') banner('Brak odpowiedzi — sprawdź połączenie i spróbuj ponownie', 'error'); }, 240000);
    return;
  }
  const error = kind === 'error';
  c.state = 'done'; clearTimeout(c.guard);
  const i = pending.indexOf(c); if (i >= 0) pending.splice(i, 1);
  c.toast = toast(c.toast, text, error ? 'error' : 'ok');
  if (c.btn) {
    c.btn.classList.remove('fx-busy');
    pulse(c.btn, error ? 'fx-fail' : 'fx-done', error ? 1500 : 1000);
    if (error) shake(c.btn);
  }
  const scope = scopeOf(c);
  if (scope) { pulse(scope, error ? 'fx-err' : 'fx-ok', error ? 2600 : 1100); if (error && !scope.matches('.settings-card, .editor-pane')) shake(scope); }
}

// ── Field validation ────────────────────────────────────────────────────────
export function invalid(el) {
  if (!el) return;
  const box = el.closest('.field-input') || el;
  box.classList.add('fx-invalid'); shake(box);
  el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  el.focus?.({ preventScroll: true });
  const clear = () => { box.classList.remove('fx-invalid'); el.removeEventListener('input', clear); el.removeEventListener('change', clear); };
  el.addEventListener('input', clear); el.addEventListener('change', clear);
}

// ── Confirm dialog ──────────────────────────────────────────────────────────
// First line = question, the rest = details. The confirm button takes its
// label and tone from the question (Usuń → red) unless given explicitly.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
export function ask(msg, opts = {}) {
  const [title, ...rest] = String(msg).split('\n').filter((l) => l.trim());
  const danger = opts.danger ?? /^usun/i.test(title);
  const ok = opts.ok || (danger ? 'Usuń' : /^wys[lł]a/i.test(title) ? 'Wyślij' : /^opublik/i.test(title) ? 'Opublikuj' : /^przet[lł]umacz/i.test(title) ? 'Przetłumacz' : /^przywr/i.test(title) ? 'Przywróć' : 'Potwierdź');
  const origin = last;
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'modal-root ask-root';
    root.innerHTML = `<div class="modal-backdrop"></div>
      <div class="modal-card ask-card${danger ? ' is-danger' : ''}" role="alertdialog" aria-modal="true">
        <span class="ask-mark">${danger ? '!' : '?'}</span>
        <h3 class="ask-title">${esc(title)}</h3>
        ${rest.length ? `<p class="ask-text">${rest.map(esc).join('<br>')}</p>` : ''}
        <div class="ask-actions"><button type="button" class="btn" data-ask="0">${esc(opts.cancel || 'Anuluj')}</button><button type="button" class="btn ${danger ? 'danger-solid' : 'primary'}" data-ask="1">${esc(ok)}</button></div>
      </div>`;
    document.body.appendChild(root);
    requestAnimationFrame(() => root.classList.add('is-open'));
    const prevFocus = document.activeElement;
    root.querySelector('[data-ask="1"]').focus();
    const done = (v) => {
      document.removeEventListener('keydown', onKey, true);
      root.classList.remove('is-open');
      setTimeout(() => root.remove(), reduce ? 0 : 240);
      prevFocus?.focus?.({ preventScroll: true });
      if (v && origin) { origin.at = performance.now(); last = origin; } // the action continues from the original button
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(false); }
      if (e.key === 'Tab') { e.preventDefault(); const b = [...root.querySelectorAll('[data-ask]')]; b[(b.indexOf(document.activeElement) + 1) % b.length].focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ask]');
      if (b) done(b.dataset.ask === '1'); else if (e.target.closest('.modal-backdrop')) done(false);
    });
  });
}

// ── Lists ───────────────────────────────────────────────────────────────────
export function markExit(el, kind) { if (el) el.dataset.fxExit = kind; }

const EXITS = {
  send: { frames: [{ opacity: 1, transform: 'none' }, { opacity: 1, transform: 'translate(0, -6px) scale(1.01)', boxShadow: '0 0 0 2px #98ff03, 0 24px 50px -24px rgba(3,7,18,.35)', offset: 0.28 }, { opacity: 0, transform: 'translate(90px, -46px) scale(0.9) rotate(2deg)', boxShadow: '0 0 0 2px #98ff03' }], ms: 620 },
  skip: { frames: [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-56px) scale(0.98)' }], ms: 380 },
  out: { frames: [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px) scale(0.96)' }], ms: 340 },
};

export function swapList(box, html, sel) {
  if (!box) return;
  const visible = box.isConnected && box.getClientRects().length > 0;
  if (reduce || !visible) { box.innerHTML = html; return; }
  const name = (sel.match(/\[([\w-]+)\]/) || [])[1];
  const key = (el) => el.getAttribute(name);
  const old = new Map();
  box.querySelectorAll(sel).forEach((el) => old.set(key(el), { el, r: el.getBoundingClientRect() }));
  const h0 = box.offsetHeight;
  box.innerHTML = html;
  const now = [...box.querySelectorAll(sel)];
  const keys = new Set(now.map(key));
  const kept = now.filter((el) => old.has(key(el)));
  const fresh = now.filter((el) => !old.has(key(el)));
  const gone = [...old.values()].filter((o) => !keys.has(key(o.el)));

  const enter = (el, delay) => el.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay, easing: EASE, fill: 'backwards' });

  // Different list altogether (filter switch, first paint): a quick staggered entrance.
  if (gone.length > 4 || (!kept.length && gone.length !== 1)) {
    const items = now.length ? now : [...box.children];
    items.slice(0, 14).forEach((el, i) => enter(el, i * 28));
    return;
  }
  if (!now.length) [...box.children].forEach((el) => enter(el, 220)); // empty state after the last row left

  // Rows that stay glide from where they were.
  kept.forEach((el) => {
    const a = old.get(key(el)).r, b = el.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 460, easing: EASE });
  });
  fresh.forEach((el, i) => enter(el, 120 + i * 40));

  // Rows that left: the old node itself plays the exit on top of the list.
  if (gone.length) {
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    const br = box.getBoundingClientRect();
    gone.forEach(({ el, r }) => {
      Object.assign(el.style, { position: 'absolute', left: `${r.left - br.left - box.clientLeft + box.scrollLeft}px`, top: `${r.top - br.top - box.clientTop + box.scrollTop}px`, width: `${r.width}px`, height: `${r.height}px`, margin: '0', pointerEvents: 'none', zIndex: '5', overflow: 'hidden' });
      el.setAttribute('aria-hidden', 'true'); el.removeAttribute(name);
      box.appendChild(el);
      const x = EXITS[el.dataset.fxExit] || EXITS.out;
      el.animate(x.frames, { duration: x.ms, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }).finished.catch(() => {}).then(() => el.remove());
    });
    // The list gets shorter smoothly instead of snapping the page up.
    const h1 = box.offsetHeight;
    if (h0 - h1 > 8) box.animate([{ minHeight: `${h0}px` }, { minHeight: `${h1}px` }], { duration: 460, easing: EASE });
  }
}

// ── Nothing fails silently ──────────────────────────────────────────────────
window.addEventListener('unhandledrejection', (e) => {
  const m = e.reason?.message || String(e.reason || '');
  if (/AbortError|ResizeObserver/i.test(m)) return;
  console.error('[admin] unhandled', e.reason);
  banner(/Failed to fetch|NetworkError|Load failed/i.test(m) ? 'Brak połączenia z serwerem — zmiany nie zostały zapisane' : (m || 'Nieoczekiwany błąd'), 'error');
});
window.addEventListener('offline', () => banner('Jesteś offline — zmiany nie zapiszą się do powrotu połączenia', 'error'));
window.addEventListener('online', () => banner('Połączenie wróciło', 'ok'));
