// ═══════════════════════════════════════════════════════════════════════════
// BarabashFlow — public page engine (zero framework runtime).
//
// This is a performance-focused rewrite of the old assets/js/main.js. The graph
// looks and behaves the same, but the hot path is gone:
//   • node base positions live on left/top and are written ONLY on layout / drag
//     / resize / repulsion-settle — never 60×/sec;
//   • the floating "bob" is a CSS keyframe on .node-inner (compositor only);
//   • edges redraw event-driven, not per frame; pan/zoom moves them via a CSS
//     transform on .stage-inner for free;
//   • repulsion runs in a self-terminating settle loop that stops once nodes
//     stop moving — so the main thread is idle when nothing is happening;
//   • stage metrics are cached and refreshed via ResizeObserver (no
//     getBoundingClientRect in any loop);
//   • the Draco-compressed 3D logo renders on its own RAF, paused when the tab
//     is hidden or the logo scrolls off-screen.
// Net effect: clicks are instant because the main thread isn't thrashing layout.
// ═══════════════════════════════════════════════════════════════════════════

import { SUPABASE_URL, SUPABASE_ANON_KEY, mediaUrl, restGet, restInsert } from '../lib/supabase';
import {
  LOCALES, getLocale, setLocale, onLocaleChange, t, pickField, applyDom,
} from '../lib/i18n';
import { getTheme, toggleTheme, onThemeChange } from '../lib/theme';
import { setupTopbarMorph, setupBurger, setupSmoothScroll, trackPageView } from '../lib/shell';

type Row = Record<string, any>;
interface GraphNode {
  id: string;
  el: HTMLElement;
  baseX: number;
  baseY: number;
  targetX: number;
  targetY: number;
  dragging: boolean;
}
interface Metrics {
  width: number; height: number;
  cx: number; cy: number;
  halfW: number; halfH: number;
  nodeW: number; nodeH: number;
}

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel);

const state = {
  settings: {} as Record<string, Row>,
  projects: [] as Row[],
  photosByProject: new Map<string, Row[]>(),
  connections: [] as Row[],
  nodes: [] as GraphNode[],
  stage: null as HTMLElement | null,
  stageInner: null as HTMLElement | null,
  edgeSvg: null as SVGSVGElement | null,
  metrics: null as Metrics | null,
  viewZoom: 1,
  viewPanX: 0,
  viewPanY: 0,
  userViewSet: false,
  isTouch: false,
  nodeHint: null as HTMLElement | null,
  tickThree: null as ((t: number) => void) | null,
  settleRaf: 0,
  zoomIndTimer: 0 as any,
  zoomReleaseTimer: 0 as any,
};

// ─── Bootstrap ───────────────────────────────────────────────────────────────
export async function mountApp() {
  state.stage = $('.stage');
  state.stageInner = $('#stage-inner');
  state.edgeSvg = $<SVGSVGElement>('#graph-edges') as unknown as SVGSVGElement;
  state.isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  setupLangSwitcher();
  setupThemeToggle();
  setupTopbarMorph();
  setupBurger();
  setupSmoothScroll();
  trackPageView();
  setupCta();
  setupModalDismiss();
  setupTabAway();
  applyDom();

  refreshMetrics();
  if (state.stage) new ResizeObserver(onStageResize).observe(state.stage);

  if (!state.isTouch) setupParallax();

  // Three.js is best-effort — never block the page on it.
  try { start3DLogo(); }
  catch (err) { console.warn('[bf] 3D logo disabled', err); showLogoFallback(); }

  setupReveal();

  await loadData();
  renderHeader();
  renderStats();
  renderNodes();
  bindNodeInteractions();
  setupViewZoomPan();
  startBob();
  setupMascotBot();
  setupCookieConsent();
  setupPanHint();

  // Cinematic entrance — two frames so the first paint settles.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.classList.remove('is-loading');
  }));

  window.addEventListener('resize', onStageResize);
}

// ─── Data ────────────────────────────────────────────────────────────────────
async function loadData() {
  const [settings, projects, photos, edges] = await Promise.all([
    restGet('site_settings?select=*'),
    restGet('projects?select=*&is_published=eq.true&order=sort_order.asc'),
    restGet('project_photos?select=*&order=sort_order.asc'),
    restGet('project_connections?select=*'),
  ]);
  state.settings = Object.fromEntries((settings || []).map((r: Row) => [r.key, r]));
  state.projects = projects || [];
  state.photosByProject.clear();
  for (const ph of photos || []) {
    const arr = state.photosByProject.get(ph.project_id) || [];
    arr.push(ph);
    state.photosByProject.set(ph.project_id, arr);
  }
  state.connections = edges || [];
}

// ─── Metrics (cached) ────────────────────────────────────────────────────────
function refreshMetrics() {
  const stage = state.stage;
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const padX = Math.min(rect.width * 0.04, 64);
  const padY = Math.min(rect.height * 0.06, 56);
  // The graph lives inside a card on a scrollable page now (no more
  // full-screen mobile world multiplier) — auto-fit handles small screens.
  const worldMul = 1;
  const cs = getComputedStyle(document.documentElement);
  const nodeW = parseFloat(cs.getPropertyValue('--node-w')) || 158;
  const nodeH = parseFloat(cs.getPropertyValue('--node-h')) || 144;
  state.metrics = {
    width: rect.width,
    height: rect.height,
    cx: rect.width / 2,
    cy: rect.height / 2,
    halfW: (rect.width / 2 - padX) * worldMul,
    halfH: (rect.height / 2 - padY) * worldMul,
    nodeW,
    nodeH,
  };
}
function metrics(): Metrics {
  if (!state.metrics) refreshMetrics();
  return state.metrics!;
}

function onStageResize() {
  refreshMetrics();
  layoutNodePositions();
  drawEdges();
  if (!state.userViewSet) applyAutoFit();
}

