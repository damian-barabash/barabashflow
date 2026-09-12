// Projekty — list on the left, full editor on the right. Replaces the old
// draggable graph editor (the public graph is gone). Unlimited photos,
// first = cover unless cover_path is set; case-study fields (client, year,
// services, stack, results, tagline, long body); PL-first with AI fill of
// EN/RU on save.
import { sb, $, $$, state, banner, escapeHtml, attr, mediaUrl, uploadImage, removeMedia, pickFile, autoTranslateRow, trio, readForm, ask, slugify } from './admin-core.js?v=2026-09-12a';

const CATS = [['site', 'Strona'], ['shop', 'Sklep'], ['platform', 'Platforma'], ['app', 'Aplikacja'], ['panel', 'Panel'], ['other', 'Inne']];
const CAT_LABEL = { site: ['Strona', 'Website', 'Сайт'], shop: ['Sklep', 'Store', 'Магазин'], platform: ['Platforma', 'Platform', 'Платформа'], app: ['Aplikacja', 'App', 'Приложение'], panel: ['Panel', 'Panel', 'Панель'], other: ['Projekt', 'Project', 'Проект'] };

const P = { selectedId: null, draft: null, photos: [], filter: '' };

export async function loadProjects() {
  const [{ data: projects, error }, { data: photos }] = await Promise.all([
    sb.from('projects').select('*').order('sort_order').order('created_at'),
    sb.from('project_photos').select('*').order('sort_order'),
  ]);
  if (error) { console.error(error); banner(error.message, 'error'); }
  state.projects = projects || [];
  state.photosByProject.clear();
  for (const ph of photos || []) {
    if (!state.photosByProject.has(ph.project_id)) state.photosByProject.set(ph.project_id, []);
    state.photosByProject.get(ph.project_id).push(ph);
  }
}

export function bindProjectsUI() {
  $('#pr-new')?.addEventListener('click', () => openEditor(null));
  $('#pr-search')?.addEventListener('input', (e) => { P.filter = e.target.value.toLowerCase(); renderProjectList(); });
  $('#pr-list')?.addEventListener('click', async (e) => {
    const move = e.target.closest('[data-move]');
    if (move) { e.stopPropagation(); await moveProject(move.dataset.id, Number(move.dataset.move)); return; }
    const row = e.target.closest('[data-id]');
    if (row) openEditor(row.dataset.id);
  });
}

export function renderProjectList() {
  const list = $('#pr-list'); if (!list) return;
  $('#projects-count').textContent = state.projects.length ? String(state.projects.length) : '';
  const items = state.projects.filter((p) => !P.filter || `${p.title_pl} ${p.client || ''} ${p.slug}`.toLowerCase().includes(P.filter));
  if (!items.length) { list.innerHTML = '<div class="empty-state">Brak projektów</div>'; return; }
  list.innerHTML = items.map((p, i) => {
    const cover = p.cover_path || state.photosByProject.get(p.id)?.[0]?.storage_path;
    return `<div class="lrow${p.id === P.selectedId ? ' is-active' : ''}${p.is_published ? '' : ' is-off'}" data-id="${p.id}">
      <div class="lrow-thumb" style="${cover ? `background-image:url('${mediaUrl(cover)}')` : ''}"></div>
      <div class="lrow-main">
        <div class="lrow-title">${escapeHtml(p.title_pl)} ${p.is_featured ? '<span class="pill lime" title="Wyróżniony na stronie głównej">★</span>' : ''}${p.is_published ? '' : '<span class="pill">ukryty</span>'}</div>
        <div class="lrow-meta">${escapeHtml(p.category_pl || CAT_LABEL[p.category_key]?.[0] || '')}${p.client ? ' · ' + escapeHtml(p.client) : ''}${p.year ? ' · ' + p.year : ''}</div>
      </div>
      <div class="lrow-actions">
        <button class="icon-btn mini" data-move="-1" data-id="${p.id}" title="Wyżej" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn mini" data-move="1" data-id="${p.id}" title="Niżej" ${i === items.length - 1 ? 'disabled' : ''}>↓</button>
      </div>
    </div>`;
  }).join('');
}

