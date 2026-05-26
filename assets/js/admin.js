import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { SUPABASE_URL, SUPABASE_ANON_KEY, MEDIA_BUCKET, mediaUrl } from './supabase-config.js?v=2026-05-25q';
import { getTheme, toggleTheme, onThemeChange } from './theme.js?v=2026-05-25q';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'bf-admin-auth' },
});

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  user: null,
  settings: {},
  projects: [],
  photosByProject: new Map(),
  connections: [],
  inbox: [],
  selectedId: null,
  draft: null,                // editor draft of selected project
  photoSlots: [],             // [{file?, existing?, removed?}]
  pendingConnections: null,   // Set<projectId> while editing
  pendingOwnerPhoto: null,
  removeOwnerPhoto: false,
  dragging: null,             // active drag context
};

// ═══════════════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════════════

init().catch((err) => console.error('[admin] init failed', err));

function setupTabAway() {
  const original = document.title;
  const lines = [
    'Wróć do studia',
    'Wiadomości czekają',
    'Tu się dzieje',
    'Hej, gdzie ty?',
    'Projekty same się nie ułożą',
    'Czekam — zerknij',
    'Studio bez ciebie cichnie',
  ];
  let last = -1, cycler = 0;
  const pick = () => {
    if (lines.length < 2) return lines[0];
    let i; do { i = Math.floor(Math.random() * lines.length); } while (i === last);
    last = i; return lines[i];
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      document.title = pick();
      clearInterval(cycler);
      cycler = setInterval(() => { document.title = pick(); }, 6000);
    } else {
      clearInterval(cycler); cycler = 0;
      document.title = original;
    }
  });
}

async function init() {
  bindAuthUI();
  bindShellUI();
  bindThemeToggle();
  setupTabAway();

  const { data: { session } } = await sb.auth.getSession();
  if (session) await onSignedIn(session.user);
  else showAuth();

  sb.auth.onAuthStateChange((_evt, sess) => {
    if (sess?.user) onSignedIn(sess.user);
    else showAuth();
  });
}

function showAuth() {
  $('#auth-screen').style.display = '';
  $('#shell').classList.remove('is-active');
}

async function onSignedIn(user) {
  state.user = user;
  $('#session-email').textContent = user.email;
  $('#auth-screen').style.display = 'none';
  $('#shell').classList.add('is-active');
  await refreshAll();
}

async function refreshAll() {
  await Promise.all([loadSettings(), loadProjects(), loadInbox()]);
  renderSettings();
  renderGraph();
  renderInbox();
}

// ═══════════════════════════════════════════════════════════════════════════
// Auth UI
// ═══════════════════════════════════════════════════════════════════════════

function bindAuthUI() {
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#auth-status');
    status.className = '';
    status.textContent = 'Logowanie…';
    const email = e.target.elements.email.value.trim();
    const password = e.target.elements.password.value;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      status.className = 'error';
      status.style.color = 'var(--danger)';
      status.textContent = error.message;
    } else {
      status.style.color = 'var(--ok)';
      status.textContent = 'OK';
    }
  });
  $('#signout').addEventListener('click', () => sb.auth.signOut());
}

// ═══════════════════════════════════════════════════════════════════════════
// Tabs / theme
// ═══════════════════════════════════════════════════════════════════════════

function bindShellUI() {
  $$('.tab-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const tab = b.dataset.tab;
      $$('.tab-btn').forEach((x) => x.classList.toggle('is-active', x === b));
      $$('.panel-page').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab));
      if (tab === 'work') redrawEdges();
    });
  });

  // Owner photo
  $('#owner-photo-slot').addEventListener('click', (e) => {
    if (e.target.closest('.remove')) return;
    pickFile().then((file) => {
      if (!file) return;
      state.pendingOwnerPhoto = file;
      state.removeOwnerPhoto = false;
      paintOwnerPhoto(URL.createObjectURL(file));
    });
  });
  $('[data-remove-owner-photo]').addEventListener('click', (e) => {
    e.stopPropagation();
    state.pendingOwnerPhoto = null;
    state.removeOwnerPhoto = true;
    paintOwnerPhoto(null);
  });

  $('#save-settings').addEventListener('click', saveSettings);
  $('#new-project').addEventListener('click', createNewProject);

  window.addEventListener('resize', () => redrawEdges());
}

function bindThemeToggle() {
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
  const paint = () => { icon.innerHTML = getTheme() === 'light' ? moon : sun; };
  paint();
  btn.addEventListener('click', toggleTheme);
  onThemeChange(paint);
}

// ═══════════════════════════════════════════════════════════════════════════
// Data
// ═══════════════════════════════════════════════════════════════════════════

async function loadSettings() {
  const { data, error } = await sb.from('site_settings').select('*');
  if (error) { console.error(error); return; }
  state.settings = Object.fromEntries((data || []).map((r) => [r.key, r]));
}

async function loadProjects() {
  const [{ data: projects }, { data: photos }, { data: conns }] = await Promise.all([
    sb.from('projects').select('*').order('sort_order'),
    sb.from('project_photos').select('*').order('sort_order'),
    sb.from('project_connections').select('*'),
  ]);
  state.projects = projects || [];
  state.photosByProject.clear();
  for (const ph of photos || []) {
    if (!state.photosByProject.has(ph.project_id)) state.photosByProject.set(ph.project_id, []);
    state.photosByProject.get(ph.project_id).push(ph);
  }
  state.connections = conns || [];
}

