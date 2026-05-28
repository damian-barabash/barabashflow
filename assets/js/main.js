import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { SUPABASE_URL, SUPABASE_ANON_KEY, mediaUrl } from './supabase-config.js?v=2026-05-28d';
import {
  LOCALES, getLocale, setLocale, onLocaleChange,
  t, pickField, applyDom,
} from './i18n.js?v=2026-05-28d';
import { getTheme, toggleTheme, onThemeChange } from './theme.js?v=2026-05-28d';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  settings: {},
  projects: [],
  photosByProject: new Map(),
  connections: [],
  nodes: [],          // { id, el, baseX, baseY, phase, dragging }
  stage: null,
  edgeSvg: null,
  resizeRaf: 0,
  globalT: 0,
};

// ═══════════════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════════════

init().catch((err) => console.error('[main] init failed', err));

async function init() {
  state.stage = $('.stage');
  state.stageInner = $('#stage-inner');
  state.edgeSvg = $('#graph-edges');
  state.viewZoom = 1;
  state.viewPanX = 0;
  state.viewPanY = 0;

  setupLangSwitcher();
  setupThemeToggle();
  setupCta();
  setupModalDismiss();
  setupTabAway();

  applyDom();
  startAnimationLoop();           // start RAF early so transitions feel alive
  // Skip mouse-centric effects on touch devices — looks broken without a cursor.
  state.isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (!state.isTouch) setupParallax();

  // Three.js is best-effort — never block the rest of the page on it
  try { start3DLogo(); }
  catch (err) { console.warn('[main] 3D logo disabled', err); showLogoFallback(); }

  await loadData();
  renderHeader();
  renderNodes();
  bindNodeInteractions();
  setupViewZoomPan();
  setupMascotBot();
  setupCookieConsent();

  // Trigger cinematic entrance.
  // Two frames so the first paint settles before keyframes start.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.classList.remove('is-loading');
  }));

  window.addEventListener('resize', onResize);
}

// ═══════════════════════════════════════════════════════════════════════════
// Data
// ═══════════════════════════════════════════════════════════════════════════