// ─── Header ──────────────────────────────────────────────────────────────────
function renderHeader() {
  const heroTitleEl = $('#hero-title');
  const heroSubEl = $('#hero-sub');
  const portrait = $('#owner-portrait');

  const title = pickField(state.settings.hero_title, 'value');
  if (title && heroTitleEl) heroTitleEl.innerHTML = styleHeroTitle(title);
  const sub = pickField(state.settings.hero_subtitle, 'value');
  if (heroSubEl) heroSubEl.textContent = sub || '';

  const photoPath = state.settings.owner_photo_path?.value_meta?.path;
  if (portrait) {
    if (photoPath) {
      portrait.style.backgroundImage = `url("${mediaUrl(photoPath)}")`;
      portrait.removeAttribute('data-empty');
    } else {
      portrait.style.backgroundImage = '';
      portrait.setAttribute('data-empty', 'true');
    }
  }

  const ctaLabel = pickField(state.settings.cta_label, 'value');
  if (ctaLabel) {
    document.querySelectorAll<HTMLElement>('.cta-label').forEach((el) => { el.textContent = ctaLabel; });
  }

  const captionEl = $('#graph-caption');
  if (captionEl) captionEl.textContent = pickField(state.settings.graph_caption, 'value') || '';
}

// Live numbers in the hero stat strip.
function renderStats() {
  const el = $('#stat-projects');
  if (el) el.textContent = String(state.projects.length || 0);
}

// Reveal-on-scroll for the info sections below the fold.
function setupReveal() {
  const targets = document.querySelectorAll<HTMLElement>('[data-reveal]');
  if (!targets.length) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    targets.forEach((el) => el.classList.add('is-inview'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-inview');
        io.unobserve(entry.target);
      }
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  // .will-reveal only gets added when JS runs — without JS the sections
  // simply stay visible (crawlers, reader modes).
  targets.forEach((el) => { el.classList.add('will-reveal'); io.observe(el); });
}

function styleHeroTitle(text: string): string {
  const conj: Record<string, string> = { pl: ' i ', en: ' and ', ru: ' и ' };
  const c = conj[getLocale()] || ' ';
  const idx = text.toLowerCase().indexOf(c);
  if (idx === -1) return escapeHtml(text);
  return (
    escapeHtml(text.slice(0, idx)) +
    `<em>${escapeHtml(text.slice(idx, idx + c.length))}</em>` +
    escapeHtml(text.slice(idx + c.length))
  );
}

// ─── Nodes ───────────────────────────────────────────────────────────────────
function renderNodes() {
  for (const n of state.nodes) n.el.remove();
  state.nodes = [];

  const projects = state.projects;
  if (!projects.length) { drawEdges(); return; }

  applyGraphScale(projects.length);
  refreshMetrics(); // node size may have changed with the scale

  const allZero = projects.every((p) => p.position_x === 0 && p.position_y === 0);
  if (allZero) autoLayout(projects);

  const frag = document.createDocumentFragment();
  projects.forEach((p, i) => {
    const el = buildNodeEl(p, i);
    frag.appendChild(el);
    let bx = Number.isFinite(p.position_x) ? p.position_x : 0;
    let by = Number.isFinite(p.position_y) ? p.position_y : 0;
    [bx, by] = compressRadius(bx, by);
    bx = clampUnit(bx); by = clampUnit(by);
    state.nodes.push({ id: p.id, el, baseX: bx, baseY: by, targetX: bx, targetY: by, dragging: false });
  });
  state.stageInner!.appendChild(frag);

  applyAutoFit();
  layoutNodePositions();
  layoutEdges();
  drawEdges();
  // One settle pass to separate any overlaps, then the loop parks itself.
  wakeSettle();
}

function applyGraphScale(n: number) {
  const root = document.documentElement;
  if (window.innerWidth > 760) {
    const scale = Math.max(0.74, Math.min(1, 1 - Math.max(0, n - 4) * 0.028));
    root.style.setProperty('--node-w', `${Math.round(210 * scale)}px`);
    root.style.setProperty('--node-h', `${Math.round(154 * scale)}px`);
    root.style.setProperty('--node-thumb-h', `${Math.round(94 * scale)}px`);
    root.style.setProperty('--logo-d', `${Math.round(296 * scale)}px`);
    return;
  }
  const scale = Math.max(0.55, Math.min(1, 1 - Math.max(0, n - 4) * 0.045));
  root.style.setProperty('--node-w', `${Math.round(158 * scale)}px`);
  root.style.setProperty('--node-h', `${Math.round(144 * scale)}px`);
  root.style.setProperty('--node-thumb-h', `${Math.round(88 * scale)}px`);
  root.style.setProperty('--logo-d', `${Math.round(296 * scale)}px`);
}

function compressRadius(x: number, y: number): [number, number] {
  const r = Math.hypot(x, y);
  if (r <= 0.5) return [x, y];
  const r2 = 0.5 + (r - 0.5) * 0.45;
  const f = r2 / r;
  return [x * f, y * f];
}

function autoLayout(projects: Row[]) {
  const n = projects.length;
  const portrait = window.innerHeight > window.innerWidth;
  const narrow = window.innerWidth <= 760;
  let radiusX: number, radiusY: number;
  if (narrow && portrait && n >= 2) {
    const m = metrics();
    const minChord = Math.max(m.nodeW, m.nodeH) + 10;
    const rPx = minChord / (2 * Math.sin(Math.PI / n));
    radiusX = rPx / Math.max(1, m.halfW);
    radiusY = rPx / Math.max(1, m.halfH);
  } else {
    radiusX = Math.min(0.96, 0.86 + Math.max(0, n - 4) * 0.018);
    radiusY = Math.min(0.90, 0.78 + Math.max(0, n - 4) * 0.018);
  }
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    projects[i].position_x = Math.cos(angle) * radiusX;
    projects[i].position_y = Math.sin(angle) * radiusY;
  }
}

function buildNodeEl(p: Row, index = 0): HTMLElement {
  const el = document.createElement('div');
  el.className = 'node';
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.dataset.projectId = p.id;
  if (p.accent_color) el.style.setProperty('--node-accent', p.accent_color);
  el.style.animationDelay = `${0.55 + index * 0.07}s`;

  const catLabel = pickField(p, 'category') || t(`category.${p.category_key || 'other'}`);
  el.dataset.phase = String(index * 0.9);
  el.innerHTML = `
    <div class="node-thumb" data-empty="true"></div>
    <div class="node-body">
      <span class="node-cat"></span>
      <span class="node-title"></span>
    </div>`;

  const photos = state.photosByProject.get(p.id) || [];
  if (photos[0]?.storage_path) {
    const thumb = $('.node-thumb', el)!;
    thumb.removeAttribute('data-empty');
    const url = mediaUrl(photos[0].storage_path)!;
    const pre = new Image();
    pre.decoding = 'async';
    pre.onload = () => {
      thumb.style.setProperty('--thumb-img', `url("${url}")`);
      requestAnimationFrame(() => thumb.classList.add('is-loaded'));
    };
    pre.src = url;
  }

  $('.node-cat', el)!.textContent = catLabel;
  $('.node-title', el)!.textContent = pickField(p, 'title');
  el.setAttribute('aria-label', pickField(p, 'title'));
  return el;
}

