// Usługi (services collection) + FAQ editor. Same list/editor pattern as
// projects. Services drive the home grid, /uslugi/, the project filter and
// the "Czego potrzebujesz?" select in every contact form.
import { sb, $, $$, state, banner, escapeHtml, attr, autoTranslateRow, autoTranslateList, trio, readForm, ask, slugify } from './admin-core.js?v=2026-09-12a';

const ICONS = [['site', 'Strona'], ['shop', 'Sklep'], ['platform', 'Platforma'], ['care', 'Opieka'], ['seo', 'SEO'], ['design', 'Design'], ['other', 'Inne']];
const S = { selectedId: null, draft: null, faq: [] };

export async function loadServices() {
  const { data, error } = await sb.from('services').select('*').order('sort_order');
  if (error) console.error(error);
  state.services = data || [];
}
export async function loadFaq() {
  const { data } = await sb.from('faq_items').select('*').order('placement').order('sort_order');
  S.faq = data || [];
}

export function bindServicesUI() {
  $('#sv-new')?.addEventListener('click', () => openService(null));
  $('#sv-list')?.addEventListener('click', async (e) => {
    const move = e.target.closest('[data-move]');
    if (move) { e.stopPropagation(); await moveService(move.dataset.id, Number(move.dataset.move)); return; }
    const row = e.target.closest('[data-id]');
    if (row) openService(row.dataset.id);
  });
  $('#faq-new')?.addEventListener('click', () => { S.faq.push({ id: null, placement: 'home', question_pl: '', answer_pl: '', sort_order: S.faq.length + 1, is_published: true, _open: true }); renderFaq(); });
  $('#faq-list')?.addEventListener('click', onFaqClick);
}

export function renderServiceList() {
  const list = $('#sv-list'); if (!list) return;
  $('#services-count').textContent = state.services.length ? String(state.services.length) : '';
  if (!state.services.length) { list.innerHTML = '<div class="empty-state">Brak usług</div>'; return; }
  list.innerHTML = state.services.map((s, i) => `
    <div class="lrow${s.id === S.selectedId ? ' is-active' : ''}${s.is_published ? '' : ' is-off'}" data-id="${s.id}">
      <div class="lrow-num">0${i + 1}</div>
      <div class="lrow-main">
        <div class="lrow-title">${escapeHtml(s.title_pl)}${s.is_published ? '' : ' <span class="pill">ukryta</span>'}</div>
        <div class="lrow-meta">${escapeHtml(s.price_from || '—')} · /uslugi/${escapeHtml(s.slug)}/</div>
      </div>
      <div class="lrow-actions">
        <button class="icon-btn mini" data-move="-1" data-id="${s.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn mini" data-move="1" data-id="${s.id}" ${i === state.services.length - 1 ? 'disabled' : ''}>↓</button>
      </div>
    </div>`).join('');
}

async function moveService(id, dir) {
  const arr = [...state.services]; const i = arr.findIndex((s) => s.id === id); const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  state.services = arr.map((s, idx) => ({ ...s, sort_order: idx + 1 }));
  renderServiceList();
  for (const s of state.services) await sb.from('services').update({ sort_order: s.sort_order }).eq('id', s.id);
  banner('Kolejność zapisana', 'ok');
}