async function loadData() {
  // Use the REST endpoint directly — lighter than the supabase-js client and
  // avoids the persistSession/auth-channel overhead on first paint.
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
  const base = `${SUPABASE_URL}/rest/v1`;
  const get = (path) =>
    fetch(`${base}/${path}`, { headers })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .catch((err) => { console.warn('[main] fetch failed', path, err); return []; });

  try {
    const [settings, projects, photos, edges] = await Promise.all([
      get('site_settings?select=*'),
      get('projects?select=*&is_published=eq.true&order=sort_order.asc'),
      get('project_photos?select=*&order=sort_order.asc'),
      get('project_connections?select=*'),
    ]);
    state.settings = Object.fromEntries((settings || []).map((r) => [r.key, r]));
    state.projects = projects || [];
    state.photosByProject.clear();
    for (const ph of photos || []) {
      if (!state.photosByProject.has(ph.project_id)) state.photosByProject.set(ph.project_id, []);
      state.photosByProject.get(ph.project_id).push(ph);
    }
    state.connections = edges || [];
    console.log(`[bf:data] loaded ${state.projects.length} projects, ${Object.keys(state.settings).length} settings`);
  } catch (err) {
    console.error('[main] loadData failed', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Header
// ═══════════════════════════════════════════════════════════════════════════

function renderHeader() {
  const heroTitleEl = $('#hero-title');
  const heroSubEl = $('#hero-sub');
  const portrait = $('#owner-portrait');

  const title = pickField(state.settings.hero_title, 'value');
  if (title) {
    heroTitleEl.innerHTML = styleHeroTitle(title);
  }
  const sub = pickField(state.settings.hero_subtitle, 'value');
  heroSubEl.textContent = sub || '';

  const photoPath = state.settings.owner_photo_path?.value_meta?.path;
  if (photoPath) {
    portrait.style.backgroundImage = `url("${mediaUrl(photoPath)}")`;
    portrait.removeAttribute('data-empty');
  } else {
    portrait.style.backgroundImage = '';
    portrait.setAttribute('data-empty', 'true');
  }

  const ctaLabelEl = $('.cta-label');
  const ctaLabel = pickField(state.settings.cta_label, 'value');
  if (ctaLabel) ctaLabelEl.textContent = ctaLabel;
}

/* Soften the hero by italicising the conjunction (i/and/и) so the line breathes. */
function styleHeroTitle(text) {
  const conj = { pl: ' i ', en: ' and ', ru: ' и ' };
  const c = conj[getLocale()] || ' ';
  const idx = text.toLowerCase().indexOf(c);
  if (idx === -1) return escapeHtml(text);
  return (
    escapeHtml(text.slice(0, idx)) +
    `<em>${escapeHtml(text.slice(idx, idx + c.length))}</em>` +
    escapeHtml(text.slice(idx + c.length))
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Graph nodes (with drag)
// ═══════════════════════════════════════════════════════════════════════════

function renderNodes() {
  for (const n of state.nodes) n.el.remove();
  state.nodes = [];

  const projects = state.projects;
  if (!projects.length) { redrawEdges(); return; }

  applyGraphScale(projects.length);

  // Use admin-saved positions verbatim (mobile too). autoLayout only fires
  // when nothing has been positioned yet (fresh project set).
  const allZero = projects.every((p) => p.position_x === 0 && p.position_y === 0);
  if (allZero) autoLayout(projects);

  const frag = document.createDocumentFragment();
  projects.forEach((p, i) => {
    const el = buildNodeEl(p, i);
    frag.appendChild(el);
    const bx = clampUnit(p.position_x);
    const by = clampUnit(p.position_y);
    state.nodes.push({
      id: p.id,
      el,
      baseX: bx,
      baseY: by,
      targetX: bx,                  // ease toward this each frame (set by repulsion)
      targetY: by,
      phase: i * 0.9,
      dragging: false,
    });
  });
  state.stageInner.appendChild(frag);

  // Auto-fit: pick an initial view-zoom so the farthest project sits inside
  // the viewport. User can still wheel/pan past it.
  applyAutoFit();

  positionNodes(state.globalT || 0);
  redrawEdges();
}

function applyAutoFit() {
  if (state.userViewSet) return;          // respect manual zoom/pan if user touched it

  const stageRect = state.stage?.getBoundingClientRect();
  if (!stageRect || !stageRect.width || !stageRect.height) return;

  // Measure actual node bounds so the auto-fit accounts for node size, not
  // just position. Without this we'd clip the outermost node off-screen.
  const firstNode = state.nodes[0]?.el;
  const nodeRect  = firstNode?.getBoundingClientRect();
  const nodeW = nodeRect?.width  || 158;
  const nodeH = nodeRect?.height || 144;

  let maxAbsX = 0.001, maxAbsY = 0.001;
  for (const n of state.nodes) {
    maxAbsX = Math.max(maxAbsX, Math.abs(n.baseX));
    maxAbsY = Math.max(maxAbsY, Math.abs(n.baseY));
  }

  const m = stageMetrics();
  // Pixel extent from center to outermost node center, plus node half-size
  // (so the node body fits in viewport, not just its center point).
  // Larger padding on phones — admin positions are tuned for wide desktop
  // stages and would otherwise crowd against the viewport edges on portrait.
  const isMobile = window.innerWidth <= 760;
  const padding = isMobile ? 32 : 16;
  const extentX = maxAbsX * m.halfW + nodeW / 2 + padding;
  const extentY = maxAbsY * m.halfH + nodeH / 2 + padding;

  const fitX = (stageRect.width  / 2) / extentX;
  const fitY = (stageRect.height / 2) / extentY;
  // Smaller safety margin now that nodes themselves shrink on mobile via
  // applyGraphScale — too much extra zoom-out makes them illegibly tiny.
  const safety = isMobile ? 0.94 : 1;
  let fit = Math.max(0.22, Math.min(1, Math.min(fitX, fitY) * safety));

  state.viewZoom = fit;
  state.viewPanX = 0;
  state.viewPanY = 0;
  applyViewTransform();
}

function applyViewTransform() {
  if (!state.stageInner) return;
  state.stageInner.style.setProperty('--view-zoom', state.viewZoom.toFixed(3));
  state.stageInner.style.setProperty('--view-pan-x', `${state.viewPanX.toFixed(1)}px`);
  state.stageInner.style.setProperty('--view-pan-y', `${state.viewPanY.toFixed(1)}px`);
  const ind = $('#zoom-indicator');
  if (ind) {
    ind.textContent = `${Math.round(state.viewZoom * 100)}%`;
    ind.classList.add('is-visible');
    clearTimeout(state._zoomIndTimer);
    state._zoomIndTimer = setTimeout(
      () => ind.classList.remove('is-visible'), 900,
    );
  }
}

// Pull the camera back as more projects join the graph.
function applyGraphScale(n) {
  const root = document.documentElement;
  // 1..4 projects → 1.0 ; 8 → 0.80 ; 12 → 0.65 ; 16+ → 0.55
  let scale = Math.max(0.55, Math.min(1, 1 - Math.max(0, n - 4) * 0.045));
  // Portrait phones get a much stronger shrink — admin coords are tuned for
  // a wide landscape stage and on a narrow portrait viewport they crowd.
  // Smaller nodes = more relative whitespace between them at the same
  // normalized positions.
  const narrow   = window.innerWidth <= 760;
  const portrait = window.innerHeight > window.innerWidth;
  let logoFactor = 1;
  if (narrow && portrait) {
    const mobileShrink = Math.max(0.45, 1 - Math.max(0, n - 3) * 0.075);
    scale *= mobileShrink;
    // Pull the centre logo down further than nodes so it stops eating the
    // ring's interior space on a phone-sized stage.
    logoFactor = 0.72;
  }
  root.style.setProperty('--node-w',       `${Math.round(158 * scale)}px`);
  root.style.setProperty('--node-h',       `${Math.round(144 * scale)}px`);
  root.style.setProperty('--node-thumb-h', `${Math.round(88  * scale)}px`);
  root.style.setProperty('--logo-d',       `${Math.round(296 * scale * logoFactor)}px`);
}

function autoLayout(projects) {
  const n = projects.length;
  const portrait = window.innerHeight > window.innerWidth;
  const narrow   = window.innerWidth <= 760;

  let radiusX, radiusY;
  if (narrow && portrait && n >= 2) {
    // Portrait phones: derive a TRUE pixel-circle radius from node size so
    // adjacent chord length (2r·sin(π/n)) is large enough to clear the node
    // diagonal. The ring may overflow the stage in pixels — applyAutoFit
    // then zooms out to bring everything into view.
    const m = stageMetrics();
    const cs = getComputedStyle(document.documentElement);
    const nodeW = parseFloat(cs.getPropertyValue('--node-w')) || 128;
    const nodeH = parseFloat(cs.getPropertyValue('--node-h')) || 118;
    // Nodes are axis-aligned rectangles, not tangent to the ring, so using
    // the diagonal over-spaces them. The larger side + a small buffer is
    // enough for visual clearance at any angle.
    const minChord = Math.max(nodeW, nodeH) + 10;
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

function buildNodeEl(p, index = 0) {
  const el = document.createElement('div');
  el.className = 'node';
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.dataset.projectId = p.id;
  if (p.accent_color) el.style.setProperty('--node-accent', p.accent_color);

  // Stagger the entrance — first node lands at 0.55s, each next +0.07s.
  el.style.animationDelay = `${0.55 + index * 0.07}s`;

  const catLabel = pickField(p, 'category') || t(`category.${p.category_key || 'other'}`);
  el.innerHTML = `
    <div class="node-thumb" data-empty="true"></div>
    <div class="node-body">
      <span class="node-cat"></span>
      <span class="node-title"></span>
    </div>
  `;

  const photos = state.photosByProject.get(p.id) || [];
  if (photos[0]?.storage_path) {
    const thumb = $('.node-thumb', el);
    thumb.style.backgroundImage = `url("${mediaUrl(photos[0].storage_path)}")`;
    thumb.style.backgroundSize = 'cover';
    thumb.removeAttribute('data-empty');
  }

  $('.node-cat', el).textContent = catLabel;
  $('.node-title', el).textContent = pickField(p, 'title');
  el.setAttribute('aria-label', pickField(p, 'title'));
  return el;
}

function clampUnit(v) {
  if (Number.isFinite(v)) return Math.max(-1, Math.min(1, v));
  return 0;
}

function stageMetrics() {
  const rect = state.stage.getBoundingClientRect();
  // tighter padding → more room → existing baseX/baseY render further from center
  const padX = Math.min(rect.width * 0.04, 64);
  const padY = Math.min(rect.height * 0.06, 56);
  return {
    rect,
    cx: rect.width / 2,
    cy: rect.height / 2,
    halfW: rect.width / 2 - padX,
    halfH: rect.height / 2 - padY,
  };
}

function nodeWorldPos(node, time) {
  const m = stageMetrics();
  // Bobbing only when the node isn't being dragged.
  const wobble = node.dragging ? 0 : 1;
  const bobX = Math.sin(time * 0.0006 + node.phase) * 5 * wobble;
  const bobY = Math.cos(time * 0.00075 + node.phase * 1.2) * 5 * wobble;
  return {
    x: m.cx + node.baseX * m.halfW + bobX,
    y: m.cy + node.baseY * m.halfH + bobY,
  };
}

function positionNodes(time) {
  for (const n of state.nodes) {
    const p = nodeWorldPos(n, time);
    n.el.style.left = `${p.x}px`;
    n.el.style.top  = `${p.y}px`;
  }
}

// Smooth repulsion: every frame we re-compute idempotent TARGETS for any
// overlapping pair. Targets describe where each node *should* be to be clear
// of its neighbour; the animation loop then eases baseX/Y → targetX/Y, so the
// motion always looks like the node is gracefully sliding into place.
// - Idle pair: both targets pushed symmetrically around their midpoint.
// - One dragged: dragger is anchored to the cursor (target = cursor); the
//   other's target moves just outside the dragger's rect.
// - Both dragged: skip (multi-touch).
function applyRepulsion() {
  const ns = state.nodes;
  if (ns.length < 2) return;
  const firstRect = ns[0].el.getBoundingClientRect();
  const nw = firstRect.width  || 158;
  const nh = firstRect.height || 144;
  const pad = 28;
  const m   = stageMetrics();

  const pos = ns.map((n) => ({
    n,
    x: m.cx + n.baseX * m.halfW,
    y: m.cy + n.baseY * m.halfH,
  }));

  for (let i = 0; i < pos.length; i++) {
    for (let j = i + 1; j < pos.length; j++) {
      const iDrag = pos[i].n.dragging;
      const jDrag = pos[j].n.dragging;
      if (iDrag && jDrag) continue;

      const dx = pos[j].x - pos[i].x;
      const dy = pos[j].y - pos[i].y;
      const overlapX = (nw + pad) - Math.abs(dx);
      const overlapY = (nh + pad) - Math.abs(dy);
      if (overlapX <= 0 || overlapY <= 0) continue;

      const anyDrag = iDrag || jDrag;

      if (!anyDrag) {
        // Symmetric clear-distance target around the midpoint.
        if (overlapX < overlapY) {
          const sign     = dx < 0 ? -1 : 1;
          const mid      = (pos[i].x + pos[j].x) / 2;
          const halfSpan = (nw + pad) / 2 + 1;
          pos[i].n.targetX = clampUnit((mid - sign * halfSpan - m.cx) / Math.max(m.halfW, 1));
          pos[j].n.targetX = clampUnit((mid + sign * halfSpan - m.cx) / Math.max(m.halfW, 1));
        } else {
          const sign     = dy < 0 ? -1 : 1;
          const mid      = (pos[i].y + pos[j].y) / 2;
          const halfSpan = (nh + pad) / 2 + 1;
          pos[i].n.targetY = clampUnit((mid - sign * halfSpan - m.cy) / Math.max(m.halfH, 1));
          pos[j].n.targetY = clampUnit((mid + sign * halfSpan - m.cy) / Math.max(m.halfH, 1));
        }
      } else {
        // The dragged node is anchored to the cursor. Set the OTHER node's
        // target just outside the dragger on the smaller-overlap axis.
        const dragger = iDrag ? pos[i] : pos[j];
        const flee    = iDrag ? pos[j] : pos[i];
        const ddx = flee.x - dragger.x;
        const ddy = flee.y - dragger.y;
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

// Critically-damped lerp toward targets. k controls how snappy: smaller =
// floatier "looking-for-its-place" motion; larger = more immediate.
function smoothNodes() {
  const k = 0.14;
  for (const n of state.nodes) {
    if (n.dragging) continue;
    const dx = n.targetX - n.baseX;
    const dy = n.targetY - n.baseY;
    // Skip work below visual noise floor.
    if (Math.abs(dx) < 0.0005 && Math.abs(dy) < 0.0005) continue;
    n.baseX = clampUnit(n.baseX + dx * k);
    n.baseY = clampUnit(n.baseY + dy * k);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Edges (SVG)
// ═══════════════════════════════════════════════════════════════════════════

function redrawEdges() {
  const svg = state.edgeSvg;
  svg.innerHTML = '';
  if (!state.nodes.length) return;

  const m = stageMetrics();
  svg.setAttribute('viewBox', `0 0 ${m.rect.width} ${m.rect.height}`);

  for (const n of state.nodes) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'edge is-center');
    path.dataset.from = '__center__';
    path.dataset.to = n.id;
    svg.appendChild(path);
  }
  for (const e of state.connections) {
    if (!state.nodes.some((n) => n.id === e.from_project_id)) continue;
    if (!state.nodes.some((n) => n.id === e.to_project_id)) continue;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'edge');
    path.dataset.from = e.from_project_id;
    path.dataset.to = e.to_project_id;
    svg.appendChild(path);
  }
  updateEdges(state.globalT || 0);
}

function updateEdges(time) {
  const svg = state.edgeSvg;
  if (!svg) return;
  const m = stageMetrics();
  const paths = svg.querySelectorAll('path.edge');
  const cache = new Map();
  const getPos = (id) => {
    if (id === '__center__') return { x: m.cx, y: m.cy };
    if (cache.has(id)) return cache.get(id);
    const n = state.nodes.find((nn) => nn.id === id);
    if (!n) return null;
    const p = nodeWorldPos(n, time);
    cache.set(id, p);
    return p;
  };

  paths.forEach((path) => {
    const a = getPos(path.dataset.from);
    const b = getPos(path.dataset.to);
    if (!a || !b) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const offset = Math.min(len * 0.08, 36);
    const nx = -dy / len;
    const ny = dx / len;
    const wob = 0.4 + 0.6 * (Math.sin(time * 0.0008 + (a.x + b.x) * 0.001) * 0.5 + 0.5);
    const ox = mx + nx * offset * wob;
    const oy = my + ny * offset * wob;
    path.setAttribute('d', `M ${a.x} ${a.y} Q ${ox} ${oy} ${b.x} ${b.y}`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Node interactions — click vs drag
// ═══════════════════════════════════════════════════════════════════════════

const DRAG_THRESHOLD = 5; // px before pointermove escalates to a drag

function bindNodeInteractions() {
  if (!state.isTouch) ensureNodeHint();
  for (const n of state.nodes) {
    bindNodeDrag(n);
    if (!state.isTouch) {
      bindMagneticHover(n);
      bindNodeHint(n);
    }
  }
}

// Cursor-following hint label. Desktop only — CSS also hides it on touch
// devices as a defensive fallback.
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

function bindNodeHint(node) {
  const el = node.el;
  const show = (e) => {
    if (node.dragging || !state.nodeHint) return;
    state.nodeHint.style.left = `${e.clientX}px`;
    state.nodeHint.style.top  = `${e.clientY}px`;
    state.nodeHint.classList.add('is-visible');
  };
  const hide = () => state.nodeHint?.classList.remove('is-visible');
  el.addEventListener('pointerenter', show);
  el.addEventListener('pointermove',  show);
  el.addEventListener('pointerleave', hide);
  el.addEventListener('pointerdown',  hide);   // hide once interaction starts
}

// Subtle magnetic pull toward the cursor while hovering. Disabled during
// drag (drag bypasses this transform layer via .is-dragging).
function bindMagneticHover(node) {
  const el = node.el;
  let centerX = 0, centerY = 0;
  const update = (e) => {
    if (node.dragging) return;
    const dx = (e.clientX - centerX) * 0.14;
    const dy = (e.clientY - centerY) * 0.14;
    el.style.setProperty('--mag-x', `${dx}px`);
    el.style.setProperty('--mag-y', `${dy}px`);
  };
  el.addEventListener('pointerenter', (e) => {
    const r = el.getBoundingClientRect();
    centerX = r.left + r.width / 2;
    centerY = r.top + r.height / 2;
    update(e);
  });
  el.addEventListener('pointermove', update);
  el.addEventListener('pointerleave', () => {
    el.style.setProperty('--mag-x', '0px');
    el.style.setProperty('--mag-y', '0px');
  });
}

// Wheel-zoom + click-drag pan on the stage. The whole .stage-inner is
// transformed via CSS vars (--view-zoom, --view-pan-x, --view-pan-y) so
// node positions and edges stay in unscaled coords — drag math just has to
// account for the zoom factor.
function setupViewZoomPan() {
  const stage = state.stage;
  if (!stage) return;
  const inner = state.stageInner;

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    inner.classList.add('is-interacting');
    state.userViewSet = true;
    const factor = Math.exp(-e.deltaY * 0.0015);
    state.viewZoom = Math.max(0.25, Math.min(3.0, state.viewZoom * factor));
    applyViewTransform();
    clearTimeout(state._zoomReleaseTimer);
    state._zoomReleaseTimer = setTimeout(
      () => inner.classList.remove('is-interacting'), 200,
    );
  }, { passive: false });

  let panning = false;
  let panStartX = 0, panStartY = 0;
  let originPanX = 0, originPanY = 0;
  let panPid = null;

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.node')) return;          // nodes own their drag
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    panning = true;
    panPid = e.pointerId;
    panStartX = e.clientX; panStartY = e.clientY;
    originPanX = state.viewPanX; originPanY = state.viewPanY;
    stage.setPointerCapture(panPid);
    stage.classList.add('is-panning');
    inner.classList.add('is-interacting');
    state.userViewSet = true;
  });
  stage.addEventListener('pointermove', (e) => {
    if (!panning || e.pointerId !== panPid) return;
    state.viewPanX = originPanX + (e.clientX - panStartX);
    state.viewPanY = originPanY + (e.clientY - panStartY);
    applyViewTransform();
  });
  const endPan = (e) => {
    if (!panning || (panPid !== null && e && e.pointerId !== panPid)) return;
    panning = false;
    stage.releasePointerCapture?.(panPid);
    panPid = null;
    stage.classList.remove('is-panning');
    setTimeout(() => inner.classList.remove('is-interacting'), 180);
  };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);

  // ── Pinch-to-zoom (two fingers) ──────────────────────────────────────
  // pointer events don't expose multi-touch gesture cleanly, so use raw
  // touch events. When a second finger lands we cancel single-finger pan
  // and switch to pinch mode; on touchend we hand control back.
  let pinchDistStart = 0;
  let pinchZoomStart = 1;
  const dist = (ts) => Math.hypot(
    ts[0].clientX - ts[1].clientX,
    ts[0].clientY - ts[1].clientY,
  );

  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      // kill any active single-finger pan
      if (panning) endPan({ pointerId: panPid });
      pinchDistStart = dist(e.touches);
      pinchZoomStart = state.viewZoom;
      state.userViewSet = true;
      inner.classList.add('is-interacting');
    }
  }, { passive: false });

  stage.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchDistStart > 0) {
      e.preventDefault();
      const d = dist(e.touches);
      const factor = d / pinchDistStart;
      state.viewZoom = Math.max(0.25, Math.min(3.0, pinchZoomStart * factor));
      applyViewTransform();
    }
  }, { passive: false });

  const endPinch = () => {
    if (pinchDistStart > 0) {
      pinchDistStart = 0;
      setTimeout(() => inner.classList.remove('is-interacting'), 180);
    }
  };
  stage.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) endPinch();
  });
  stage.addEventListener('touchcancel', endPinch);
}

