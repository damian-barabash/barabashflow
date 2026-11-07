// Motion layer (2026-11-07): live service scenes, pixel page transitions and
// the full-screen menu origin. Everything degrades to static content without
// JS or with prefers-reduced-motion.

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const touch = () => window.matchMedia('(hover: none), (pointer: coarse)').matches;

// ── services: hover = live scene, pointer tilt, auto-cycle while in view ────
export function setupServices() {
  const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-svc]'));
  if (!cards.length || reduced()) return;
  const setLive = (el: HTMLElement | null) => cards.forEach((c) => c.classList.toggle('is-live', c === el));

  if (touch()) {
    // One column on phones: the card crossing the middle of the screen plays.
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => en.target.classList.toggle('is-live', en.isIntersecting));
    }, { rootMargin: '-35% 0px -35% 0px' });
    cards.forEach((c) => io.observe(c));
    return;
  }

  let idx = 0, timer = 0, hovered = false, inView = false;
  const tick = () => { if (!hovered && inView) { setLive(cards[idx % cards.length]); idx++; } };
  const start = () => { if (!timer) { tick(); timer = window.setInterval(tick, 4200); } };
  const stop = () => { clearInterval(timer); timer = 0; };
  new IntersectionObserver(([en]) => {
    inView = en.isIntersecting;
    if (inView) start(); else { stop(); setLive(null); }
  }, { threshold: 0.35 }).observe(cards[0].parentElement!);

  cards.forEach((c, i) => {
    const scene = c.querySelector<HTMLElement>('.svc-scene');
    c.addEventListener('pointerenter', () => { hovered = true; setLive(c); idx = i + 1; });
    c.addEventListener('pointerleave', () => {
      hovered = false;
      scene?.style.removeProperty('--rx'); scene?.style.removeProperty('--ry');
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      c.style.setProperty('--mx', `${(x + 0.5) * 100}%`); c.style.setProperty('--my', `${(y + 0.5) * 100}%`);
      scene?.style.setProperty('--rx', `${(-y * 14).toFixed(2)}deg`);
      scene?.style.setProperty('--ry', `${(x * 18).toFixed(2)}deg`);
    });
    c.addEventListener('focusin', () => setLive(c));
  });
}

// ── page transitions: pixel wave from the click point ───────────────────────
const PT_KEY = 'bf:pt';
const CELL = () => (window.innerWidth < 760 ? 64 : 96);

function buildGrid(root: HTMLElement) {
  const size = CELL();
  const cols = Math.ceil(window.innerWidth / size), rows = Math.ceil(window.innerHeight / size);
  const grid = root.querySelector<HTMLElement>('.pt-grid')!;
  grid.style.gridTemplateColumns = `repeat(${cols}, ${size}px)`;
  grid.style.gridAutoRows = `${size}px`;
  grid.innerHTML = '';
  const cells: { el: HTMLElement; cx: number; cy: number }[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const el = document.createElement('i');
    if (Math.random() < 0.07) el.className = 'is-lime';
    grid.appendChild(el);
    cells.push({ el, cx: c * size + size / 2, cy: r * size + size / 2 });
  }
  return cells;
}

function wave(cells: ReturnType<typeof buildGrid>, ox: number, oy: number, span: number) {
  const max = Math.hypot(Math.max(ox, window.innerWidth - ox), Math.max(oy, window.innerHeight - oy)) || 1;
  cells.forEach(({ el, cx, cy }) => {
    el.style.transitionDelay = `${Math.round((Math.hypot(cx - ox, cy - oy) / max) * span + Math.random() * 40)}ms`;
  });
}

function labelFor(a: HTMLAnchorElement) {
  const own = (a.querySelector('.nl')?.textContent || a.getAttribute('aria-label') || a.textContent || '').replace(/\s+/g, ' ').trim();
  if (own && own.length <= 34) return own;
  const seg = new URL(a.href).pathname.split('/').filter(Boolean);
  return seg.length ? seg[seg.length - 1].replace(/-/g, ' ') : 'BarabashFlow';
}