async function loadInbox() {
  const { data, error } = await sb
    .from('contact_submissions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) { console.error(error); return; }
  state.inbox = data || [];
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings (Strona)
// ═══════════════════════════════════════════════════════════════════════════

function renderSettings() {
  $$('input[data-setting], textarea[data-setting]').forEach((el) => {
    const row = state.settings[el.dataset.setting];
    el.value = row ? (row[`value_${el.dataset.lang}`] || '') : '';
  });
  const photoPath = state.settings.owner_photo_path?.value_meta?.path;
  paintOwnerPhoto(photoPath ? mediaUrl(photoPath) : null);
  state.pendingOwnerPhoto = null;
  state.removeOwnerPhoto = false;
}

function paintOwnerPhoto(url) {
  const slot = $('#owner-photo-slot');
  if (url) {
    slot.classList.add('has-image');
    slot.style.backgroundImage = `url("${url}")`;
  } else {
    slot.classList.remove('has-image');
    slot.style.backgroundImage = '';
  }
}

async function saveSettings() {
  banner('Zapisywanie…', null);
  try {
    const keys = new Set();
    $$('input[data-setting], textarea[data-setting]').forEach((el) => keys.add(el.dataset.setting));

    const upserts = [];
    for (const key of keys) {
      const row = state.settings[key] || { key };
      const next = { key, value_meta: row.value_meta || {} };
      ['pl', 'en', 'ru'].forEach((l) => {
        const el = document.querySelector(`[data-setting="${key}"][data-lang="${l}"]`);
        next[`value_${l}`] = el ? el.value.trim() || null : null;
      });
      upserts.push(next);
    }

    let ownerMeta = state.settings.owner_photo_path?.value_meta || {};
    if (state.pendingOwnerPhoto) {
      const path = await uploadFile(state.pendingOwnerPhoto, 'owner');
      if (ownerMeta.path && ownerMeta.path !== path) await removeFile(ownerMeta.path).catch(() => {});
      ownerMeta = { path };
    } else if (state.removeOwnerPhoto) {
      if (ownerMeta.path) await removeFile(ownerMeta.path).catch(() => {});
      ownerMeta = {};
    }
    const ownerRow = upserts.find((r) => r.key === 'owner_photo_path') || { key: 'owner_photo_path' };
    ownerRow.value_meta = ownerMeta;
    if (!upserts.find((r) => r.key === 'owner_photo_path')) upserts.push(ownerRow);

    const { error } = await sb.from('site_settings').upsert(upserts, { onConflict: 'key' });
    if (error) throw error;

    await loadSettings();
    renderSettings();
    banner('Zapisano', 'ok');
  } catch (err) {
    console.error(err);
    banner(err.message || 'Błąd zapisu', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Graph (Projekty)
// ═══════════════════════════════════════════════════════════════════════════

function renderGraph() {
  $('#projects-count').textContent = state.projects.length ? `(${state.projects.length})` : '';

  const inner = $('#graph-inner');
  inner.querySelectorAll('.node').forEach((n) => n.remove());

  for (const p of state.projects) {
    const el = buildAdminNodeEl(p);
    inner.appendChild(el);
    placeNode(el, p.position_x, p.position_y);
    bindAdminNodeDrag(el, p.id);
  }

  setupAdminZoom();    // idempotent — first call wires the wheel listener
  redrawEdges();
}

// Wheel-zoom on the admin graph workspace. Visual-only transform on
// .graph-inner; data positions stay in normalized space.
function setupAdminZoom() {
  if (state.zoomWired) return;
  state.zoomWired = true;
  state.zoom = state.zoom || 1;
  const ws    = $('#graph-workspace');
  const inner = $('#graph-inner');
  const indi  = $('#zoom-indicator');
  let hideTimer = 0;

  const apply = () => {
    inner.style.setProperty('--zoom', state.zoom.toFixed(3));
    if (indi) {
      indi.textContent = `${Math.round(state.zoom * 100)}%`;
      indi.classList.add('is-visible');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => indi.classList.remove('is-visible'), 900);
    }
  };
  apply();

  ws.addEventListener('wheel', (e) => {
    e.preventDefault();
    inner.classList.add('is-zooming');
    const factor = Math.exp(-e.deltaY * 0.0015);
    state.zoom = Math.max(0.35, Math.min(2.5, state.zoom * factor));
    apply();
    clearTimeout(state._zoomReleaseTimer);
    state._zoomReleaseTimer = setTimeout(
      () => inner.classList.remove('is-zooming'), 180,
    );
  }, { passive: false });
}

function buildAdminNodeEl(p) {
  const el = document.createElement('div');
  el.className = 'node';
  el.dataset.projectId = p.id;
  if (p.accent_color) el.style.setProperty('--node-accent', p.accent_color);
  if (!p.is_published) el.classList.add('is-pending');
  if (p.id === state.selectedId) el.classList.add('is-selected');
  el.innerHTML = `
    <span class="node-visibility" style="${p.is_published ? 'display:none' : ''}">Ukryty</span>
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
  $('.node-cat', el).textContent =
    p.category_pl || p.category_en || p.category_ru || categoryFallback(p.category_key);
  $('.node-title', el).textContent = p.title_pl || p.title_en || p.title_ru || p.slug;
  return el;
}

function categoryFallback(key) {
  switch (key) {
    case 'site': return 'Strona';
    case 'panel': return 'Panel';
    case 'app': return 'Aplikacja';
    case 'platform': return 'Platforma';
    default: return 'Projekt';
  }
}

function placeNode(el, baseX, baseY) {
  const ws = $('#graph-workspace').getBoundingClientRect();
  const padX = Math.min(ws.width * 0.10, 80);
  const padY = Math.min(ws.height * 0.10, 60);
  const cx = ws.width / 2;
  const cy = ws.height / 2;
  // No clamp — positions may exceed ±1 (admin can place projects "far away").
  const x = cx + (Number.isFinite(baseX) ? baseX : 0) * (cx - padX);
  const y = cy + (Number.isFinite(baseY) ? baseY : 0) * (cy - padY);
  el.style.left = `${x}px`;
  el.style.top  = `${y}px`;
  el.dataset.baseX = String(baseX);
  el.dataset.baseY = String(baseY);
}

function clampUnit(v) {
  // kept for backward-compat with other call sites; positions themselves no longer clamp
  if (Number.isFinite(v)) return Math.max(-1, Math.min(1, v));
  return 0;
}
function safeNum(v) { return Number.isFinite(v) ? v : 0; }

function redrawEdges() {
  const svg = $('#graph-edges');
  if (!svg) return;
  const ws = $('#graph-workspace').getBoundingClientRect();
  // Inner viewport: unscaled, since .graph-inner is the scaled wrapper.
  const inner = $('#graph-inner');
  // SVG inside .graph-inner uses unscaled px coords (1:1 with style.left/top).
  svg.setAttribute('viewBox', `0 0 ${ws.width} ${ws.height}`);
  svg.innerHTML = '';

  const nodes = $$('.node', inner);
  const positions = new Map();
  for (const el of nodes) {
    // style.left/top are in unscaled coords; use those for accurate path math
    // (getBoundingClientRect would return scaled screen coords).
    positions.set(el.dataset.projectId, {
      x: parseFloat(el.style.left) || 0,
      y: parseFloat(el.style.top)  || 0,
    });
  }
  const cx = ws.width / 2;
  const cy = ws.height / 2;

  // center spokes
  for (const [id, p] of positions) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'edge is-center');
    path.setAttribute('d', `M ${cx} ${cy} Q ${(cx + p.x) / 2 + 14} ${(cy + p.y) / 2 - 14} ${p.x} ${p.y}`);
    svg.appendChild(path);
  }

  // saved connections
  for (const c of state.connections) {
    const a = positions.get(c.from_project_id);
    const b = positions.get(c.to_project_id);
    if (!a || !b) continue;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'edge is-conn');
    path.setAttribute('d', `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${(a.y + b.y) / 2 + 22} ${b.x} ${b.y}`);
    svg.appendChild(path);
  }

  // pending (unsaved) connections for the open editor
  if (state.selectedId && state.pendingConnections) {
    const self = positions.get(state.selectedId);
    if (self) {
      for (const otherId of state.pendingConnections) {
        if (state.connections.some((c) =>
          (c.from_project_id === state.selectedId && c.to_project_id === otherId) ||
          (c.to_project_id === state.selectedId && c.from_project_id === otherId)
        )) continue;
        const o = positions.get(otherId);
        if (!o) continue;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'edge is-pending');
        path.setAttribute('d', `M ${self.x} ${self.y} Q ${(self.x + o.x) / 2} ${(self.y + o.y) / 2 + 22} ${o.x} ${o.y}`);
        svg.appendChild(path);
      }
    }
  }
}

// click vs drag — same threshold as the public page
const DRAG_THRESHOLD = 5;

function bindAdminNodeDrag(el, projectId) {
  let down = false;
  let escalated = false;
  let pid = null;
  let startX = 0, startY = 0;
  let originLeft = 0, originTop = 0;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pid = e.pointerId;
    down = true;
    escalated = false;
    startX = e.clientX; startY = e.clientY;
    // Use the unscaled style.left/top as origin — robust under wheel-zoom.
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
      el.classList.add('is-dragging');
    }
    if (!escalated) return;
    const ws   = $('#graph-workspace').getBoundingClientRect();
    const zoom = state.zoom || 1;
    // Screen-space delta → workspace-space delta (account for CSS scale).
    const nx = originLeft + dx / zoom;
    const ny = originTop  + dy / zoom;
    const padX = Math.min(ws.width  * 0.10, 80);
    const padY = Math.min(ws.height * 0.10, 60);
    // No clamp — admin may push positions beyond ±1.
    const baseX = (nx - ws.width  / 2) / Math.max(ws.width  / 2 - padX, 1);
    const baseY = (ny - ws.height / 2) / Math.max(ws.height / 2 - padY, 1);
    el.style.left = `${nx}px`;
    el.style.top  = `${ny}px`;
    el.dataset.baseX = String(baseX);
    el.dataset.baseY = String(baseY);
    if (state.draft && state.draft.id === projectId) {
      state.draft.position_x = baseX;
      state.draft.position_y = baseY;
      updateCoordsLabel();
    }
    redrawEdges();
  });
  const finish = (e) => {
    if (!down) return;
    down = false;
    el.releasePointerCapture?.(pid);
    pid = null;
    const wasDrag = escalated;
    el.classList.remove('is-dragging');
    if (wasDrag) {
      const bx = parseFloat(el.dataset.baseX);
      const by = parseFloat(el.dataset.baseY);
      saveProjectPosition(projectId, bx, by);
    } else {
      selectProject(projectId);
    }
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}

async function saveProjectPosition(id, x, y) {
  try {
    const { error } = await sb.from('projects')
      .update({ position_x: x, position_y: y })
      .eq('id', id);
    if (error) throw error;
    const local = state.projects.find((p) => p.id === id);
    if (local) { local.position_x = x; local.position_y = y; }
    banner('Pozycja zapisana', 'ok');
  } catch (err) {
    console.error(err);
    banner(err.message || 'Błąd', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Side panel — editor
// ═══════════════════════════════════════════════════════════════════════════

function selectProject(id) {
  state.selectedId = id;
  $$('.node', $('#graph-workspace')).forEach((el) => {
    el.classList.toggle('is-selected', el.dataset.projectId === id);
  });
  const project = state.projects.find((p) => p.id === id);
  if (!project) { showEmptyPanel(); return; }
  state.draft = { ...project };
  buildEditor(project);
}

function showEmptyPanel() {
  state.selectedId = null;
  state.draft = null;
  state.photoSlots = [];
  state.pendingConnections = null;
  $$('.node', $('#graph-workspace')).forEach((el) => el.classList.remove('is-selected'));
  const panel = $('#side-panel');
  panel.classList.add('is-empty');
  panel.innerHTML = `
    <div class="placeholder-glyph">∅</div>
    <div>
      <div class="pitch">Wybierz węzeł, aby edytować</div>
      <div class="pitch-sub">Albo naciśnij <strong>+</strong>, żeby dodać nowy projekt. Przeciągnij węzły w grafie — pozycja zapisuje się automatycznie.</div>
    </div>`;
  redrawEdges();
}

function createNewProject() {
  const draft = {
    id: null,
    slug: `projekt-${Date.now().toString(36)}`,
    title_pl: 'Nowy projekt', title_en: '', title_ru: '',
    category_key: 'site',
    category_pl: 'Strona', category_en: 'Website', category_ru: 'Сайт',
    description_pl: '', description_en: '', description_ru: '',
    url: '', accent_color: '#0e0e0e',
    position_x: 0.4, position_y: -0.3,
    sort_order: state.projects.length + 1,
    is_published: true,
  };
  state.selectedId = '__new__';
  state.draft = draft;
  state.photoSlots = [{}, {}, {}];
  state.pendingConnections = new Set();
  buildEditor(draft);
  // also drop a "ghost" node temporarily so the user sees position
  const ghost = document.createElement('div');
  ghost.className = 'node is-pending is-selected';
  ghost.dataset.projectId = '__new__';
  ghost.style.setProperty('--node-accent', draft.accent_color);
  ghost.innerHTML = `
    <div class="node-thumb" data-empty="true"></div>
    <div class="node-body">
      <span class="node-cat"></span>
      <span class="node-title"></span>
    </div>
  `;
  $('.node-cat', ghost).textContent = draft.category_pl;
  $('.node-title', ghost).textContent = draft.title_pl;
  $('#graph-inner').appendChild(ghost);
  placeNode(ghost, draft.position_x, draft.position_y);
  bindAdminNodeDrag(ghost, '__new__');
  redrawEdges();
}

function buildEditor(p) {
  const panel = $('#side-panel');
  panel.classList.remove('is-empty');

  // initial photo slots
  const photos = (p.id ? state.photosByProject.get(p.id) : null) || [];
  state.photoSlots = [];
  for (let i = 0; i < 3; i++) {
    state.photoSlots[i] = photos[i] ? { existing: photos[i] } : {};
  }
  // initial connection set
  if (p.id) {
    const linked = new Set(
      state.connections
        .filter((c) => c.from_project_id === p.id || c.to_project_id === p.id)
        .map((c) => (c.from_project_id === p.id ? c.to_project_id : c.from_project_id)),
    );
    state.pendingConnections = linked;
  } else if (!state.pendingConnections) {
    state.pendingConnections = new Set();
  }

  panel.innerHTML = `
    <div class="eyebrow">${p.id ? 'Edycja' : 'Nowy projekt'}</div>
    <h3 id="ed-title-head">${escapeHtml(p.title_pl || p.title_en || p.slug || 'Bez tytułu')}</h3>

    <div class="section">
      <div class="section-head">
        <span class="section-title">Treść</span>
        <span class="section-aside">PL · EN · RU</span>
      </div>
      <div class="field">
        <label class="field-label">Tytuł</label>
        <div class="lang-trio">
          <div class="field-input" data-lang="PL"><input id="ed-title-pl" value="${attr(p.title_pl)}" placeholder="Polski" /></div>
          <div class="field-input" data-lang="EN"><input id="ed-title-en" value="${attr(p.title_en)}" placeholder="English" /></div>
          <div class="field-input" data-lang="RU"><input id="ed-title-ru" value="${attr(p.title_ru)}" placeholder="Русский" /></div>
        </div>
      </div>
      <div class="field">
        <label class="field-label">Kategoria — etykieta</label>
        <div class="lang-trio">
          <div class="field-input" data-lang="PL"><input id="ed-cat-pl" value="${attr(p.category_pl)}" /></div>
          <div class="field-input" data-lang="EN"><input id="ed-cat-en" value="${attr(p.category_en)}" /></div>
          <div class="field-input" data-lang="RU"><input id="ed-cat-ru" value="${attr(p.category_ru)}" /></div>
        </div>
      </div>
      <div class="field">
        <label class="field-label">Typ</label>
        <select id="ed-cat-key">
          <option value="site">Strona / Website</option>
          <option value="panel">Panel / Admin</option>
          <option value="app">Aplikacja / App</option>
          <option value="platform">Platforma / Platform</option>
          <option value="other">Inne</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label">Opis (otwiera się w karcie)</label>
        <div class="lang-trio">
          <div class="field-input" data-lang="PL"><textarea id="ed-desc-pl" rows="3">${attr(p.description_pl)}</textarea></div>
          <div class="field-input" data-lang="EN"><textarea id="ed-desc-en" rows="3">${attr(p.description_en)}</textarea></div>
          <div class="field-input" data-lang="RU"><textarea id="ed-desc-ru" rows="3">${attr(p.description_ru)}</textarea></div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><span class="section-title">Zdjęcia</span><span class="section-aside">do 3 · pierwsze = okładka</span></div>
      <div class="photo-grid" id="ed-photos"></div>
    </div>

    <div class="section">
      <div class="section-head">
        <span class="section-title">Łącza między projektami</span>
        <span class="section-aside" id="ed-conn-count"></span>
      </div>
      <p class="section-hint">Kliknij projekt, aby narysować linię łączącą go z tym węzłem na publicznym grafie. Wyglądają jak przerywane krawędzie w grafie obok.</p>
      <div class="conn-chips" id="ed-conn"></div>
    </div>

    <div class="section">
      <div class="section-head"><span class="section-title">Detale</span></div>
      <div class="row-2">
        <div class="field">
          <label class="field-label">Slug (URL)</label>
          <input id="ed-slug" value="${attr(p.slug)}" placeholder="np. fpl-platform" />
        </div>
        <div class="field">
          <label class="field-label">Link zewnętrzny</label>
          <input id="ed-url" value="${attr(p.url)}" placeholder="https://…" />
        </div>
        <div class="field">
          <label class="field-label">Kolor akcentu</label>
          <div class="color-input">
            <input type="color" id="ed-accent" value="${attr(p.accent_color || '#0e0e0e')}" style="width:48px;height:36px;padding:0;border-radius:8px;cursor:pointer;" />
            <input id="ed-accent-hex" value="${attr(p.accent_color || '#0e0e0e')}" />
          </div>
        </div>
        <div class="field">
          <label class="field-label">Kolejność</label>
          <input id="ed-order" type="number" value="${p.sort_order ?? 0}" />
        </div>
        <div class="field">
          <label class="field-label">Widoczność</label>
          <select id="ed-pub">
            <option value="true">Opublikowany</option>
            <option value="false">Ukryty</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label">Pozycja na grafie</label>
          <div class="coords" id="ed-coords"></div>
        </div>
      </div>
    </div>

    <div class="button-row">
      <button class="btn danger" id="ed-delete" ${p.id ? '' : 'disabled'}>Usuń</button>
      <span class="spread"></span>
      <button class="btn" id="ed-cancel">Anuluj</button>
      <button class="btn primary" id="ed-save">Zapisz</button>
    </div>
  `;

  $('#ed-cat-key').value = p.category_key || 'site';
  $('#ed-pub').value = (p.is_published ?? true) ? 'true' : 'false';
  updateCoordsLabel();

  paintPhotoSlots();
  paintConnChips();

  $('#ed-title-pl').addEventListener('input', (e) => {
    state.draft.title_pl = e.target.value;
    $('#ed-title-head').textContent = e.target.value || 'Bez tytułu';
    // also live-update node label
    const node = $(`.node[data-project-id="${p.id ?? '__new__'}"]`);
    if (node) $('.node-title', node).textContent = e.target.value || p.slug;
  });

  ['en', 'ru'].forEach((l) => {
    $(`#ed-title-${l}`).addEventListener('input', (e) => { state.draft[`title_${l}`] = e.target.value; });
  });
  ['pl', 'en', 'ru'].forEach((l) => {
    $(`#ed-cat-${l}`).addEventListener('input', (e) => {
      state.draft[`category_${l}`] = e.target.value;
      if (l === 'pl') {
        const node = $(`.node[data-project-id="${p.id ?? '__new__'}"]`);
        if (node) $('.node-cat', node).textContent = e.target.value;
      }
    });
    $(`#ed-desc-${l}`).addEventListener('input', (e) => { state.draft[`description_${l}`] = e.target.value; });
  });
  $('#ed-cat-key').addEventListener('change', (e) => { state.draft.category_key = e.target.value; });
  $('#ed-slug').addEventListener('input', (e) => { state.draft.slug = e.target.value; });
  $('#ed-url').addEventListener('input', (e) => { state.draft.url = e.target.value; });
  $('#ed-order').addEventListener('input', (e) => { state.draft.sort_order = parseInt(e.target.value, 10) || 0; });
  $('#ed-pub').addEventListener('change', (e) => {
    state.draft.is_published = e.target.value === 'true';
    const node = $(`.node[data-project-id="${p.id ?? '__new__'}"]`);
    if (node) node.classList.toggle('is-pending', !state.draft.is_published);
  });

  const acc = $('#ed-accent');
  const accHex = $('#ed-accent-hex');
  acc.addEventListener('input', (e) => {
    state.draft.accent_color = e.target.value;
    accHex.value = e.target.value;
    updateNodeAccent(p.id ?? '__new__', e.target.value);
  });
  accHex.addEventListener('input', (e) => {
    state.draft.accent_color = e.target.value;
    if (/^#[0-9a-f]{6}$/i.test(e.target.value)) acc.value = e.target.value;
    updateNodeAccent(p.id ?? '__new__', e.target.value);
  });

  $('#ed-save').addEventListener('click', saveProjectFromEditor);
  $('#ed-cancel').addEventListener('click', () => {
    // remove ghost node if creating
    if (!p.id) $$('.node[data-project-id="__new__"]').forEach((n) => n.remove());
    showEmptyPanel();
  });
  $('#ed-delete').addEventListener('click', deleteProjectFromEditor);

  redrawEdges();
}

function updateNodeAccent(id, hex) {
  const node = $(`.node[data-project-id="${id}"]`);
  if (node) node.style.setProperty('--node-accent', hex);
}

function updateCoordsLabel() {
  const el = $('#ed-coords');
  if (!el || !state.draft) return;
  el.textContent = `x ${state.draft.position_x.toFixed(2)}  ·  y ${state.draft.position_y.toFixed(2)}`;
}

function paintPhotoSlots() {
  const wrap = $('#ed-photos');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const slot = state.photoSlots[i];
    const div = document.createElement('div');
    div.className = 'photo-slot';
    let url = null;
    if (slot.file) url = URL.createObjectURL(slot.file);
    else if (slot.existing && !slot.removed) url = mediaUrl(slot.existing.storage_path);
    if (url) {
      div.classList.add('has-image');
      div.style.backgroundImage = `url("${url}")`;
    }
    div.innerHTML += `<span>${i + 1}</span><button type="button" class="remove" aria-label="usuń">×</button>`;
    div.addEventListener('click', async (e) => {
      if (e.target.closest('.remove')) return;
      const file = await pickFile();
      if (!file) return;
      state.photoSlots[i] = { ...slot, file, removed: false };
      paintPhotoSlots();
      // live-update the graph node thumb when changing the cover photo
      if (i === 0) {
        const id = state.draft?.id ?? '__new__';
        const node = $(`.node[data-project-id="${id}"]`);
        if (node) {
          const thumb = node.querySelector('.node-thumb');
          if (thumb) {
            thumb.style.backgroundImage = `url("${URL.createObjectURL(file)}")`;
            thumb.style.backgroundSize = 'cover';
            thumb.removeAttribute('data-empty');
          }
        }
      }
    });
    div.querySelector('.remove').addEventListener('click', (e) => {
      e.stopPropagation();
      if (slot.existing) state.photoSlots[i] = { existing: slot.existing, removed: true };
      else state.photoSlots[i] = {};
      paintPhotoSlots();
    });
    wrap.appendChild(div);
  }
}

function paintConnChips() {
  const wrap = $('#ed-conn');
  const countEl = $('#ed-conn-count');
  if (!wrap) return;
  wrap.innerHTML = '';
  const selfId = state.draft?.id;
  const others = state.projects.filter((p) => p.id !== selfId);
  if (countEl) {
    const n = state.pendingConnections?.size || 0;
    countEl.textContent = n ? `${n} aktywne` : '';
  }
  if (!others.length) {
    wrap.innerHTML = '<div class="coords">Dodaj kolejny projekt, by tworzyć łącza.</div>';
    return;
  }
  for (const p of others) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'conn-chip' + (state.pendingConnections.has(p.id) ? ' is-on' : '');
    if (p.accent_color) chip.style.setProperty('--chip-accent', p.accent_color);
    chip.innerHTML = `<span class="chip-dot"></span>${escapeHtml(p.title_pl || p.title_en || p.slug)}`;
    chip.addEventListener('click', async () => {
      const selfId = state.draft?.id;
      // For new (unsaved) projects, just track locally — save happens with the project.
      if (!selfId) {
        if (state.pendingConnections.has(p.id)) state.pendingConnections.delete(p.id);
        else state.pendingConnections.add(p.id);
        paintConnChips();
        redrawEdges();
        return;
      }
      // For saved projects — mutate the DB immediately so the chip is truth.
      const wasOn = state.pendingConnections.has(p.id);
      chip.disabled = true;
      if (wasOn) {
        // Find ANY direction match — historical rows may not be canonical.
        const conn = state.connections.find((c) =>
          (c.from_project_id === selfId && c.to_project_id === p.id) ||
          (c.from_project_id === p.id   && c.to_project_id === selfId),
        );
        if (conn) {
          const { error } = await sb.from('project_connections').delete().eq('id', conn.id);
          if (error) {
            console.error('[conn delete]', error);
            banner(error.message || 'Błąd odłączania', 'error');
            chip.disabled = false;
            return;
          }
          state.connections = state.connections.filter((c) => c.id !== conn.id);
        }
        state.pendingConnections.delete(p.id);
        banner('Odłączono', 'ok');
      } else {
        const [a, b] = [selfId, p.id].sort();
        const { data, error } = await sb
          .from('project_connections')
          .upsert([{ from_project_id: a, to_project_id: b }], {
            onConflict: 'from_project_id,to_project_id',
            ignoreDuplicates: false,
          })
          .select()
          .single();
        if (error) {
          console.error('[conn insert]', error);
          banner(error.message || 'Błąd łączenia', 'error');
          chip.disabled = false;
          return;
        }
        if (data) {
          // Replace any stale entry with the same id.
          state.connections = state.connections.filter((c) => c.id !== data.id);
          state.connections.push(data);
        }
        state.pendingConnections.add(p.id);
        banner('Połączono', 'ok');
      }
      paintConnChips();
      redrawEdges();
    });
    wrap.appendChild(chip);
  }
}

async function saveProjectFromEditor() {
  const d = state.draft;
  if (!d) return;
  banner('Zapisywanie…', null);

  const payload = {
    slug: d.slug?.trim(),
    title_pl: d.title_pl?.trim(),
    title_en: d.title_en?.trim() || null,
    title_ru: d.title_ru?.trim() || null,
    category_key: d.category_key,
    category_pl: d.category_pl?.trim() || null,
    category_en: d.category_en?.trim() || null,
    category_ru: d.category_ru?.trim() || null,
    description_pl: d.description_pl?.trim() || null,
    description_en: d.description_en?.trim() || null,
    description_ru: d.description_ru?.trim() || null,
    url: d.url?.trim() || null,
    accent_color: d.accent_color || null,
    // Positions can exceed ±1 — admin may have placed the node far away.
    position_x: Number.isFinite(d.position_x) ? d.position_x : 0,
    position_y: Number.isFinite(d.position_y) ? d.position_y : 0,
    sort_order: d.sort_order ?? 0,
    is_published: !!d.is_published,
  };
  if (!payload.slug || !payload.title_pl) {
    banner('Slug i tytuł PL są wymagane', 'error');
    return;
  }

  try {
    let id = d.id;
    if (id) {
      const { error } = await sb.from('projects').update(payload).eq('id', id);
      if (error) throw error;
    } else {
      const { data, error } = await sb.from('projects').insert(payload).select('id').single();
      if (error) throw error;
      id = data.id;
      // remove the ghost node
      $$('.node[data-project-id="__new__"]').forEach((n) => n.remove());
    }

    // photos
    for (let i = 0; i < 3; i++) {
      const slot = state.photoSlots[i];
      if (!slot) continue;
      if (slot.file) {
        const path = await uploadFile(slot.file, `project/${id}`);
        if (slot.existing) {
          await sb.from('project_photos').update({ storage_path: path, sort_order: i }).eq('id', slot.existing.id);
          await removeFile(slot.existing.storage_path).catch(() => {});
        } else {
          await sb.from('project_photos').insert({ project_id: id, storage_path: path, sort_order: i });
        }
      } else if (slot.removed && slot.existing) {
        await sb.from('project_photos').delete().eq('id', slot.existing.id);
        await removeFile(slot.existing.storage_path).catch(() => {});
      } else if (slot.existing && slot.existing.sort_order !== i) {
        await sb.from('project_photos').update({ sort_order: i }).eq('id', slot.existing.id);
      }
    }

    // connections — replace set
    const newSet = state.pendingConnections || new Set();
    const current = state.connections.filter((c) => c.from_project_id === id || c.to_project_id === id);
    const currentIds = new Set(current.map((c) => (c.from_project_id === id ? c.to_project_id : c.from_project_id)));

    const toDelete = current.filter((c) => {
      const other = c.from_project_id === id ? c.to_project_id : c.from_project_id;
      return !newSet.has(other);
    });
    const toInsert = [...newSet].filter((x) => !currentIds.has(x));

    if (toDelete.length) {
      const ids = toDelete.map((c) => c.id);
      const { error } = await sb.from('project_connections').delete().in('id', ids);
      if (error) console.warn('[conn delete on save]', error);
    }
    if (toInsert.length) {
      const rows = toInsert.map((other) => {
        const [a, b] = [id, other].sort();
        return { from_project_id: a, to_project_id: b };
      });
      const { error } = await sb.from('project_connections').upsert(rows, {
        onConflict: 'from_project_id,to_project_id',
        ignoreDuplicates: true,
      });
      if (error) console.warn('[conn upsert]', error);
    }

    await loadProjects();
    state.selectedId = id;
    state.draft = state.projects.find((p) => p.id === id) ? { ...state.projects.find((p) => p.id === id) } : null;
    renderGraph();
    if (state.draft) buildEditor(state.draft);
    else showEmptyPanel();
    banner('Zapisano', 'ok');
  } catch (err) {
    console.error(err);
    banner(err.message || 'Błąd zapisu', 'error');
  }
}

async function deleteProjectFromEditor() {
  const d = state.draft;
  if (!d?.id) return;
  if (!confirm(`Usunąć projekt „${d.title_pl || d.slug}"?`)) return;
  banner('Usuwanie…', null);
  try {
    const photos = state.photosByProject.get(d.id) || [];
    await Promise.all(photos.map((p) => removeFile(p.storage_path).catch(() => {})));
    const { error } = await sb.from('projects').delete().eq('id', d.id);
    if (error) throw error;
    await loadProjects();
    renderGraph();
    showEmptyPanel();
    banner('Usunięto', 'ok');
  } catch (err) {
    console.error(err);
    banner(err.message || 'Błąd', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Inbox
// ═══════════════════════════════════════════════════════════════════════════

function renderInbox() {
  const list = $('#inbox-list');
  const unread = state.inbox.filter((m) => !m.is_read).length;
  const badge = $('#unread-badge');
  if (unread) { badge.textContent = String(unread); badge.style.display = ''; }
  else        { badge.style.display = 'none'; }

  if (!state.inbox.length) {
    list.innerHTML = '<div class="empty-state">Skrzynka pusta</div>';
    return;
  }
  list.innerHTML = '';
  for (const m of state.inbox) {
    const row = document.createElement('div');
    const cls = ['message'];
    if (!m.is_read)  cls.push('unread');
    if (m.is_replied) cls.push('replied');
    row.className = cls.join(' ');
    const sourceTag = m.source === 'mascot-bot'
      ? '<span class="message-source">maskotka</span>'
      : '';
    row.innerHTML = `
      <div class="message-head">
        <div class="message-from">
          <span class="message-name">${escapeHtml(m.name)}</span>
          <span class="message-email">${escapeHtml(m.email)}</span>
          ${sourceTag}
        </div>
        <span class="message-time">${formatDate(m.created_at)}</span>
      </div>
      <div class="message-body">${escapeHtml(m.message)}</div>
      <div class="message-actions">
        <a class="btn" href="mailto:${encodeURIComponent(m.email)}?subject=${encodeURIComponent('Re: BarabashFlow')}">Odpowiedz</a>
        <button class="btn ${m.is_replied ? 'ghost' : 'primary'}" data-replied="${m.id}">
          ${m.is_replied ? 'Cofnij odpowiedź' : 'Oznacz: odpowiedział'}
        </button>
        <button class="btn ghost" data-toggle="${m.id}">${m.is_read ? 'Nieprzeczytane' : 'Przeczytane'}</button>
        <span class="spread" style="flex:1"></span>
        <button class="btn danger" data-del="${m.id}">Usuń</button>
      </div>`;
    list.appendChild(row);
  }
  list.querySelectorAll('[data-toggle]').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.dataset.toggle;
      const m = state.inbox.find((x) => x.id === id);
      if (!m) return;
      const { error } = await sb.from('contact_submissions').update({ is_read: !m.is_read }).eq('id', id);
      if (!error) { m.is_read = !m.is_read; renderInbox(); }
    });
  });
  list.querySelectorAll('[data-replied]').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.dataset.replied;
      const m = state.inbox.find((x) => x.id === id);
      if (!m) return;
      const next = !m.is_replied;
      // Marking replied implicitly marks read too — it's clearly seen.
      const payload = next ? { is_replied: true, is_read: true } : { is_replied: false };
      const { error } = await sb.from('contact_submissions').update(payload).eq('id', id);
      if (!error) {
        m.is_replied = next;
        if (next) m.is_read = true;
        renderInbox();
      }
    });
  });
  list.querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Usunąć wiadomość?')) return;
      const { error } = await sb.from('contact_submissions').delete().eq('id', b.dataset.del);
      if (!error) { await loadInbox(); renderInbox(); }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Storage helpers