// Wide-screen mouse parallax — the whole stage drifts a few pixels with
// the cursor, giving the graph a sense of depth.
function setupParallax() {
  const target = { x: 0, y: 0 };
  const current = { x: 0, y: 0 };
  const maxShift = 12;

  document.addEventListener('mousemove', (e) => {
    if (!state.stage) return;
    const nx = (e.clientX / window.innerWidth - 0.5) * 2;   // −1..1
    const ny = (e.clientY / window.innerHeight - 0.5) * 2;
    target.x = -nx * maxShift;
    target.y = -ny * maxShift;
  });

  function loop() {
    current.x += (target.x - current.x) * 0.06;
    current.y += (target.y - current.y) * 0.06;
    if (state.stage) {
      state.stage.style.setProperty('--par-x', `${current.x.toFixed(2)}px`);
      state.stage.style.setProperty('--par-y', `${current.y.toFixed(2)}px`);
    }
    requestAnimationFrame(loop);
  }
  loop();
}

function bindNodeDrag(node) {
  const el = node.el;
  let pid = null;
  let startX = 0, startY = 0;
  let down = false;
  let escalated = false;
  let originLeft = 0, originTop = 0;
  let originPointerX = 0, originPointerY = 0;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.stopPropagation();   // don't bubble into stage pan handler
    pid = e.pointerId;
    down = true;
    escalated = false;
    startX = e.clientX;
    startY = e.clientY;
    originPointerX = e.clientX;
    originPointerY = e.clientY;
    // Use the unscaled inline left/top as origin (robust under view-zoom).
    originLeft = parseFloat(el.style.left) || 0;
    originTop  = parseFloat(el.style.top)  || 0;
    el.setPointerCapture(pid);
  });

  el.addEventListener('pointermove', (e) => {
    if (!down || e.pointerId !== pid) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!escalated && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      escalated = true;
      node.dragging = true;
      el.classList.add('is-dragging');
    }
    if (!escalated) return;

    // Screen-space pointer delta → unscaled stage delta (view-zoom aware).
    const z = state.viewZoom || 1;
    const m = stageMetrics();
    const nextLeft = originLeft + (e.clientX - originPointerX) / z;
    const nextTop  = originTop  + (e.clientY - originPointerY) / z;
    const bx = clampUnit((nextLeft - m.cx) / Math.max(m.halfW, 1));
    const by = clampUnit((nextTop  - m.cy) / Math.max(m.halfH, 1));
    node.baseX = node.targetX = bx;
    node.baseY = node.targetY = by;
  });

  const finish = (e) => {
    if (!down || (pid !== null && e && e.pointerId !== pid)) return;
    down = false;
    el.releasePointerCapture?.(pid);
    pid = null;
    const wasDrag = escalated;
    node.dragging = false;
    el.classList.remove('is-dragging');
    if (!wasDrag) {
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

// ═══════════════════════════════════════════════════════════════════════════
// 3D logo (Three.js) — fetch-then-parse pipeline with a visible on-page
// status line so failures don't disappear into the console.
// ═══════════════════════════════════════════════════════════════════════════

function start3DLogo() {
  const host = $('#logo-stage');
  if (!host) return;
  setLogoStatus('init');

  // 1. Probe WebGL.
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2') || probe.getContext('webgl');
  if (!gl) {
    setLogoStatus('no webgl', 'error');
    showLogoFallback();
    return;
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
  } catch (err) {
    setLogoStatus('renderer fail', 'error');
    console.warn('[bf:3d] WebGLRenderer failed', err);
    showLogoFallback();
    return;
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

  rebuildLights(scene);

  const group = new THREE.Group();
  scene.add(group);

  const resize = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  new ResizeObserver(resize).observe(host);

  // 2. Loader pipeline: try fetch + parse for each candidate URL.
  const candidates = collectGlbUrls();
  console.log('[bf:3d] candidates', candidates);
  setLogoStatus('fetching');

  fetchAndParseGlb(candidates).then(
    ({ gltf, url, bytes }) => {
      console.log(`[bf:3d] parsed ${url} (${bytes} B)`);
      const model = gltf.scene;

      // Ensure every mesh has normals; otherwise PBR will look flat-black.
      let meshCount = 0;
      model.traverse((obj) => {
        if (!obj.isMesh) return;
        meshCount += 1;
        if (!obj.geometry.attributes.normal) {
          obj.geometry.computeVertexNormals();
        }
        // If a mesh somehow has no material (rare), give it one.
        if (!obj.material) obj.material = themedMaterial();
        obj.castShadow = false;
        obj.receiveShadow = false;
      });

      if (meshCount === 0) {
        setLogoStatus('no meshes', 'error');
        showLogoFallback();
        return;
      }

      // Fit + center
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const targetScale = 2.4 / maxDim;
      model.scale.setScalar(targetScale);
      const center = box.getCenter(new THREE.Vector3()).multiplyScalar(-targetScale);
      model.position.copy(center);

      group.add(model);
      hideLogoFallback();
      setLogoStatus(`${meshCount} mesh${meshCount > 1 ? 'es' : ''}`);
      setTimeout(() => setLogoStatus(''), 1500);

      // "Settle" animation: a satisfying landing for the freshly loaded model.
      const fromScale = targetScale * 0.72;
      const fromRotY  = -0.9;
      model.scale.setScalar(fromScale);
      group.rotation.y = fromRotY;
      const start = performance.now();
      const duration = 900;
      const easeOut = (t) => 1 - Math.pow(1 - t, 4);
      const tick = () => {
        const k = Math.min(1, (performance.now() - start) / duration);
        const e = easeOut(k);
        model.scale.setScalar(fromScale + (targetScale - fromScale) * e);
        group.rotation.y = fromRotY + (0 - fromRotY) * e;
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    (err) => {
      console.warn('[bf:3d] load pipeline failed', err);
      setLogoStatus(`fail: ${(err?.message || err).toString().slice(0, 28)}`, 'error');
      showLogoFallback();
    },
  );

  // Pointer interaction — drag to rotate.
  host.style.pointerEvents = 'auto';
  let drag = null;
  let targetRotX = 0, targetRotY = 0;
  host.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    host.setPointerCapture?.(e.pointerId);
  });
  host.addEventListener('pointermove', (e) => {
    if (!drag) return;
    targetRotY += (e.clientX - drag.x) / 110;
    targetRotX += (e.clientY - drag.y) / 110;
    drag = { x: e.clientX, y: e.clientY };
  });
  const endDrag = (e) => {
    if (drag) host.releasePointerCapture?.(e.pointerId);
    drag = null;
  };
  host.addEventListener('pointerup', endDrag);
  host.addEventListener('pointercancel', endDrag);

  onThemeChange(() => {
    rebuildLights(scene);
  });

  state.tickThree = (t) => {
    if (!drag) targetRotY += 0.0035;
    group.rotation.y += (targetRotY - group.rotation.y) * 0.08;
    group.rotation.x += (targetRotX - group.rotation.x) * 0.08;
    group.position.y = Math.sin(t * 0.001) * 0.04;
    renderer.render(scene, camera);
  };
}

function collectGlbUrls() {
  const list = [];
  try { list.push(new URL('../3d/LOGO_3D_BF.glb', import.meta.url).href); } catch {}
  try { list.push(new URL('assets/3d/LOGO_3D_BF.glb', document.baseURI).href); } catch {}
  list.push('assets/3d/LOGO_3D_BF.glb');
  // de-duplicate
  return [...new Set(list)];
}

async function fetchAndParseGlb(urls) {
  let lastErr;
  for (const url of urls) {
    try {
      setLogoStatus('fetching');
      console.log('[bf:3d] fetch', url);
      const resp = await fetch(url, { cache: 'force-cache' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      setLogoStatus('parsing');
      const loader = new GLTFLoader();
      const gltf = await new Promise((resolve, reject) => {
        loader.parse(buf, '', resolve, reject);
      });
      return { gltf, url, bytes: buf.byteLength };
    } catch (err) {
      console.warn('[bf:3d] candidate failed', url, err?.message || err);
      lastErr = err;
    }
  }
  throw lastErr || new Error('no candidate succeeded');
}

function setLogoStatus(text, kind) {
  const el = document.getElementById('logo-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = '';
  if (text) el.classList.add('is-shown');
  if (kind === 'error') el.classList.add('is-error');
}

function rebuildLights(scene) {
  // Strip existing lights
  for (let i = scene.children.length - 1; i >= 0; i--) {
    if (scene.children[i].isLight) scene.remove(scene.children[i]);
  }
  const theme = getTheme();
  scene.add(new THREE.AmbientLight(0xffffff, theme === 'light' ? 0.85 : 0.45));
  const key = new THREE.DirectionalLight(0xfff5e3, theme === 'light' ? 2.4 : 2.6);
  key.position.set(2.8, 3.4, 4.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xd9e6ff, theme === 'light' ? 0.6 : 1.2);
  rim.position.set(-3.2, -1.4, -2.6);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1a1a, theme === 'light' ? 0.5 : 0.25));
}

function themedMaterial() {
  const theme = getTheme();
  if (theme === 'light') {
    return new THREE.MeshStandardMaterial({
      color: 0x141414,
      metalness: 0.55,
      roughness: 0.30,
    });
  }
  return new THREE.MeshStandardMaterial({
    color: 0xf5f4f0,
    metalness: 0.55,
    roughness: 0.30,
  });
}

function showLogoFallback() {
  const el = $('#logo-fallback');
  if (el) el.classList.add('is-shown');
}
function hideLogoFallback() {
  const el = $('#logo-fallback');
  if (el) el.classList.remove('is-shown');
}

// ═══════════════════════════════════════════════════════════════════════════
// Animation loop
// ═══════════════════════════════════════════════════════════════════════════

function startAnimationLoop() {
  const tick = (time) => {
    state.globalT = time;
    if (state.stage) {
      applyRepulsion();   // updates targetX/Y for overlapping pairs
      smoothNodes();      // eases baseX/Y toward targetX/Y
      positionNodes(time);
      updateEdges(time);
    }
    if (state.tickThree) state.tickThree(time);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function onResize() {
  cancelAnimationFrame(state.resizeRaf);
  state.resizeRaf = requestAnimationFrame(() => {
    redrawEdges();
    // Recompute auto-fit zoom so the layout adapts to the new viewport
    // (e.g. phone rotation). Skip if the user has manually zoomed/panned.
    if (!state.userViewSet) applyAutoFit();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Modals
// ═══════════════════════════════════════════════════════════════════════════

function setupModalDismiss() {
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-close-modal]')) closeModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

function openProjectModal(project, sourceEl) {
  const root = $('#modal-project');
  const photos = state.photosByProject.get(project.id) || [];

  $('.modal-cat', root).textContent =
    pickField(project, 'category') || t(`category.${project.category_key || 'other'}`);
  $('.modal-title', root).textContent = pickField(project, 'title');
  $('.modal-desc', root).textContent  = pickField(project, 'description') || '';

  const media = $('.modal-media', root);
  media.innerHTML = '';
  const visible = photos.slice(0, 3);
  if (visible.length) {
    media.className = `modal-media cols-${visible.length}`;
    for (const ph of visible) {
      const img = document.createElement('img');
      img.src = mediaUrl(ph.storage_path);
      img.alt = pickField(ph, 'alt') || pickField(project, 'title');
      img.loading = 'lazy';
      media.appendChild(img);
    }
  } else {
    media.className = 'modal-media';
  }

  const link = $('.modal-visit', root);
  if (project.url) { link.href = project.url; link.hidden = false; }
  else             { link.removeAttribute('href'); link.hidden = true; }

  openModal('#modal-project', sourceEl);
}

function openContactModal() {
  const root = $('#modal-contact');
  $('.contact-intro', root).textContent = pickField(state.settings.contact_intro, 'value') || '';
  $('.form-status', root).textContent = '';
  $('.form-status', root).className = 'form-status';
  $('form', root).reset();
  openModal('#modal-contact');
  setTimeout(() => $('input[name=name]', root)?.focus({ preventScroll: true }), 80);
}

function openModal(sel, sourceEl) {
  closeModal();
  const root = $(sel);
  root.setAttribute('aria-hidden', 'false');
  // origin-based transform feels more "from the node" but keep it simple + smooth
  if (sourceEl) {
    const r = sourceEl.getBoundingClientRect();
    const ox = (r.left + r.width / 2) / window.innerWidth * 100;
    const oy = (r.top + r.height / 2) / window.innerHeight * 100;
    root.querySelector('.modal').style.transformOrigin = `${ox}% ${oy}%`;
  } else {
    root.querySelector('.modal').style.transformOrigin = '';
  }
  requestAnimationFrame(() => root.classList.add('is-open'));
}

function closeModal() {
  document.querySelectorAll('.modal-root.is-open').forEach((el) => {
    el.classList.remove('is-open');
    el.setAttribute('aria-hidden', 'true');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CTA + contact form + nav-icon contact shortcut
// ═══════════════════════════════════════════════════════════════════════════

function setupCta() {
  $('#cta').addEventListener('click', openContactModal);
  $('#contact-link').addEventListener('click', openContactModal);

  const form = $('#contact-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('.form-status', form);
    const submitBtn = form.querySelector('button[type=submit]');
    const name = form.elements.name.value.trim();
    const email = form.elements.email.value.trim();
    const message = form.elements.message.value.trim();

    if (!name || !email || !message) {
      status.textContent = t('contact.required');
      status.className = 'form-status is-error';
      return;
    }

    submitBtn.disabled = true;
    status.textContent = t('contact.sending');
    status.className = 'form-status';

    const { error } = await sb.from('contact_submissions').insert({
      name, email, message, source: 'barabashflow.pl',
    });

    submitBtn.disabled = false;

    if (error) {
      console.error('[contact] insert error', error);
      status.textContent = t('contact.error');
      status.className = 'form-status is-error';
      return;
    }

    status.textContent = t('contact.success');
    status.className = 'form-status is-success';
    form.reset();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Language switcher
// ═══════════════════════════════════════════════════════════════════════════

function setupLangSwitcher() {
  const wrap = $('.lang');
  wrap.innerHTML = LOCALES.map(
    (l) => `<button type="button" data-locale="${l}">${l}</button>`,
  ).join('');
  const updateActive = () => {
    wrap.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.locale === getLocale());
    });
  };
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-locale]');
    if (!b) return;
    setLocale(b.dataset.locale);
  });
  onLocaleChange(() => {
    updateActive();
    applyDom();
    renderHeader();
    for (const n of state.nodes) {
      const p = state.projects.find((pp) => pp.id === n.id);
      if (!p) continue;
      $('.node-cat', n.el).textContent =
        pickField(p, 'category') || t(`category.${p.category_key || 'other'}`);
      $('.node-title', n.el).textContent = pickField(p, 'title');
    }
  });
  updateActive();
}

// ═══════════════════════════════════════════════════════════════════════════
// Theme toggle
// ═══════════════════════════════════════════════════════════════════════════

function setupThemeToggle() {
  const btn = $('#theme-toggle');
  const icon = $('#theme-icon');
  const moon = `<path d="M14.5 11.5a5.5 5.5 0 0 1-7-7 5.5 5.5 0 1 0 7 7Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  const sun  = `
    <circle cx="10" cy="10" r="3.4" stroke="currentColor" stroke-width="1.4"/>
    <g stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
      <path d="M10 2.5v2"/><path d="M10 15.5v2"/>
      <path d="M2.5 10h2"/><path d="M15.5 10h2"/>
      <path d="M4.7 4.7l1.4 1.4"/><path d="M13.9 13.9l1.4 1.4"/>
      <path d="M4.7 15.3l1.4-1.4"/><path d="M13.9 6.1l1.4-1.4"/>
    </g>`;
  const paint = () => {
    icon.innerHTML = getTheme() === 'light' ? moon : sun;
  };
  paint();
  btn.addEventListener('click', toggleTheme);
  onThemeChange(paint);
}

// ═══════════════════════════════════════════════════════════════════════════
// Cookie consent — small bottom-right popup on first visit. Accept persists
// in localStorage so it never shows again. "Polityka" opens a dedicated
// modal with the full PL text (already embedded in index.html).
// ═══════════════════════════════════════════════════════════════════════════

const COOKIE_KEY = 'bf:cookies-accepted';

function setupCookieConsent() {
  const bot = $('#cookie-bot');
  if (!bot) return;
  try { if (localStorage.getItem(COOKIE_KEY) === '1') return; } catch {}

  const acceptBtn = $('#cookie-accept');
  const policyBtn = $('#cookie-policy-open');
  const closeBtn  = bot.querySelector('[data-cookie-close]');

  const open  = () => {
    bot.setAttribute('aria-hidden', 'false');
    bot.classList.add('is-open');
  };
  const close = () => {
    bot.classList.remove('is-open');
    setTimeout(() => bot.setAttribute('aria-hidden', 'true'), 520);
  };
  const accept = () => {
    try { localStorage.setItem(COOKIE_KEY, '1'); } catch {}
    close();
  };

  acceptBtn.addEventListener('click', accept);
  closeBtn .addEventListener('click', close);
  policyBtn.addEventListener('click', () => openModal('#modal-cookies'));

  // Slight delay so the popup doesn't compete with the page entrance.
  setTimeout(open, 1400);
}

// ═══════════════════════════════════════════════════════════════════════════
// Mascot bot — floating bottom-left helper. Opens after a delay, typewriter
// greeting, captures one quick question + email, fires it into
// contact_submissions (source='mascot-bot'). Strings come from site_settings
// keys `mascot_*` so the owner can edit them per locale in the admin panel.
// ═══════════════════════════════════════════════════════════════════════════

const MASCOT_OPEN_DELAY_MS = 60000;       // 1 min — production cadence.
const MASCOT_DISMISS_KEY   = 'bf:mascot-dismissed';

function setupMascotBot() {
  const root = $('#mascot-bot');
  if (!root) return;

  const greetingEl   = $('#mascot-greeting');
  const qInput       = $('#mascot-q');
  const emailInput   = $('#mascot-email');
  const sendBtn      = $('#mascot-send');
  const statusEl     = $('#mascot-status');
  const closeBtn     = root.querySelector('[data-mascot-close]');
  const stageAsk     = root.querySelector('[data-stage="ask"]');
  const stageDone    = root.querySelector('[data-stage="done"]');
  const successTitle = $('#mascot-success-title');
  const successText  = $('#mascot-success-text');
  const form         = $('#mascot-form');

  const fallback = {
    greeting:          'Cześć — w czym mogę pomóc?',
    q_placeholder:     'Napisz swoje pytanie…',
    email_placeholder: 'Twój e-mail',
    submit:            'Wyślij',
    success_title:     'Pytanie wysłane',
    success_text:      'Odpowiem najszybciej jak to możliwe.',
  };
  const getStr = (k) =>
    pickField(state.settings[`mascot_${k}`], 'value') || fallback[k];

  let typingTimer = 0;
  let isOpen = false;

  function typewrite(el, text, speed = 24, done) {
    clearInterval(typingTimer);
    el.textContent = '';
    let i = 0;
    typingTimer = setInterval(() => {
      el.textContent = text.slice(0, ++i);
      if (i >= text.length) {
        clearInterval(typingTimer);
        typingTimer = 0;
        if (typeof done === 'function') done();
      }
    }, speed);
  }

  function applyAskStrings() {
    qInput.placeholder     = getStr('q_placeholder');
    emailInput.placeholder = getStr('email_placeholder');
    sendBtn.textContent    = getStr('submit');
    greetingEl.classList.remove('is-done');
    typewrite(greetingEl, getStr('greeting'), 26, () =>
      greetingEl.classList.add('is-done'),
    );
  }

  function applyDoneStrings() {
    successTitle.textContent = '';
    successText.textContent  = '';
    typewrite(successTitle, getStr('success_title'), 22, () => {
      setTimeout(
        () => typewrite(successText, getStr('success_text'), 18),
        120,
      );
    });
  }

  function openBot() {
    if (isOpen) return;
    try { if (sessionStorage.getItem(MASCOT_DISMISS_KEY) === '1') return; } catch {}
    isOpen = true;
    root.setAttribute('aria-hidden', 'false');
    root.classList.add('is-open');
    setTimeout(applyAskStrings, 360);   // wait for card slide-in before typing
  }

  function closeBot() {
    if (!isOpen) return;
    isOpen = false;
    root.classList.remove('is-open');
    clearInterval(typingTimer);
    setTimeout(() => root.setAttribute('aria-hidden', 'true'), 520);
    try { sessionStorage.setItem(MASCOT_DISMISS_KEY, '1'); } catch {}
  }

  closeBtn.addEventListener('click', closeBot);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) closeBot(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q     = qInput.value.trim();
    const email = emailInput.value.trim();
    if (!q || !email) {
      statusEl.textContent = t('contact.required');
      statusEl.className = 'mascot-status is-error';
      return;
    }
    sendBtn.disabled = true;
    statusEl.textContent = t('contact.sending');
    statusEl.className = 'mascot-status';

    const { error } = await sb.from('contact_submissions').insert({
      name: 'Mascot bot',
      email,
      message: q,
      source: 'mascot-bot',
    });

    sendBtn.disabled = false;

    if (error) {
      console.error('[mascot] insert', error);
      statusEl.textContent = t('contact.error');
      statusEl.className = 'mascot-status is-error';
      return;
    }

    statusEl.textContent = '';
    stageAsk.hidden  = true;
    stageDone.hidden = false;
    applyDoneStrings();
    try { sessionStorage.setItem(MASCOT_DISMISS_KEY, '1'); } catch {}
  });

  onLocaleChange(() => {
    if (!isOpen) return;
    if (stageDone.hidden) applyAskStrings();
    else                  applyDoneStrings();
  });

  setTimeout(openBot, MASCOT_OPEN_DELAY_MS);
}

// ═══════════════════════════════════════════════════════════════════════════
// Tab-away prank — when the tab loses focus, swap the title to a playful PL
// nudge to come back. Restore the original on focus. Rotate every 6s.
// ═══════════════════════════════════════════════════════════════════════════

function setupTabAway() {
  const original = document.title;
  const lines = [
    'Hej… wróć tu na chwilę',
    'Dokąd uciekasz?',
    'Bez ciebie tu pusto…',
    'Zaraz, mam coś dla ciebie',
    'Tutaj jest ciekawiej, obiecuję',
    'Piksele tęsknią',
    'Wróć — projekty się nudzą',
    'Nie zapomnij o mnie',
    'Czekam. Cierpliwie.',
    'Klik z powrotem',
    'Kawa stygnie, wracaj',
  ];
  let last = -1;
  let cycler = 0;
  const pickDifferent = () => {
    if (lines.length < 2) return lines[0];
    let i;
    do { i = Math.floor(Math.random() * lines.length); } while (i === last);
    last = i;
    return lines[i];
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      document.title = pickDifferent();
      clearInterval(cycler);
      cycler = setInterval(() => { document.title = pickDifferent(); }, 6000);
    } else {
      clearInterval(cycler);
      cycler = 0;
      document.title = original;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Utils
// ═══════════════════════════════════════════════════════════════════════════

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}