function clampUnit(v: number): number {
  if (Number.isFinite(v)) return Math.max(-3, Math.min(3, v));
  return 0;
}

// Write each node's base pixel position to left/top (event-driven, no bob).
function layoutNodePositions() {
  const m = metrics();
  for (const n of state.nodes) placeNode(n, m);
}
function placeNode(n: GraphNode, m = metrics()) {
  n.el.style.left = `${m.cx + n.baseX * m.halfW}px`;
  n.el.style.top = `${m.cy + n.baseY * m.halfH}px`;
}

// ─── Auto-fit view ───────────────────────────────────────────────────────────
function applyAutoFit() {
  if (state.userViewSet) return;
  const m = metrics();
  if (!m.width || !m.height) return;

  let maxAbsX = 0.001, maxAbsY = 0.001;
  for (const n of state.nodes) {
    maxAbsX = Math.max(maxAbsX, Math.abs(n.baseX));
    maxAbsY = Math.max(maxAbsY, Math.abs(n.baseY));
  }
  const padding = 16;
  const extentX = maxAbsX * m.halfW + m.nodeW / 2 + padding;
  const extentY = maxAbsY * m.halfH + m.nodeH / 2 + padding;
  const fitX = (m.width / 2) / extentX;
  const fitY = (m.height / 2) / extentY;
  const fit = Math.max(0.22, Math.min(1, Math.min(fitX, fitY)));
  state.viewZoom = fit; state.viewPanX = 0; state.viewPanY = 0;
  applyViewTransform();
}

function applyViewTransform() {
  const inner = state.stageInner;
  if (!inner) return;
  inner.style.setProperty('--view-zoom', state.viewZoom.toFixed(3));
  inner.style.setProperty('--view-pan-x', `${state.viewPanX.toFixed(1)}px`);
  inner.style.setProperty('--view-pan-y', `${state.viewPanY.toFixed(1)}px`);
  const ind = $('#zoom-indicator');
  if (ind) {
    ind.textContent = `${Math.round(state.viewZoom * 100)}%`;
    ind.classList.add('is-visible');
    clearTimeout(state.zoomIndTimer);
    state.zoomIndTimer = setTimeout(() => ind.classList.remove('is-visible'), 900);
  }
}

// ─── Edges ───────────────────────────────────────────────────────────────────
const SVGNS = 'http://www.w3.org/2000/svg';
function layoutEdges() {
  const svg = state.edgeSvg;
  if (!svg) return;
  svg.innerHTML = '';
  if (!state.nodes.length) return;
  for (const n of state.nodes) {
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('class', 'edge is-center');
    path.dataset.from = '__center__';
    path.dataset.to = n.id;
    svg.appendChild(path);
  }
  for (const e of state.connections) {
    if (!state.nodes.some((n) => n.id === e.from_project_id)) continue;
    if (!state.nodes.some((n) => n.id === e.to_project_id)) continue;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('class', 'edge');
    path.dataset.from = e.from_project_id;
    path.dataset.to = e.to_project_id;
    svg.appendChild(path);
  }
}

// Draw all edges from cached metrics + base positions (no per-frame work).
function drawEdges() {
  const svg = state.edgeSvg;
  if (!svg) return;
  const m = metrics();
  svg.setAttribute('viewBox', `0 0 ${m.width} ${m.height}`);
  const posOf = (id: string) => {
    if (id === '__center__') return { x: m.cx, y: m.cy };
    const n = state.nodes.find((nn) => nn.id === id);
    if (!n) return null;
    return { x: m.cx + n.baseX * m.halfW, y: m.cy + n.baseY * m.halfH };
  };
  svg.querySelectorAll<SVGPathElement>('path.edge').forEach((path) => {
    const a = posOf(path.dataset.from!);
    const b = posOf(path.dataset.to!);
    if (!a || !b) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const offset = Math.min(len * 0.08, 36) * 0.5;
    const nx = -dy / len, ny = dx / len;
    const ox = mx + nx * offset, oy = my + ny * offset;
    path.setAttribute('d', `M ${a.x} ${a.y} Q ${ox} ${oy} ${b.x} ${b.y}`);
  });
}

// ─── Repulsion — self-terminating settle loop ───────────────────────────────
function applyRepulsion() {
  const ns = state.nodes;
  if (ns.length < 2) return;
  const m = metrics();
  const nw = m.nodeW, nh = m.nodeH, pad = 28;
  const pos = ns.map((n) => ({ n, x: m.cx + n.baseX * m.halfW, y: m.cy + n.baseY * m.halfH }));
  for (let i = 0; i < pos.length; i++) {
    for (let j = i + 1; j < pos.length; j++) {
      const iDrag = pos[i].n.dragging, jDrag = pos[j].n.dragging;
      if (iDrag && jDrag) continue;
      const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y;
      const overlapX = (nw + pad) - Math.abs(dx);
      const overlapY = (nh + pad) - Math.abs(dy);
      if (overlapX <= 0 || overlapY <= 0) continue;
      const anyDrag = iDrag || jDrag;
      if (!anyDrag) {
        if (overlapX < overlapY) {
          const sign = dx < 0 ? -1 : 1;
          const mid = (pos[i].x + pos[j].x) / 2;
          const halfSpan = (nw + pad) / 2 + 1;
          pos[i].n.targetX = clampUnit((mid - sign * halfSpan - m.cx) / Math.max(m.halfW, 1));
          pos[j].n.targetX = clampUnit((mid + sign * halfSpan - m.cx) / Math.max(m.halfW, 1));
        } else {
          const sign = dy < 0 ? -1 : 1;
          const mid = (pos[i].y + pos[j].y) / 2;
          const halfSpan = (nh + pad) / 2 + 1;
          pos[i].n.targetY = clampUnit((mid - sign * halfSpan - m.cy) / Math.max(m.halfH, 1));
          pos[j].n.targetY = clampUnit((mid + sign * halfSpan - m.cy) / Math.max(m.halfH, 1));
        }
      } else {
        const dragger = iDrag ? pos[i] : pos[j];
        const flee = iDrag ? pos[j] : pos[i];
        const ddx = flee.x - dragger.x, ddy = flee.y - dragger.y;
        if (overlapX < overlapY) {
          const sign = ddx < 0 ? -1 : 1;
          const newX = dragger.x + sign * (nw + pad);
          flee.n.targetX = clampUnit((newX - m.cx) / Math.max(m.halfW, 1));
        } else {
          const sign = ddy < 0 ? -1 : 1;
          const newY = dragger.y + sign * (nh + pad);
          flee.n.targetY = clampUnit((newY - m.cy) / Math.max(m.halfH, 1));
        }
      }
    }
  }
}