export function setupPageTransitions() {
  const root = document.getElementById('pt');
  if (!root) return;
  const html = document.documentElement;
  const label = root.querySelector<HTMLElement>('.pt-label');

  // Enter: page was painted covered (inline head script) → un-cover in a wave.
  if (html.classList.contains('pt-cover')) {
    let origin: { x: number; y: number } | null = null;
    try { origin = JSON.parse(sessionStorage.getItem(PT_KEY) || 'null'); sessionStorage.removeItem(PT_KEY); } catch {}
    const cells = buildGrid(root);
    root.classList.add('is-on', 'is-full');
    if (label && origin && (origin as any).label) label.textContent = (origin as any).label;
    requestAnimationFrame(() => {
      html.classList.remove('pt-cover');
      wave(cells, window.innerWidth - (origin?.x ?? 0), window.innerHeight - (origin?.y ?? 0), 520);
      requestAnimationFrame(() => {
        root.classList.remove('is-full');
        setTimeout(() => root.classList.remove('is-on'), 1100);
      });
    });
  }

  if (reduced()) return;
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download') || a.dataset.noPt !== undefined) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || /^\/(admin|mail)/.test(url.pathname) || /\.(xml|txt|png|jpg|webp|pdf)$/i.test(url.pathname)) return;
    if (url.pathname === location.pathname && url.search === location.search) return; // same-page anchors
    e.preventDefault();
    const x = e.clientX || window.innerWidth / 2, y = e.clientY || window.innerHeight / 2;
    const text = labelFor(a);
    try { sessionStorage.setItem(PT_KEY, JSON.stringify({ x, y, label: text })); } catch {}
    const cells = buildGrid(root);
    if (label) label.textContent = text;
    wave(cells, x, y, 420);
    root.classList.add('is-on');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('is-full')));
    setTimeout(() => { location.href = url.href; }, 640);
  });
  // Back/forward cache: never come back to a covered page.
  window.addEventListener('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) root.classList.remove('is-on', 'is-full'); });
}

// ── full-screen menu: circle grows from the burger ──────────────────────────
export function setMenuOrigin() {
  const btn = document.getElementById('nav-burger');
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const root = document.documentElement.style;
  root.setProperty('--menu-x', `${x}px`);
  root.setProperty('--menu-y', `${y}px`);
  root.setProperty('--menu-r', `${Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)))}px`);
}

// ── hero: floating "demo" widgets — parallax, cycling live covers ───────────
export function setupHeroWidgets() {
  const hero = document.querySelector<HTMLElement>('.hero');
  const vis = document.querySelector<HTMLElement>('.hero-visual');
  if (!hero || !vis) return;
  vis.classList.add('hw-ready');
  if (!touch() && !reduced()) {
    let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
    const loop = () => {
      cx += (tx - cx) * 0.08; cy += (ty - cy) * 0.08;
      vis.style.setProperty('--hx', cx.toFixed(3)); vis.style.setProperty('--hy', cy.toFixed(3));
      raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.002 ? requestAnimationFrame(loop) : 0;
    };
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width - 0.5) * 2; ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
      if (!raf) raf = requestAnimationFrame(loop);
    });
    hero.addEventListener('pointerleave', () => { tx = 0; ty = 0; if (!raf) raf = requestAnimationFrame(loop); });
  }
  // live browser: crossfade covers + swap the URL
  const shots = Array.from(vis.querySelectorAll<HTMLImageElement>('.hw-shots img'));
  const url = vis.querySelector<HTMLElement>('.hw-url');
  if (shots.length > 1 && !reduced()) {
    let i = 0;
    const load = (img: HTMLImageElement) => { if (!img.getAttribute('src') && img.dataset.src) img.src = img.dataset.src; };
    setTimeout(() => load(shots[1]), 1500);
    setInterval(() => {
      if (document.hidden) return;
      const cur = shots[i]; i = (i + 1) % shots.length; const nx = shots[i];
      load(nx); load(shots[(i + 1) % shots.length]);
      cur.classList.remove('is-on'); nx.classList.add('is-on');
      if (url) { url.classList.remove('is-type'); void url.offsetWidth; url.textContent = nx.dataset.host || ''; url.classList.add('is-type'); }
    }, 2800);
  }
  // enquiry toast: new reference number on every pass
  const ref = vis.querySelector<HTMLElement>('.hw-ref em');
  vis.querySelector('.hw-lead')?.addEventListener('animationiteration', () => {
    if (ref) ref.textContent = String(10000 + Math.floor(Math.random() * 89999));
  });
}

// ── dot-matrix tiles: logo / text drawn in pixels, cursor scatters them ─────
type Pt = { x: number; y: number };
interface Particle { x: number; y: number; tx: number; ty: number; a: number; ta: number; lime: boolean }