async function moveProject(id, dir) {
  const arr = [...state.projects];
  const i = arr.findIndex((p) => p.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  const updates = arr.map((p, idx) => ({ id: p.id, sort_order: idx + 1 }));
  state.projects = arr.map((p, idx) => ({ ...p, sort_order: idx + 1 }));
  renderProjectList();
  for (const u of updates) await sb.from('projects').update({ sort_order: u.sort_order }).eq('id', u.id);
  banner('Kolejność zapisana', 'ok');
}

function emptyDraft() {
  return {
    id: null, slug: '', title_pl: '', title_en: '', title_ru: '', category_key: 'site', category_pl: 'Strona', category_en: 'Website', category_ru: 'Сайт',
    tagline_pl: '', tagline_en: '', tagline_ru: '', description_pl: '', description_en: '', description_ru: '', body_pl: '', body_en: '', body_ru: '',
    url: '', client: '', year: new Date().getFullYear(), services: [], stack: [], results: [], accent_color: '#030712', cover_path: null,
    sort_order: state.projects.length + 1, is_published: true, is_featured: false,
  };
}

export function openEditor(id) {
  const host = $('#pr-editor'); if (!host) return;
  const p = id ? state.projects.find((x) => x.id === id) : null;
  P.selectedId = id;
  P.draft = p ? { ...p, services: p.services || [], stack: p.stack || [], results: Array.isArray(p.results) ? p.results.map((r) => ({ ...r })) : [] } : emptyDraft();
  P.photos = (id ? (state.photosByProject.get(id) || []) : []).map((ph) => ({ existing: ph }));
  renderProjectList();
  const d = P.draft;
  host.classList.remove('is-empty');
  host.innerHTML = `
    <div class="ed-head">
      <div>
        <div class="eyebrow">${p ? 'Edycja projektu' : 'Nowy projekt'}</div>
        <h3 id="pr-title-head">${escapeHtml(d.title_pl || 'Bez tytułu')}</h3>
      </div>
      <div class="ed-head-actions">
        ${p ? `<a class="btn small" href="/projekty/${encodeURIComponent(p.slug)}/" target="_blank" rel="noopener">Podgląd ↗</a>` : ''}
        <button class="btn small" id="pr-close">Zamknij</button>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><span class="section-title">Podstawy</span><span class="section-aside">wpisuj po polsku — EN/RU dotłumaczą się same</span></div>
      <div class="field"><label class="field-label">Tytuł</label>${trio('title', d, { placeholder: 'np. Sake Control' })}</div>
      <div class="field"><label class="field-label">Jedno zdanie o projekcie (karta + nagłówek strony)</label>${trio('tagline', d, { textarea: true, rows: 2, placeholder: 'Platforma monitoringu stron i serwerów 24/7 z alertami e-mail.' })}</div>
      <div class="row-3">
        <div class="field"><label class="field-label">Typ</label><select data-f="category_key">${CATS.map(([k, l]) => `<option value="${k}" ${d.category_key === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label class="field-label">Klient</label><input data-f="client" value="${attr(d.client)}" placeholder="np. Autoforum Warszawa" /></div>
        <div class="field"><label class="field-label">Rok</label><input data-f="year" data-type="number" type="number" value="${attr(d.year ?? '')}" /></div>
      </div>
      <div class="field"><label class="field-label">Etykieta typu (własna, opcjonalnie)</label>${trio('category', d, { placeholder: 'np. Strona + CMS' })}</div>
      <div class="row-3">
        <div class="field"><label class="field-label">Link do projektu</label><input data-f="url" value="${attr(d.url)}" placeholder="https://…" /></div>
        <div class="field"><label class="field-label">Slug (adres /projekty/…)</label><input data-f="slug" value="${attr(d.slug)}" placeholder="auto z tytułu" /></div>
        <div class="field"><label class="field-label">Kolejność</label><input data-f="sort_order" data-type="number" type="number" value="${attr(d.sort_order ?? 0)}" /></div>
      </div>
      <div class="row-2">
        <label class="check"><input type="checkbox" data-f="is_published" ${d.is_published ? 'checked' : ''} /> Opublikowany na stronie</label>
        <label class="check"><input type="checkbox" data-f="is_featured" ${d.is_featured ? 'checked' : ''} /> Wyróżniony na stronie głównej (max 4)</label>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><span class="section-title">Usługi i technologie</span><span class="section-aside">filtr na /projekty/ i linki na stronie projektu</span></div>
      <div class="conn-chips" id="pr-services">
        ${state.services.map((s) => `<button type="button" class="conn-chip${d.services.includes(s.slug) ? ' is-on' : ''}" data-svc="${attr(s.slug)}"><span class="chip-dot"></span>${escapeHtml(s.title_pl)}</button>`).join('') || '<span class="coords">Najpierw dodaj usługi w zakładce Usługi.</span>'}
      </div>
      <div class="field"><label class="field-label">Technologie (po przecinku — chipy na karcie)</label><input data-f="stack" data-type="csv" value="${attr(d.stack.join(', '))}" placeholder="Astro, Supabase, PL/EN" /></div>
    </div>

    <div class="section">
      <div class="section-head"><span class="section-title">Opis</span><span class="section-aside">markdown mile widziany: **pogrubienie**, - lista, ### nagłówek</span></div>
      <div class="field"><label class="field-label">Opis projektu (strona projektu)</label>${trio('description', d, { textarea: true, rows: 8 })}</div>
      <details class="adv"><summary>Osobny opis szczegółowy (markdown, opcjonalnie — jeśli pusty, używany jest opis powyżej)</summary>
        <div class="field">${trio('body', d, { textarea: true, rows: 8 })}</div>
      </details>
    </div>

    <div class="section">
      <div class="section-head"><span class="section-title">Efekty / fakty</span><span class="section-aside">3 kafelki na karcie: wartość + podpis. Tylko prawdziwe liczby.</span></div>
      <div id="pr-results" class="results-ed"></div>
      <div class="button-row"><button type="button" class="btn small" id="pr-add-result">+ Dodaj kafelek</button></div>
    </div>

    <div class="section">
      <div class="section-head"><span class="section-title">Zdjęcia</span><span class="section-aside">pierwsze = okładka · przeciągnij lub użyj strzałek · WebP automatycznie</span></div>
      <div class="photo-grid" id="pr-photos"></div>
      <div class="button-row"><button type="button" class="btn small" id="pr-add-photos">+ Dodaj zdjęcia</button><span class="coords">JPG / PNG / WebP — dowolna liczba, do 10 MB każde</span></div>
    </div>

    <div class="button-row sticky-actions">
      <button class="btn danger" id="pr-delete" ${p ? '' : 'disabled'}>Usuń projekt</button>
      <span class="spread"></span>
      <button class="btn" id="pr-translate">Przetłumacz PL → EN/RU</button>
      <button class="btn primary" id="pr-save">Zapisz</button>
    </div>`;

  // live title
  host.querySelector('[data-f="title"][data-l="pl"]').addEventListener('input', (e) => { $('#pr-title-head').textContent = e.target.value || 'Bez tytułu'; });
  host.querySelector('[data-f="category_key"]').addEventListener('change', (e) => {
    const lab = CAT_LABEL[e.target.value]; if (!lab) return;
    ['pl', 'en', 'ru'].forEach((l, i) => { const el = host.querySelector(`[data-f="category"][data-l="${l}"]`); if (el && !el.value.trim()) el.value = lab[i]; });
  });
  $('#pr-services').addEventListener('click', (e) => {
    const c = e.target.closest('[data-svc]'); if (!c) return;
    c.classList.toggle('is-on');
  });
  renderResults();
  $('#pr-add-result').addEventListener('click', () => { P.draft.results.push({ value: '', label_pl: '', label_en: '', label_ru: '' }); renderResults(); });
  $('#pr-results').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm-result]'); if (!rm) return;
    syncResults(); P.draft.results.splice(Number(rm.dataset.rmResult), 1); renderResults();
  });
  renderPhotos();
  $('#pr-add-photos').addEventListener('click', async () => {
    const files = await pickFile(undefined, true);
    for (const f of files || []) P.photos.push({ file: f, url: URL.createObjectURL(f) });
    renderPhotos();
  });
  $('#pr-close').addEventListener('click', closeEditor);
  $('#pr-save').addEventListener('click', saveProject);
  $('#pr-delete').addEventListener('click', deleteProject);
  $('#pr-translate').addEventListener('click', async () => {
    collectDraft();
    banner('Tłumaczenie…', null);
    try {
      const n = await autoTranslateRow(P.draft, ['title', 'tagline', 'category', 'description', 'body'], 'karta projektu w portfolio studia web-developmentu (tytuł, jedno zdanie, etykieta typu, opis)', true);
      for (const r of P.draft.results) await autoTranslateRow(r, ['label'], 'krótki podpis pod liczbą-efektem projektu', true);
      openEditorKeepScroll();
      banner(`Przetłumaczono ${n} pól — sprawdź i zapisz`, 'ok');
    } catch (err) { banner(err.message || 'Błąd tłumaczenia', 'error'); }
  });
  host.scrollTop = 0;
}

function openEditorKeepScroll() {
  const host = $('#pr-editor'); const top = host.scrollTop;
  const d = P.draft, photos = P.photos;
  const id = P.selectedId;
  // re-render with the draft values (not DB values)
  const saved = state.projects.find((x) => x.id === id);
  if (saved) Object.assign(saved, d);
  openEditor(id);
  P.draft = d; P.photos = photos;
  renderResults(); renderPhotos();
  host.scrollTop = top;
}

function renderResults() {
  const wrap = $('#pr-results'); if (!wrap) return;
  const rs = P.draft.results;
  wrap.innerHTML = rs.length ? rs.map((r, i) => `
    <div class="result-row" data-i="${i}">
      <input class="result-value" data-r="value" value="${attr(r.value)}" placeholder="np. 24/7" />
      <div class="lang-trio">
        <div class="field-input" data-lang="PL"><input data-r="label_pl" value="${attr(r.label_pl)}" placeholder="podpis" /></div>
        <div class="field-input" data-lang="EN"><input data-r="label_en" value="${attr(r.label_en)}" /></div>
        <div class="field-input" data-lang="RU"><input data-r="label_ru" value="${attr(r.label_ru)}" /></div>
      </div>
      <button type="button" class="icon-btn mini" data-rm-result="${i}" title="Usuń">×</button>
    </div>`).join('') : '<span class="coords">Brak kafelków — dodaj np. „3 języki”, „CMS”, „B2B”.</span>';
}
function syncResults() {
  $$('#pr-results .result-row').forEach((row) => {
    const r = P.draft.results[Number(row.dataset.i)]; if (!r) return;
    $$('[data-r]', row).forEach((el) => { r[el.dataset.r] = el.value.trim(); });
  });
}

function renderPhotos() {
  const wrap = $('#pr-photos'); if (!wrap) return;
  const cover = P.draft.cover_path;
  wrap.innerHTML = P.photos.map((ph, i) => {
    const url = ph.file ? ph.url : mediaUrl(ph.existing.storage_path);
    const isCover = cover ? ph.existing?.storage_path === cover : i === 0;
    return `<div class="photo-slot has-image${isCover ? ' is-cover' : ''}" style="background-image:url('${url}')" data-i="${i}" draggable="true">
      <span class="ph-badge">${isCover ? 'okładka' : i + 1}</span>
      <div class="ph-tools">
        <button type="button" data-ph="left" title="W lewo" ${i === 0 ? 'disabled' : ''}>←</button>
        <button type="button" data-ph="cover" title="Ustaw jako okładkę">★</button>
        <button type="button" data-ph="right" title="W prawo" ${i === P.photos.length - 1 ? 'disabled' : ''}>→</button>
        <button type="button" data-ph="rm" title="Usuń" class="rm">×</button>
      </div>
    </div>`;
  }).join('') + `<div class="photo-slot is-add" id="pr-photo-add"><span>+ zdjęcie</span></div>`;
  $('#pr-photo-add').addEventListener('click', () => $('#pr-add-photos').click());
  wrap.onclick = (e) => {
    const b = e.target.closest('[data-ph]'); if (!b) return;
    const slot = b.closest('[data-i]'); const i = Number(slot.dataset.i);
    const act = b.dataset.ph;
    if (act === 'rm') { const ph = P.photos[i]; if (ph.existing) ph.removed = true, (P.draft._removedPhotos ||= []).push(ph.existing); P.photos.splice(i, 1); }
    if (act === 'left' && i > 0) [P.photos[i - 1], P.photos[i]] = [P.photos[i], P.photos[i - 1]];
    if (act === 'right' && i < P.photos.length - 1) [P.photos[i + 1], P.photos[i]] = [P.photos[i], P.photos[i + 1]];
    if (act === 'cover') { const ph = P.photos[i]; P.draft.cover_path = ph.existing ? ph.existing.storage_path : null; if (!ph.existing) { P.photos.splice(i, 1); P.photos.unshift(ph); } }
    renderPhotos();
  };
  // drag & drop reorder
  let dragI = null;
  $$('.photo-slot[draggable]', wrap).forEach((el) => {
    el.addEventListener('dragstart', () => { dragI = Number(el.dataset.i); el.classList.add('is-dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('is-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('is-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault(); const to = Number(el.dataset.i);
      if (dragI === null || dragI === to) return;
      const [m] = P.photos.splice(dragI, 1); P.photos.splice(to, 0, m); dragI = null; renderPhotos();
    });
  });
}

function collectDraft() {
  const host = $('#pr-editor');
  readForm(host, P.draft);
  P.draft.services = $$('#pr-services .conn-chip.is-on').map((c) => c.dataset.svc);
  P.draft.stack = P.draft.stack || [];
  syncResults();
  P.draft.is_published = !!host.querySelector('[data-f="is_published"]').checked;
  P.draft.is_featured = !!host.querySelector('[data-f="is_featured"]').checked;
  if (!P.draft.slug) P.draft.slug = slugify(P.draft.title_pl);
}

function closeEditor() {
  P.selectedId = null; P.draft = null; P.photos = [];
  const host = $('#pr-editor');
  host.classList.add('is-empty');
  host.innerHTML = `<div class="placeholder-glyph">✦</div><div><div class="pitch">Wybierz projekt z listy</div><div class="pitch-sub">albo kliknij <strong>+ Nowy projekt</strong>. Wpisuj tylko po polsku — wersje EN i RU uzupełnią się same przy zapisie.</div></div>`;
  renderProjectList();
}

async function saveProject() {
  collectDraft();
  const d = P.draft;
  if (!d.title_pl) { banner('Tytuł PL jest wymagany', 'error'); return; }
  banner('Zapisywanie…', null);
  try {
    try {
      banner('Tłumaczenie PL → EN/RU…', null);
      await autoTranslateRow(d, ['title', 'tagline', 'category', 'description', 'body'], 'karta projektu w portfolio studia web-developmentu');
      for (const r of d.results) if (r.label_pl) await autoTranslateRow(r, ['label'], 'krótki podpis pod liczbą-efektem projektu');
    } catch (e) { console.warn('translate', e); banner('Tłumaczenie niedostępne — zapisuję bez niego', null); }

    const payload = {
      slug: d.slug, title_pl: d.title_pl, title_en: d.title_en || null, title_ru: d.title_ru || null,
      category_key: d.category_key || 'site', category_pl: d.category_pl || null, category_en: d.category_en || null, category_ru: d.category_ru || null,
      tagline_pl: d.tagline_pl || null, tagline_en: d.tagline_en || null, tagline_ru: d.tagline_ru || null,
      description_pl: d.description_pl || null, description_en: d.description_en || null, description_ru: d.description_ru || null,
      body_pl: d.body_pl || null, body_en: d.body_en || null, body_ru: d.body_ru || null,
      url: d.url || null, client: d.client || null, year: d.year || null, services: d.services, stack: d.stack,
      results: d.results.filter((r) => r.value), accent_color: d.accent_color || null,
      sort_order: d.sort_order ?? 0, is_published: !!d.is_published, is_featured: !!d.is_featured, cover_path: d.cover_path || null,
    };
    let id = d.id;
    if (id) { const { error } = await sb.from('projects').update(payload).eq('id', id); if (error) throw error; }
    else { const { data, error } = await sb.from('projects').insert(payload).select('id').single(); if (error) throw error; id = data.id; }

    // photos: upload new, delete removed, renumber all
    for (const ph of d._removedPhotos || []) { await sb.from('project_photos').delete().eq('id', ph.id); await removeMedia(ph.storage_path); }
    for (let i = 0; i < P.photos.length; i++) {
      const ph = P.photos[i];
      if (ph.file) {
        banner(`Wysyłanie zdjęcia ${i + 1}/${P.photos.length}…`, null);
        const path = await uploadImage(ph.file, `project/${id}`);
        const { data, error } = await sb.from('project_photos').insert({ project_id: id, storage_path: path, sort_order: i }).select().single();
        if (error) throw error;
        ph.existing = data; ph.file = null;
      } else if (ph.existing.sort_order !== i) {
        await sb.from('project_photos').update({ sort_order: i }).eq('id', ph.existing.id);
      }
    }
    await loadProjects();
    openEditor(id);
    banner('Zapisano — na stronie po najbliższej przebudowie', 'ok');
  } catch (err) { console.error(err); banner(err.message || 'Błąd zapisu', 'error'); }
}

async function deleteProject() {
  const d = P.draft; if (!d?.id) return;
  if (!ask(`Usunąć projekt „${d.title_pl}” razem ze zdjęciami?`)) return;
  banner('Usuwanie…', null);
  try {
    const photos = state.photosByProject.get(d.id) || [];
    await Promise.all(photos.map((p) => removeMedia(p.storage_path)));
    const { error } = await sb.from('projects').delete().eq('id', d.id);
    if (error) throw error;
    await loadProjects(); closeEditor(); banner('Usunięto', 'ok');
  } catch (err) { banner(err.message || 'Błąd', 'error'); }
}