// Ease base -> target; returns true if anything moved this frame.
function smoothNodes(): boolean {
  const k = 0.18;
  let moved = false;
  for (const n of state.nodes) {
    if (n.dragging) { moved = true; continue; }
    const dx = n.targetX - n.baseX, dy = n.targetY - n.baseY;
    if (Math.abs(dx) < 0.0006 && Math.abs(dy) < 0.0006) continue;
    n.baseX = clampUnit(n.baseX + dx * k);
    n.baseY = clampUnit(n.baseY + dy * k);
    moved = true;
  }
  return moved;
}

// Wake the settle loop. It runs applyRepulsion + smoothNodes until convergence
// then stops — so idle CPU is zero.
function wakeSettle() {
  if (state.settleRaf) return;
  let idleFrames = 0;
  const step = () => {
    applyRepulsion();
    const moved = smoothNodes();
    layoutNodePositions();
    drawEdges();
    idleFrames = moved ? 0 : idleFrames + 1;
    if (idleFrames > 2 && !anyDragging()) {
      state.settleRaf = 0;
      return; // park
    }
    state.settleRaf = requestAnimationFrame(step);
  };
  state.settleRaf = requestAnimationFrame(step);
}
function anyDragging() { return state.nodes.some((n) => n.dragging); }

// ─── Node interactions ───────────────────────────────────────────────────────
const DRAG_THRESHOLD = 5;
function bindNodeInteractions() {
  if (!state.isTouch) ensureNodeHint();
  for (const n of state.nodes) {
    bindNodeDrag(n);
    if (!state.isTouch) { bindMagneticHover(n); bindNodeHint(n); }
  }
}

function ensureNodeHint() {
  if (state.nodeHint) return;
  const el = document.createElement('div');
  el.className = 'node-hint';
  el.id = 'node-hint';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<span data-i18n="graph.cursor-hint">Drag or click</span>';
  document.body.appendChild(el);
  state.nodeHint = el;
  applyDom(el);
}
function bindNodeHint(node: GraphNode) {
  const el = node.el;
  const show = (e: PointerEvent) => {
    if (node.dragging || !state.nodeHint) return;
    state.nodeHint.style.left = `${e.clientX}px`;
    state.nodeHint.style.top = `${e.clientY}px`;
    state.nodeHint.classList.add('is-visible');
  };
  const hide = () => state.nodeHint?.classList.remove('is-visible');
  el.addEventListener('pointerenter', show);
  el.addEventListener('pointermove', show);
  el.addEventListener('pointerleave', hide);
  el.addEventListener('pointerdown', hide);
}
function bindMagneticHover(node: GraphNode) {
  const el = node.el;
  let cx = 0, cy = 0;
  const update = (e: PointerEvent) => {
    if (node.dragging) return;
    el.style.setProperty('--mag-x', `${(e.clientX - cx) * 0.14}px`);
    el.style.setProperty('--mag-y', `${(e.clientY - cy) * 0.14}px`);
  };
  el.addEventListener('pointerenter', (e) => {
    const r = el.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    update(e);
  });
  el.addEventListener('pointermove', update);
  el.addEventListener('pointerleave', () => {
    el.style.setProperty('--mag-x', '0px');
    el.style.setProperty('--mag-y', '0px');
  });
}

function bindNodeDrag(node: GraphNode) {
  const el = node.el;
  let pid: number | null = null;
  let startX = 0, startY = 0, down = false, escalated = false;
  let originLeft = 0, originTop = 0, originPX = 0, originPY = 0;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.stopPropagation();
    pid = e.pointerId; down = true; escalated = false;
    startX = e.clientX; startY = e.clientY;
    originPX = e.clientX; originPY = e.clientY;
    originLeft = parseFloat(el.style.left) || 0;
    originTop = parseFloat(el.style.top) || 0;
    el.setPointerCapture(pid);
  });
  el.addEventListener('pointermove', (e) => {
    if (!down || e.pointerId !== pid) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!escalated && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      escalated = true; node.dragging = true; el.classList.add('is-dragging');
      wakeSettle();
    }
    if (!escalated) return;
    const z = state.viewZoom || 1;
    const m = metrics();
    const nextLeft = originLeft + (e.clientX - originPX) / z;
    const nextTop = originTop + (e.clientY - originPY) / z;
    node.baseX = node.targetX = clampUnit((nextLeft - m.cx) / Math.max(m.halfW, 1));
    node.baseY = node.targetY = clampUnit((nextTop - m.cy) / Math.max(m.halfH, 1));
    placeNode(node, m);
    drawEdges();
  });
  const finish = (e: PointerEvent) => {
    if (!down || (pid !== null && e && e.pointerId !== pid)) return;
    down = false;
    el.releasePointerCapture?.(pid!);
    pid = null;
    const wasDrag = escalated;
    node.dragging = false;
    el.classList.remove('is-dragging');
    if (wasDrag) wakeSettle();
    else {
      const project = state.projects.find((p) => p.id === node.id);
      if (project) openProjectModal(project, el);
    }
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const project = state.projects.find((p) => p.id === node.id);
      if (project) openProjectModal(project, el);
    }
  });
}