async function shapePoints(shape: string, w: number, h: number, step: number): Promise<Pt[]> {
  const c = document.createElement('canvas'); c.width = Math.round(w); c.height = Math.round(h);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  if (shape === 'logo') {
    const img = new Image(); img.src = '/assets/img/logo.png';
    await img.decode().catch(() => {});
    const s = Math.min(w * 0.5 / img.width, h * 0.66 / img.height) || 1;
    g.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
  } else {
    try { await document.fonts.load('800 100px Sunsive'); } catch {}
    let size = h * 0.6;
    g.font = `800 ${size}px Sunsive, Onest, sans-serif`;
    const mw = g.measureText(shape).width;
    if (mw > w * 0.78) size *= (w * 0.78) / mw;
    g.font = `800 ${size}px Sunsive, Onest, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#000';
    g.fillText(shape, w / 2, h / 2 + size * 0.04);
  }
  const data = g.getImageData(0, 0, c.width, c.height).data;
  const pts: Pt[] = [];
  const ox = (w % step) / 2 + step / 2, oy = (h % step) / 2 + step / 2;
  for (let y = oy; y < h; y += step) for (let x = ox; x < w; x += step) {
    if (data[(Math.floor(y) * c.width + Math.floor(x)) * 4 + 3] > 110) pts.push({ x, y });
  }
  return pts.sort((a, b) => a.x + a.y * 0.35 - (b.x + b.y * 0.35));
}

function mountDotTile(tile: HTMLElement) {
  const canvas = tile.querySelector('canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d')!;
  const shapes = (tile.dataset.dots || 'logo').split('|');
  let w = 0, h = 0, step = 12, dpr = 1, sets: Pt[][] = [], parts: Particle[] = [], k = 0;
  let mx = -1e4, my = -1e4, visible = false, raf = 0, last = 0, t0 = performance.now();
  const ripples: { x: number; y: number; t: number }[] = [];

  const target = (idx: number) => {
    const set = sets[idx]; if (!set?.length) return;
    parts.forEach((p, i) => {
      if (i < set.length) { p.tx = set[i].x; p.ty = set[i].y; p.ta = 1; }
      else { const q = set[i % set.length]; p.tx = q.x; p.ty = q.y; p.ta = 0; }
      p.lime = Math.random() < 0.06;
    });
  };
  const build = async () => {
    const r = tile.getBoundingClientRect(); if (!r.width) return;
    dpr = Math.min(2, window.devicePixelRatio || 1); w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    step = Math.max(8, Math.min(14, Math.round(w / 46)));
    sets = await Promise.all(shapes.map((s) => shapePoints(s, w, h, step)));
    const n = Math.max(...sets.map((s) => s.length), 1);
    parts = Array.from({ length: n }, () => ({ x: w / 2 + (Math.random() - 0.5) * w, y: h / 2 + (Math.random() - 0.5) * h, tx: w / 2, ty: h / 2, a: 0, ta: 0, lime: false }));
    k = 0; target(0); draw(performance.now());
  };
  const draw = (now: number) => {
    const t = (now - t0) / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // background grid of faint pixels
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    const ox = (w % step) / 2 + step / 2, oy = (h % step) / 2 + step / 2;
    for (let y = oy; y < h; y += step) for (let x = ox; x < w; x += step) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    const R = Math.max(70, w * 0.16), sz = step * 0.5;
    for (const p of parts) {
      p.x += (p.tx - p.x) * 0.075; p.y += (p.ty - p.y) * 0.075; p.a += (p.ta - p.a) * 0.08;
      if (p.a < 0.02) continue;
      let dx = p.x - mx, dy = p.y - my, d = Math.hypot(dx, dy), px = p.x, py = p.y, hot = 0;
      if (d < R) { const f = (1 - d / R) ** 2; px += (dx / (d || 1)) * f * 26; py += (dy / (d || 1)) * f * 26; hot = f; }
      for (const rp of ripples) {
        const age = (now - rp.t) / 1000, rr = age * 420, dd = Math.hypot(p.x - rp.x, p.y - rp.y), band = 1 - Math.min(1, Math.abs(dd - rr) / 40);
        if (band > 0) { px += ((p.x - rp.x) / (dd || 1)) * band * 14 * (1 - age); hot = Math.max(hot, band * (1 - age)); }
      }
      const shimmer = 0.6 + 0.4 * Math.sin(t * 2.2 + p.tx * 0.045 + p.ty * 0.03);
      ctx.globalAlpha = p.a * (hot > 0.15 ? 1 : shimmer);
      ctx.fillStyle = hot > 0.15 || p.lime ? '#98ff03' : '#ffffff';
      const s = sz * (1 + hot * 0.6);
      ctx.fillRect(px - s / 2, py - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    while (ripples.length && now - ripples[0].t > 1000) ripples.shift();
  };
  const loop = (now: number) => {
    raf = 0; if (!visible) return;
    if (shapes.length > 1 && now - last > 4600) { last = now; k = (k + 1) % shapes.length; target(k); }
    draw(now); raf = requestAnimationFrame(loop);
  };
  const start = () => { if (!raf && !reduced()) { last = performance.now(); raf = requestAnimationFrame(loop); } };

  tile.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; tile.classList.add('is-touched'); });
  tile.addEventListener('pointerleave', () => { mx = my = -1e4; });
  tile.addEventListener('pointerdown', (e) => { const r = canvas.getBoundingClientRect(); ripples.push({ x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() }); });
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) start(); }, { threshold: 0.05 }).observe(tile);
  let rt = 0;
  new ResizeObserver(() => { clearTimeout(rt); rt = window.setTimeout(() => build().then(start), 120); }).observe(tile);
}

export function setupDotTiles() {
  document.querySelectorAll<HTMLElement>('.dot-tile').forEach(mountDotTile);
}

// ── showreel player: full-screen dialog, HD on desktop, 720p on phones ─────
export function setupReel() {
  const box = document.getElementById('reel');
  const video = box?.querySelector('video');
  if (!box || !video) return;
  let last: HTMLElement | null = null;
  const open = (from: HTMLElement) => {
    last = from;
    if (!video.src) video.src = (window.innerWidth < 900 ? video.dataset.srcSd : video.dataset.srcHd) || '';
    const r = from.getBoundingClientRect();
    box.style.setProperty('--rx', `${r.left + r.width / 2}px`); box.style.setProperty('--ry', `${r.top + r.height / 2}px`);
    document.querySelectorAll<HTMLVideoElement>('.ri-video').forEach((v) => v.pause());
    box.hidden = false; document.body.classList.add('nav-locked');
    requestAnimationFrame(() => box.classList.add('is-open'));
    video.play().catch(() => {});
    box.querySelector<HTMLElement>('[data-reel-close]')?.focus({ preventScroll: true });
  };
  const close = () => {
    if (box.hidden) return;
    video.pause(); box.classList.remove('is-open'); document.body.classList.remove('nav-locked');
    document.dispatchEvent(new Event('bf:reel-closed'));
    setTimeout(() => { box.hidden = true; }, reduced() ? 0 : 520);
    last?.focus({ preventScroll: true });
  };
  document.querySelectorAll<HTMLElement>('[data-reel]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); open(b); }));
  box.querySelector('[data-reel-close]')?.addEventListener('click', close);
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// ── inline showreel: autoplay muted while on screen, vertical cut on phones ─
export function setupReelInline() {
  const video = document.querySelector<HTMLVideoElement>('.ri-video');
  if (!video) return;
  const wrap = video.closest<HTMLElement>('.reel-inline')!;
  const phone = window.matchMedia('(max-width: 760px)').matches;
  if (phone && video.dataset.v) {
    wrap.classList.add('is-v');
    if (video.dataset.vPoster) video.poster = video.dataset.vPoster;
  }
  const src = () => (phone && video.dataset.v) || (window.innerWidth >= 1100 ? video.dataset.hd : video.dataset.sd) || '';
  let inView = false, modal = false;
  const play = () => { if (!video.src) video.src = src(); if (!reduced() || !video.muted) video.play().catch(() => {}); };
  new IntersectionObserver(([en]) => {
    inView = en.isIntersecting;
    if (inView && !modal) play(); else video.pause();
  }, { threshold: 0.25 }).observe(wrap);
  document.querySelectorAll<HTMLElement>('[data-reel]').forEach((b) => b.addEventListener('click', () => { modal = true; }));
  document.addEventListener('bf:reel-closed', () => { modal = false; if (inView) play(); });
  const btn = wrap.querySelector<HTMLButtonElement>('[data-ri-sound]');
  btn?.addEventListener('click', () => {
    video.muted = !video.muted;
    btn.setAttribute('aria-pressed', String(!video.muted));
    wrap.classList.toggle('is-sound', !video.muted);
    if (!video.muted) { if (!video.src) video.src = src(); video.play().catch(() => {}); }
  });
  video.addEventListener('playing', () => wrap.classList.add('is-playing'));
}