function openService(id) {
  const host = $('#sv-editor'); if (!host) return;
  const s = id ? state.services.find((x) => x.id === id) : null;
  S.selectedId = id;
  S.draft = s ? { ...s } : { id: null, slug: '', title_pl: '', tagline_pl: '', description_pl: '', bullets_pl: [], bullets_en: [], bullets_ru: [], price_from: '', icon: 'site', sort_order: state.services.length + 1, is_published: true };
  const d = S.draft;
  renderServiceList();
  host.classList.remove('is-empty');
  const listVal = (l) => (d[`bullets_${l}`] || []).join('\n');
  host.innerHTML = `
    <div class="ed-head">
      <div><div class="eyebrow">${s ? 'Edycja usługi' : 'Nowa usługa'}</div><h3 id="sv-title-head">${escapeHtml(d.title_pl || 'Bez nazwy')}</h3></div>
      <div class="ed-head-actions">${s ? `<a class="btn small" href="/uslugi/${encodeURIComponent(s.slug)}/" target="_blank" rel="noopener">Podgląd ↗</a>` : ''}<button class="btn small" id="sv-close">Zamknij</button></div>
    </div>
    <div class="section">
      <div class="section-head"><span class="section-title">Podstawy</span><span class="section-aside">PL → EN/RU automatycznie</span></div>
      <div class="field"><label class="field-label">Nazwa usługi</label>${trio('title', d)}</div>
      <div class="field"><label class="field-label">Jedno zdanie (karta na stronie głównej)</label>${trio('tagline', d, { textarea: true, rows: 2 })}</div>
      <div class="row-3">
        <div class="field"><label class="field-label">Cena od</label><input data-f="price_from" value="${attr(d.price_from)}" placeholder="od 3 500 zł" /></div>
        <div class="field"><label class="field-label">Ikona</label><select data-f="icon">${ICONS.map(([k, l]) => `<option value="${k}" ${d.icon === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label class="field-label">Slug (/uslugi/…)</label><input data-f="slug" value="${attr(d.slug)}" placeholder="auto z nazwy" /></div>
      </div>
      <label class="check"><input type="checkbox" data-f="is_published" ${d.is_published ? 'checked' : ''} /> Widoczna na stronie</label>
    </div>
    <div class="section">
      <div class="section-head"><span class="section-title">Zakres — punkty</span><span class="section-aside">po jednym w linii · 4 najlepiej wygląda</span></div>
      <div class="lang-trio">
        <div class="field-input" data-lang="PL"><textarea data-f="bullets" data-l="pl" data-type="list" rows="5">${attr(listVal('pl'))}</textarea></div>
        <div class="field-input" data-lang="EN"><textarea data-f="bullets" data-l="en" data-type="list" rows="5">${attr(listVal('en'))}</textarea></div>
        <div class="field-input" data-lang="RU"><textarea data-f="bullets" data-l="ru" data-type="list" rows="5">${attr(listVal('ru'))}</textarea></div>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><span class="section-title">Opis na stronie usługi</span><span class="section-aside">markdown: **pogrubienie**, - lista</span></div>
      <div class="field">${trio('description', d, { textarea: true, rows: 12 })}</div>
    </div>
    <div class="button-row sticky-actions">
      <button class="btn danger" id="sv-delete" ${s ? '' : 'disabled'}>Usuń</button><span class="spread"></span>
      <button class="btn" id="sv-translate">Przetłumacz PL → EN/RU</button>
      <button class="btn primary" id="sv-save">Zapisz</button>
    </div>`;
  host.querySelector('[data-f="title"][data-l="pl"]').addEventListener('input', (e) => { $('#sv-title-head').textContent = e.target.value || 'Bez nazwy'; });
  $('#sv-close').addEventListener('click', closeService);
  $('#sv-save').addEventListener('click', saveService);
  $('#sv-delete').addEventListener('click', deleteService);
  $('#sv-translate').addEventListener('click', async () => {
    readForm(host, S.draft);
    banner('Tłumaczenie…', null);
    try {
      await autoTranslateRow(S.draft, ['title', 'tagline', 'description'], 'opis usługi studia web-developmentu (strony, sklepy, platformy)', true);
      await autoTranslateList(S.draft, 'bullets', 'krótkie punkty zakresu usługi web-developmentu', true);
      const top = host.scrollTop; openService(id); Object.assign(S.draft, S.draft); host.scrollTop = top;
      banner('Przetłumaczono — sprawdź i zapisz', 'ok');
    } catch (err) { banner(err.message || 'Błąd tłumaczenia', 'error'); }
  });
}
function closeService() {
  S.selectedId = null; S.draft = null;
  const host = $('#sv-editor'); host.classList.add('is-empty');
  host.innerHTML = '<div class="placeholder-glyph">✦</div><div><div class="pitch">Wybierz usługę</div><div class="pitch-sub">albo dodaj nową. Usługi pokazują się na stronie głównej, w /uslugi/ i w formularzu kontaktowym.</div></div>';
  renderServiceList();
}
async function saveService() {
  const host = $('#sv-editor'); readForm(host, S.draft);
  const d = S.draft;
  d.is_published = !!host.querySelector('[data-f="is_published"]').checked;
  if (!d.title_pl) { banner('Nazwa PL jest wymagana', 'error'); return; }
  if (!d.slug) d.slug = slugify(d.title_pl);
  banner('Zapisywanie…', null);
  try {
    try { await autoTranslateRow(d, ['title', 'tagline', 'description'], 'opis usługi studia web-developmentu'); await autoTranslateList(d, 'bullets', 'krótkie punkty zakresu usługi'); }
    catch (e) { console.warn(e); }
    const payload = {
      slug: d.slug, title_pl: d.title_pl, title_en: d.title_en || null, title_ru: d.title_ru || null,
      tagline_pl: d.tagline_pl || null, tagline_en: d.tagline_en || null, tagline_ru: d.tagline_ru || null,
      description_pl: d.description_pl || null, description_en: d.description_en || null, description_ru: d.description_ru || null,
      bullets_pl: d.bullets_pl || [], bullets_en: d.bullets_en || [], bullets_ru: d.bullets_ru || [],
      price_from: d.price_from || null, icon: d.icon || null, sort_order: d.sort_order ?? 0, is_published: !!d.is_published,
    };
    let id = d.id;
    if (id) { const { error } = await sb.from('services').update(payload).eq('id', id); if (error) throw error; }
    else { const { data, error } = await sb.from('services').insert(payload).select('id').single(); if (error) throw error; id = data.id; }
    await loadServices(); openService(id); banner('Zapisano', 'ok');
  } catch (err) { banner(err.message || 'Błąd zapisu', 'error'); }
}
async function deleteService() {
  const d = S.draft; if (!d?.id) return;
  if (!ask(`Usunąć usługę „${d.title_pl}”?`)) return;
  const { error } = await sb.from('services').delete().eq('id', d.id);
  if (error) { banner(error.message, 'error'); return; }
  await loadServices(); closeService(); banner('Usunięto', 'ok');
}

// ── FAQ ─────────────────────────────────────────────────────────────────────
export function renderFaq() {
  const list = $('#faq-list'); if (!list) return;
  if (!S.faq.length) { list.innerHTML = '<div class="empty-state">Brak pytań</div>'; return; }
  list.innerHTML = S.faq.map((f, i) => `
    <details class="faq-ed${f.is_published ? '' : ' is-off'}" data-i="${i}" ${f._open ? 'open' : ''}>
      <summary><span class="faq-ed-q">${escapeHtml(f.question_pl || 'Nowe pytanie')}</span><span class="faq-ed-meta">${f.is_published ? '' : 'ukryte · '}#${f.sort_order}</span></summary>
      <div class="faq-ed-body">
        <div class="field"><label class="field-label">Pytanie</label>${trio('question', f)}</div>
        <div class="field"><label class="field-label">Odpowiedź</label>${trio('answer', f, { textarea: true, rows: 4 })}</div>
        <div class="row-3">
          <div class="field"><label class="field-label">Kolejność</label><input data-f="sort_order" data-type="number" type="number" value="${attr(f.sort_order)}" /></div>
          <div class="field"><label class="field-label">Gdzie</label><select data-f="placement"><option value="home" ${f.placement === 'home' ? 'selected' : ''}>Strona główna + Usługi</option><option value="contact" ${f.placement === 'contact' ? 'selected' : ''}>Tylko kontakt</option></select></div>
          <label class="check" style="align-self:end"><input type="checkbox" data-f="is_published" ${f.is_published ? 'checked' : ''} /> Widoczne</label>
        </div>
        <div class="button-row"><button class="btn small danger" data-faq-del="${i}">Usuń</button><span class="spread"></span><button class="btn small primary" data-faq-save="${i}">Zapisz</button></div>
      </div>
    </details>`).join('');
}
async function onFaqClick(e) {
  const save = e.target.closest('[data-faq-save]'); const del = e.target.closest('[data-faq-del]');
  if (!save && !del) return;
  const i = Number((save || del).dataset.faqSave ?? (save || del).dataset.faqDel);
  const f = S.faq[i]; const root = e.target.closest('.faq-ed');
  if (del) {
    if (f.id) { if (!ask('Usunąć pytanie?')) return; const { error } = await sb.from('faq_items').delete().eq('id', f.id); if (error) { banner(error.message, 'error'); return; } }
    S.faq.splice(i, 1); renderFaq(); banner('Usunięto', 'ok'); return;
  }
  readForm(root, f); f.is_published = !!root.querySelector('[data-f="is_published"]').checked;
  if (!f.question_pl || !f.answer_pl) { banner('Pytanie i odpowiedź PL są wymagane', 'error'); return; }
  banner('Zapisywanie…', null);
  try { await autoTranslateRow(f, ['question', 'answer'], 'FAQ na stronie studia web-developmentu'); } catch {}
  const payload = { placement: f.placement || 'home', sort_order: f.sort_order ?? 0, is_published: !!f.is_published, question_pl: f.question_pl, question_en: f.question_en || null, question_ru: f.question_ru || null, answer_pl: f.answer_pl, answer_en: f.answer_en || null, answer_ru: f.answer_ru || null };
  const q = f.id ? sb.from('faq_items').update(payload).eq('id', f.id).select().single() : sb.from('faq_items').insert(payload).select().single();
  const { data, error } = await q;
  if (error) { banner(error.message, 'error'); return; }
  S.faq[i] = { ...data, _open: false }; renderFaq(); banner('Zapisano', 'ok');
}