// ─── Pan / zoom / pinch ──────────────────────────────────────────────────────
function setupViewZoomPan() {
  const stage = state.stage;
  const inner = state.stageInner;
  if (!stage || !inner) return;

  // The page scrolls now, so plain wheel passes through; zoom needs
  // Ctrl/Cmd+wheel (this also catches trackpad pinch, which browsers report
  // as ctrlKey wheel) or the +/− buttons below.
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    inner.classList.add('is-interacting');
    state.userViewSet = true;
    const factor = Math.exp(-e.deltaY * 0.0015);
    state.viewZoom = Math.max(0.25, Math.min(3.0, state.viewZoom * factor));
    applyViewTransform();
    clearTimeout(state.zoomReleaseTimer);
    state.zoomReleaseTimer = setTimeout(() => inner.classList.remove('is-interacting'), 200);
  }, { passive: false });

  const zoomBy = (factor: number) => {
    state.userViewSet = true;
    state.viewZoom = Math.max(0.25, Math.min(3.0, state.viewZoom * factor));
    applyViewTransform();
  };
  $('#zoom-in')?.addEventListener('click', () => zoomBy(1.25));
  $('#zoom-out')?.addEventListener('click', () => zoomBy(0.8));

  // ⛶ — fullscreen toggle for the whole graph card. CSS overlay instead of
  // the Fullscreen API (unavailable for non-video elements on iOS Safari).
  // Entering/leaving resets the view and re-fits to the new bounds.
  const card = document.querySelector<HTMLElement>('.graph-card');
  const setFullscreen = (on: boolean) => {
    if (!card) return;
    card.classList.toggle('is-fullscreen', on);
    document.documentElement.classList.toggle('graph-fs-lock', on);
    $('#zoom-reset')?.setAttribute('aria-pressed', String(on));
    state.userViewSet = false;
    state.viewPanX = 0;
    state.viewPanY = 0;
    requestAnimationFrame(() => {
      refreshMetrics();
      layoutNodePositions();
      drawEdges();
      applyAutoFit();
    });
  };
  $('#zoom-reset')?.addEventListener('click', () => setFullscreen(!card?.classList.contains('is-fullscreen')));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && card?.classList.contains('is-fullscreen')) setFullscreen(false);
  });

  let panning = false, panSX = 0, panSY = 0, oPanX = 0, oPanY = 0, panPid: number | null = null;
  stage.addEventListener('pointerdown', (e) => {
    // Overlay controls (zoom buttons etc.) must receive their own clicks —
    // capturing the pointer here would retarget the click to the stage.
    if ((e.target as HTMLElement).closest('.node, .graph-tools, .zoom-indicator')) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    panning = true; panPid = e.pointerId;
    panSX = e.clientX; panSY = e.clientY;
    oPanX = state.viewPanX; oPanY = state.viewPanY;
    stage.setPointerCapture(panPid);
    stage.classList.add('is-panning');
    inner.classList.add('is-interacting');
    state.userViewSet = true;
  });
  stage.addEventListener('pointermove', (e) => {
    if (!panning || e.pointerId !== panPid) return;
    state.viewPanX = oPanX + (e.clientX - panSX);
    state.viewPanY = oPanY + (e.clientY - panSY);
    applyViewTransform();
  });
  const endPan = (e?: PointerEvent) => {
    if (!panning || (panPid !== null && e && e.pointerId !== panPid)) return;
    panning = false;
    if (panPid !== null) stage.releasePointerCapture?.(panPid);
    panPid = null;
    stage.classList.remove('is-panning');
    setTimeout(() => inner.classList.remove('is-interacting'), 180);
  };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);

  let pinchStart = 0, pinchZoom = 1;
  const dist = (ts: TouchList) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      if (panning) endPan();
      pinchStart = dist(e.touches); pinchZoom = state.viewZoom;
      state.userViewSet = true; inner.classList.add('is-interacting');
    }
  }, { passive: false });
  stage.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStart > 0) {
      e.preventDefault();
      state.viewZoom = Math.max(0.25, Math.min(3.0, pinchZoom * (dist(e.touches) / pinchStart)));
      applyViewTransform();
    }
  }, { passive: false });
  const endPinch = () => {
    if (pinchStart > 0) { pinchStart = 0; setTimeout(() => inner.classList.remove('is-interacting'), 180); }
  };
  stage.addEventListener('touchend', (e) => { if (e.touches.length < 2) endPinch(); });
  stage.addEventListener('touchcancel', endPinch);
}

// ─── Floating bob — the only always-on loop, and it is deliberately cheap.
// It writes two transform-composited CSS vars per node (--bob-x/--bob-y). Those
// feed the existing GPU transform, so nothing triggers layout or paint on the
// main thread. It pauses when the tab is hidden and respects reduced-motion.
function startBob() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let raf = 0;
  let skip = false;
  const loop = (time: number) => {
    skip = !skip;
    if (skip) { raf = document.hidden ? 0 : requestAnimationFrame(loop); return; }
    for (const n of state.nodes) {
      if (n.dragging) continue;
      const phase = parseFloat(n.el.dataset.phase || '0');
      n.el.style.setProperty('--bob-x', `${(Math.sin(time * 0.0006 + phase) * 5).toFixed(2)}px`);
      n.el.style.setProperty('--bob-y', `${(Math.cos(time * 0.00075 + phase * 1.2) * 5).toFixed(2)}px`);
    }
    raf = document.hidden ? 0 : requestAnimationFrame(loop);
  };
  const start = () => { if (!raf) raf = requestAnimationFrame(loop); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
  start();
}

// ─── Parallax (desktop) — wake on move, sleep when settled ───────────────────
function setupParallax() {
  const target = { x: 0, y: 0 };
  const current = { x: 0, y: 0 };
  const maxShift = 12;
  let raf = 0;
  const loop = () => {
    current.x += (target.x - current.x) * 0.06;
    current.y += (target.y - current.y) * 0.06;
    if (state.stage) {
      state.stage.style.setProperty('--par-x', `${current.x.toFixed(2)}px`);
      state.stage.style.setProperty('--par-y', `${current.y.toFixed(2)}px`);
    }
    if (Math.abs(target.x - current.x) < 0.05 && Math.abs(target.y - current.y) < 0.05) {
      raf = 0; return; // park
    }
    raf = requestAnimationFrame(loop);
  };
  document.addEventListener('mousemove', (e) => {
    target.x = -((e.clientX / window.innerWidth - 0.5) * 2) * maxShift;
    target.y = -((e.clientY / window.innerHeight - 0.5) * 2) * maxShift;
    if (!raf) raf = requestAnimationFrame(loop);
  });
}