// ═══════════════════════════════════════════════════════════════════════════

async function uploadFile(file, folder) {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
  const safeExt = /^[a-z0-9]+$/.test(ext) ? ext : 'jpg';
  const path = `${folder}/${crypto.randomUUID()}.${safeExt}`;
  const { error } = await sb.storage.from(MEDIA_BUCKET).upload(path, file, {
    cacheControl: '3600',
    contentType: file.type || undefined,
    upsert: false,
  });
  if (error) throw error;
  return path;
}

async function removeFile(path) {
  if (!path) return;
  const { error } = await sb.storage.from(MEDIA_BUCKET).remove([path]);
  if (error) console.warn('[remove]', error);
}

function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp,image/avif,image/gif,image/svg+xml';
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Utils
// ═══════════════════════════════════════════════════════════════════════════

let bannerTimer;
function banner(text, kind) {
  const el = $('#banner');
  el.textContent = text;
  el.className = 'banner is-shown ' + (kind || '');
  clearTimeout(bannerTimer);
  if (kind === 'ok' || kind === 'error') {
    bannerTimer = setTimeout(() => el.classList.remove('is-shown'), 2400);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}
function attr(s) { return escapeHtml(s ?? ''); }
function formatDate(iso) {
  try { return new Date(iso).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' }); }
  catch { return iso; }
}