// ─── 3D logo (Three.js + Draco), gated RAF ──────────────────────────────────
async function start3DLogo() {
  const host = $('#logo-stage');
  if (!host) return;
  setLogoStatus('init');

  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2') || probe.getContext('webgl');
  if (!gl) { setLogoStatus('no webgl', 'error'); showLogoFallback(); return; }

  const THREE = await import('three');
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');

  let renderer: any;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    setLogoStatus('renderer fail', 'error'); showLogoFallback(); return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0.05, 5.2);
  camera.lookAt(0, 0, 0);
  rebuildLights(THREE, scene);
  const group = new THREE.Group();
  scene.add(group);

  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  };
  resize();
  new ResizeObserver(resize).observe(host);

  setLogoStatus('fetching');
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);

  loader.load(
    `${import.meta.env.BASE_URL}assets/3d/LOGO_3D_BF.glb`,
    (gltf: any) => {
      const model = gltf.scene;
      let meshCount = 0;
      model.traverse((obj: any) => {
        if (!obj.isMesh) return;
        meshCount++;
        if (!obj.geometry.attributes.normal) obj.geometry.computeVertexNormals();
        if (!obj.material) obj.material = themedMaterial(THREE);
      });
      if (meshCount === 0) { setLogoStatus('no meshes', 'error'); showLogoFallback(); return; }
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const targetScale = 2.4 / maxDim;
      model.scale.setScalar(targetScale);
      model.position.copy(box.getCenter(new THREE.Vector3()).multiplyScalar(-targetScale));
      group.add(model);
      hideLogoFallback();
      setLogoStatus(`${meshCount} mesh${meshCount > 1 ? 'es' : ''}`);
      setTimeout(() => setLogoStatus(''), 1500);

      const fromScale = targetScale * 0.72, fromRotY = -0.9;
      model.scale.setScalar(fromScale);
      group.rotation.y = fromRotY;
      const start = performance.now(), dur = 900;
      const easeOut = (x: number) => 1 - Math.pow(1 - x, 4);
      const settle = () => {
        const k = Math.min(1, (performance.now() - start) / dur);
        const e = easeOut(k);
        model.scale.setScalar(fromScale + (targetScale - fromScale) * e);
        group.rotation.y = fromRotY + (0 - fromRotY) * e;
        render();
        if (k < 1) requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
      startLoop();
    },
    undefined,
    (err: any) => {
      console.warn('[bf] 3D load failed', err);
      setLogoStatus(`fail: ${String(err?.message || err).slice(0, 28)}`, 'error');
      showLogoFallback();
    },
  );

  // Drag to rotate.
  host.style.pointerEvents = 'auto';
  let drag: { x: number; y: number } | null = null;
  let targetRotX = 0, targetRotY = 0;
  host.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; host.setPointerCapture?.(e.pointerId); wake(); });
  host.addEventListener('pointermove', (e) => {
    if (!drag) return;
    targetRotY += (e.clientX - drag.x) / 110;
    targetRotX += (e.clientY - drag.y) / 110;
    drag = { x: e.clientX, y: e.clientY };
  });
  const endDrag = (e: PointerEvent) => { if (drag) host.releasePointerCapture?.(e.pointerId); drag = null; };
  host.addEventListener('pointerup', endDrag);
  host.addEventListener('pointercancel', endDrag);
  onThemeChange(() => { rebuildLights(THREE, scene); render(); });

  // Gated render loop: only runs while the logo is visible AND the tab is
  // focused. Auto-rotation is continuous but tiny; it parks when off-screen.
  let visible = true, running = false, raf = 0;
  function render() { renderer.render(scene, camera); }
  function frame(time: number) {
    if (!drag) targetRotY += 0.0035;
    group.rotation.y += (targetRotY - group.rotation.y) * 0.08;
    group.rotation.x += (targetRotX - group.rotation.x) * 0.08;
    group.position.y = Math.sin(time * 0.001) * 0.04;
    render();
    if (running && visible && !document.hidden) raf = requestAnimationFrame(frame);
    else { running = false; raf = 0; }
  }
  function startLoop() { running = true; if (!raf) raf = requestAnimationFrame(frame); }
  function wake() { if (visible && !document.hidden) startLoop(); }
  new IntersectionObserver((entries) => {
    visible = entries[0]?.isIntersecting ?? true;
    if (visible) wake();
  }).observe(host);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
}

function rebuildLights(THREE: any, scene: any) {
  for (let i = scene.children.length - 1; i >= 0; i--) {
    if (scene.children[i].isLight) scene.remove(scene.children[i]);
  }
  const theme = getTheme();
  scene.add(new THREE.AmbientLight(0xffffff, theme === 'light' ? 0.85 : 0.45));
  const key = new THREE.DirectionalLight(0xfff5e3, theme === 'light' ? 2.4 : 2.6);
  key.position.set(2.8, 3.4, 4.2); scene.add(key);
  const rim = new THREE.DirectionalLight(0xd9e6ff, theme === 'light' ? 0.6 : 1.2);
  rim.position.set(-3.2, -1.4, -2.6); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1a1a, theme === 'light' ? 0.5 : 0.25));
}
function themedMaterial(THREE: any) {
  const light = getTheme() === 'light';
  return new THREE.MeshStandardMaterial({ color: light ? 0x141414 : 0xf5f4f0, metalness: 0.55, roughness: 0.3 });
}
function setLogoStatus(text: string, kind?: string) {
  const el = document.getElementById('logo-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = '';
  if (text) el.classList.add('is-shown');
  if (kind === 'error') el.classList.add('is-error');
}
function showLogoFallback() { $('#logo-fallback')?.classList.add('is-shown'); }
function hideLogoFallback() { $('#logo-fallback')?.classList.remove('is-shown'); }

// ─── Modals ──────────────────────────────────────────────────────────────────
function setupModalDismiss() {
  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest?.('[data-close-modal]')) closeModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}
function openProjectModal(project: Row, sourceEl?: HTMLElement) {
  const root = $('#modal-project');
  if (!root) return;
  const photos = state.photosByProject.get(project.id) || [];
  $('.modal-cat', root)!.textContent = pickField(project, 'category') || t(`category.${project.category_key || 'other'}`);
  $('.modal-title', root)!.textContent = pickField(project, 'title');
  $('.modal-desc', root)!.textContent = pickField(project, 'description') || '';
  const media = $('.modal-media', root)!;
  media.innerHTML = '';
  const visible = photos.slice(0, 3);
  if (visible.length) {
    media.className = `modal-media cols-${visible.length}`;
    for (const ph of visible) {
      const img = document.createElement('img');
      img.alt = pickField(ph, 'alt') || pickField(project, 'title');
      img.loading = 'lazy'; img.decoding = 'async';
      const reveal = () => img.classList.add('is-loaded');
      img.addEventListener('load', reveal, { once: true });
      img.src = mediaUrl(ph.storage_path)!;
      if (img.complete) reveal();
      media.appendChild(img);
    }
  } else {
    media.className = 'modal-media';
  }
  const link = $<HTMLAnchorElement>('.modal-visit', root);
  if (link) {
    if (project.url) { link.href = project.url; link.hidden = false; }
    else { link.removeAttribute('href'); link.hidden = true; }
  }
  openModal('#modal-project', sourceEl);
}
function openContactModal() {
  const root = $('#modal-contact');
  if (!root) return;
  $('.contact-intro', root)!.textContent = pickField(state.settings.contact_intro, 'value') || '';
  const status = $('.form-status', root)!;
  status.textContent = ''; status.className = 'form-status';
  $<HTMLFormElement>('form', root)!.reset();
  openModal('#modal-contact');
  setTimeout(() => $<HTMLInputElement>('input[name=name]', root)?.focus({ preventScroll: true }), 80);
}
function openModal(sel: string, sourceEl?: HTMLElement) {
  closeModal();
  const root = $(sel);
  if (!root) return;
  root.setAttribute('aria-hidden', 'false');
  const modal = root.querySelector<HTMLElement>('.modal');
  if (modal) {
    if (sourceEl) {
      const r = sourceEl.getBoundingClientRect();
      const ox = (r.left + r.width / 2) / window.innerWidth * 100;
      const oy = (r.top + r.height / 2) / window.innerHeight * 100;
      modal.style.transformOrigin = `${ox}% ${oy}%`;
    } else {
      modal.style.transformOrigin = '';
    }
  }
  requestAnimationFrame(() => root.classList.add('is-open'));
}
function closeModal() {
  document.querySelectorAll('.modal-root.is-open').forEach((el) => {
    el.classList.remove('is-open');
    el.setAttribute('aria-hidden', 'true');
  });
}

// ─── CTA + contact form ──────────────────────────────────────────────────────
function setupCta() {
  document.querySelectorAll<HTMLElement>('[data-open-contact]').forEach((el) => {
    el.addEventListener('click', openContactModal);
  });
  $('#contact-link')?.addEventListener('click', openContactModal);
  const form = $<HTMLFormElement>('#contact-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('.form-status', form)!;
    const submitBtn = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
    const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim();
    const message = (form.elements.namedItem('message') as HTMLTextAreaElement).value.trim();
    if (!name || !email || !message) {
      status.textContent = t('contact.required'); status.className = 'form-status is-error'; return;
    }
    submitBtn.disabled = true;
    status.textContent = t('contact.sending'); status.className = 'form-status';
    const { error } = await restInsert('contact_submissions', { name, email, message, source: 'barabashflow.pl' });
    submitBtn.disabled = false;
    if (error) {
      console.error('[bf] contact insert', error);
      status.textContent = t('contact.error'); status.className = 'form-status is-error'; return;
    }
    status.textContent = t('contact.success'); status.className = 'form-status is-success';
    form.reset();
  });
}

// ─── Language switcher ───────────────────────────────────────────────────────
function setupLangSwitcher() {
  const wrap = $('.lang');
  if (!wrap) return;
  wrap.innerHTML = LOCALES.map((l) => `<button type="button" data-locale="${l}">${l}</button>`).join('');
  const updateActive = () => {
    wrap.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.locale === getLocale());
    });
  };
  wrap.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-locale]');
    if (b) setLocale(b.dataset.locale as any);
  });
  onLocaleChange(() => {
    updateActive();
    applyDom();
    renderHeader();
    for (const n of state.nodes) {
      const p = state.projects.find((pp) => pp.id === n.id);
      if (!p) continue;
      $('.node-cat', n.el)!.textContent = pickField(p, 'category') || t(`category.${p.category_key || 'other'}`);
      $('.node-title', n.el)!.textContent = pickField(p, 'title');
    }
  });
  updateActive();
}

// ─── Theme toggle ────────────────────────────────────────────────────────────
function setupThemeToggle() {
  const btn = $('#theme-toggle');
  const icon = $('#theme-icon');
  if (!btn || !icon) return;
  const moon = `<path d="M14.5 11.5a5.5 5.5 0 0 1-7-7 5.5 5.5 0 1 0 7 7Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  const sun = `<circle cx="10" cy="10" r="3.4" stroke="currentColor" stroke-width="1.4"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M10 2.5v2"/><path d="M10 15.5v2"/><path d="M2.5 10h2"/><path d="M15.5 10h2"/><path d="M4.7 4.7l1.4 1.4"/><path d="M13.9 13.9l1.4 1.4"/><path d="M4.7 15.3l1.4-1.4"/><path d="M13.9 6.1l1.4-1.4"/></g>`;
  const paint = () => { icon.innerHTML = getTheme() === 'light' ? moon : sun; };
  paint();
  btn.addEventListener('click', toggleTheme);
  onThemeChange(paint);
}

// ─── Cookie consent ──────────────────────────────────────────────────────────
const COOKIE_KEY = 'bf:cookies-accepted';
function setupCookieConsent() {
  const bot = $('#cookie-bot');
  if (!bot) return;
  try { if (localStorage.getItem(COOKIE_KEY) === '1') return; } catch {}
  const acceptBtn = $('#cookie-accept');
  const policyBtn = $('#cookie-policy-open');
  const closeBtn = bot.querySelector<HTMLElement>('[data-cookie-close]');
  const open = () => { bot.setAttribute('aria-hidden', 'false'); bot.classList.add('is-open'); };
  const close = () => { bot.classList.remove('is-open'); setTimeout(() => bot.setAttribute('aria-hidden', 'true'), 520); };
  const accept = () => { try { localStorage.setItem(COOKIE_KEY, '1'); } catch {} close(); };
  acceptBtn?.addEventListener('click', accept);
  closeBtn?.addEventListener('click', close);
  policyBtn?.addEventListener('click', () => openModal('#modal-cookies'));
  setTimeout(open, 1400);
}

// ─── Mascot bot ──────────────────────────────────────────────────────────────
const MASCOT_OPEN_DELAY_MS = 60000;
const MASCOT_DISMISS_KEY = 'bf:mascot-dismissed';
function setupMascotBot() {
  const root = $('#mascot-bot');
  if (!root) return;
  const greetingEl = $('#mascot-greeting')!;
  const qInput = $<HTMLInputElement>('#mascot-q')!;
  const emailInput = $<HTMLInputElement>('#mascot-email')!;
  const sendBtn = $<HTMLButtonElement>('#mascot-send')!;
  const statusEl = $('#mascot-status')!;
  const closeBtn = root.querySelector<HTMLElement>('[data-mascot-close]');
  const stageAsk = root.querySelector<HTMLElement>('[data-stage="ask"]')!;
  const stageDone = root.querySelector<HTMLElement>('[data-stage="done"]')!;
  const successTitle = $('#mascot-success-title')!;
  const successText = $('#mascot-success-text')!;
  const form = $<HTMLFormElement>('#mascot-form')!;

  const fallback: Record<string, string> = {
    greeting: 'Cześć — w czym mogę pomóc?',
    q_placeholder: 'Napisz swoje pytanie…',
    email_placeholder: 'Twój e-mail',
    submit: 'Wyślij',
    success_title: 'Pytanie wysłane',
    success_text: 'Odpowiem najszybciej jak to możliwe.',
  };
  const getStr = (k: string) => pickField(state.settings[`mascot_${k}`], 'value') || fallback[k];

  let typingTimer: any = 0;
  let isOpen = false;
  function typewrite(el: HTMLElement, text: string, speed = 24, done?: () => void) {
    clearInterval(typingTimer);
    el.textContent = '';
    let i = 0;
    typingTimer = setInterval(() => {
      el.textContent = text.slice(0, ++i);
      if (i >= text.length) { clearInterval(typingTimer); typingTimer = 0; done?.(); }
    }, speed);
  }
  function applyAskStrings() {
    qInput.placeholder = getStr('q_placeholder');
    emailInput.placeholder = getStr('email_placeholder');
    sendBtn.textContent = getStr('submit');
    greetingEl.classList.remove('is-done');
    typewrite(greetingEl, getStr('greeting'), 26, () => greetingEl.classList.add('is-done'));
  }
  function applyDoneStrings() {
    successTitle.textContent = ''; successText.textContent = '';
    typewrite(successTitle, getStr('success_title'), 22, () => {
      setTimeout(() => typewrite(successText, getStr('success_text'), 18), 120);
    });
  }
  function openBot() {
    if (isOpen) return;
    try { if (sessionStorage.getItem(MASCOT_DISMISS_KEY) === '1') return; } catch {}
    isOpen = true;
    root.setAttribute('aria-hidden', 'false');
    root.classList.add('is-open');
    setTimeout(applyAskStrings, 360);
  }
  function closeBot() {
    if (!isOpen) return;
    isOpen = false;
    root.classList.remove('is-open');
    clearInterval(typingTimer);
    setTimeout(() => root.setAttribute('aria-hidden', 'true'), 520);
    try { sessionStorage.setItem(MASCOT_DISMISS_KEY, '1'); } catch {}
  }
  closeBtn?.addEventListener('click', closeBot);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) closeBot(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = qInput.value.trim(), email = emailInput.value.trim();
    if (!q || !email) { statusEl.textContent = t('contact.required'); statusEl.className = 'mascot-status is-error'; return; }
    sendBtn.disabled = true;
    statusEl.textContent = t('contact.sending'); statusEl.className = 'mascot-status';
    const { error } = await restInsert('contact_submissions', { name: 'Mascot bot', email, message: q, source: 'mascot-bot' });
    sendBtn.disabled = false;
    if (error) { console.error('[bf] mascot insert', error); statusEl.textContent = t('contact.error'); statusEl.className = 'mascot-status is-error'; return; }
    statusEl.textContent = '';
    stageAsk.hidden = true; stageDone.hidden = false;
    applyDoneStrings();
    try { sessionStorage.setItem(MASCOT_DISMISS_KEY, '1'); } catch {}
  });
  onLocaleChange(() => { if (!isOpen) return; if (stageDone.hidden) applyAskStrings(); else applyDoneStrings(); });
  setTimeout(openBot, MASCOT_OPEN_DELAY_MS);
}

// ─── Pan hint + tab-away prank ───────────────────────────────────────────────
function setupPanHint() {
  const hint = $('#graph-pan-hint');
  if (hint) setTimeout(() => hint.classList.add('is-visible'), 1600);
}
function setupTabAway() {
  const original = document.title;
  const lines = [
    'Hej… wróć tu na chwilę', 'Dokąd uciekasz?', 'Bez ciebie tu pusto…',
    'Zaraz, mam coś dla ciebie', 'Tutaj jest ciekawiej, obiecuję', 'Piksele tęsknią',
    'Wróć — projekty się nudzą', 'Nie zapomnij o mnie', 'Czekam. Cierpliwie.',
    'Klik z powrotem', 'Kawa stygnie, wracaj',
  ];
  let last = -1, cycler: any = 0;
  const pick = () => { let i; do { i = Math.floor(Math.random() * lines.length); } while (i === last); last = i; return lines[i]; };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      document.title = pick();
      clearInterval(cycler);
      cycler = setInterval(() => { document.title = pick(); }, 6000);
    } else {
      clearInterval(cycler); cycler = 0; document.title = original;
    }
  });
}

// ─── Utils ───────────────────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
