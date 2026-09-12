// CRM — clients with a sales pipeline (lead → kontakt → oferta → wygrane →
// w realizacji → zakończone / przegrane / archiwum), tags, next action with
// due date, deal value, activity timeline (notes / calls / e-mails /
// meetings / status changes), files (private crm-files bucket, signed
// URLs) and the enquiries linked to the client. List + Kanban views.
import { sb, $, $$, banner, escapeHtml, attr, fmtDate, relDays, modal, ask, readForm } from './admin-core.js?v=2026-09-12b';

export const STATUSES = [
  ['lead', 'Lead', 'Nowy kontakt — jeszcze bez rozmowy'],
  ['contact', 'Rozmowa', 'Jesteśmy w kontakcie, zbieram brief'],
  ['offer', 'Oferta', 'Wycena wysłana, czekam na decyzję'],
  ['won', 'Wygrane', 'Zaakceptowane — do zaplanowania'],
  ['active', 'W realizacji', 'Projekt w toku'],
  ['done', 'Zakończone', 'Wdrożone, opieka / follow-up'],
  ['lost', 'Przegrane', 'Nie doszło do współpracy'],
  ['archive', 'Archiwum', 'Nieaktywne'],
];
const KANBAN = ['lead', 'contact', 'offer', 'won', 'active', 'done'];
const KINDS = [['note', 'Notatka'], ['call', 'Telefon'], ['email', 'E-mail'], ['meeting', 'Spotkanie'], ['task', 'Zadanie'], ['status', 'Zmiana statusu']];
const KIND_ICON = { note: '✎', call: '☎', email: '✉', meeting: '◷', task: '☐', status: '⇄', file: '⎘' };

const C = { clients: [], tags: [], view: 'list', q: '', status: 'all', tag: '' };

export async function loadCrm() {
  const [{ data: clients, error }, { data: tags }] = await Promise.all([
    sb.from('crm_clients').select('*').order('updated_at', { ascending: false }),
    sb.from('crm_tags').select('*').order('sort_order'),
  ]);
  if (error) console.error(error);
  C.clients = clients || []; C.tags = tags || [];
  const n = C.clients.filter((c) => !['archive', 'lost'].includes(c.status)).length;
  $('#crm-count').textContent = n ? String(n) : '';
}

export function bindCrmUI() {
  $('#crm-new')?.addEventListener('click', () => openClient(null));
  $('#crm-search')?.addEventListener('input', (e) => { C.q = e.target.value.toLowerCase(); renderCrm(); });
  $('#crm-status')?.addEventListener('click', (e) => { const b = e.target.closest('[data-status]'); if (!b) return; C.status = b.dataset.status; $$('#crm-status button').forEach((x) => x.classList.toggle('is-active', x === b)); renderCrm(); });
  $('#crm-view')?.addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (!b) return; C.view = b.dataset.view; $$('#crm-view button').forEach((x) => x.classList.toggle('is-active', x === b)); renderCrm(); });
  $('#crm-tag')?.addEventListener('change', (e) => { C.tag = e.target.value; renderCrm(); });
  $('#crm-body')?.addEventListener('click', (e) => { const row = e.target.closest('[data-client]'); if (row && !e.target.closest('a')) openClient(row.dataset.client); });
  $('#crm-export')?.addEventListener('click', exportCsv);
}

function filtered() {
  return C.clients.filter((c) => {
    if (C.status !== 'all' && c.status !== C.status) return false;
    if (C.status === 'all' && ['archive', 'lost'].includes(c.status)) return false;
    if (C.tag && !(c.tags || []).includes(C.tag)) return false;
    if (C.q && !`${c.name} ${c.email} ${c.company || ''} ${c.phone || ''} ${c.notes || ''}`.toLowerCase().includes(C.q)) return false;
    return true;
  });
}
const statusLabel = (s) => STATUSES.find((x) => x[0] === s)?.[1] || s;
function dueBadge(c) {
  if (!c.next_action_at) return '';
  const d = relDays(c.next_action_at);
  const cls = d < 0 ? 'overdue' : d === 0 ? 'today' : '';
  const txt = d < 0 ? `${-d} dn. po terminie` : d === 0 ? 'dziś' : d === 1 ? 'jutro' : `za ${d} dn.`;
  return `<span class="due ${cls}" title="${attr(c.next_action || '')}">◷ ${txt}${c.next_action ? ' · ' + escapeHtml(c.next_action) : ''}</span>`;
}
const tagChips = (c) => (c.tags || []).map((t) => { const tg = C.tags.find((x) => x.slug === t); return `<span class="pill" style="${tg?.color ? `border-color:${tg.color};color:${tg.color}` : ''}">${escapeHtml(tg?.label_pl || t)}</span>`; }).join('');

export function renderCrm() {
  const body = $('#crm-body'); if (!body) return;
  const tagSel = $('#crm-tag');
  if (tagSel && tagSel.options.length <= 1) tagSel.innerHTML = '<option value="">Wszystkie tagi</option>' + C.tags.map((t) => `<option value="${attr(t.slug)}">${escapeHtml(t.label_pl)}</option>`).join('');
  const items = filtered();
  $('#crm-aside').textContent = `${items.length} klientów`;
  // due today / overdue summary
  const due = C.clients.filter((c) => c.next_action_at && relDays(c.next_action_at) <= 0 && !['archive', 'lost', 'done'].includes(c.status));
  $('#crm-due').innerHTML = due.length ? `<strong>${due.length}</strong> do zrobienia dziś / po terminie: ${due.slice(0, 5).map((c) => `<a href="#" data-client="${c.id}">${escapeHtml(c.name)}</a>`).join(', ')}${due.length > 5 ? '…' : ''}` : 'Brak zaległych działań — czysto.';
  if (C.view === 'board') { renderBoard(body, items); return; }
  if (!items.length) { body.innerHTML = '<div class="empty-state">Brak klientów</div>'; return; }
  body.innerHTML = `<div class="crm-table">
    <div class="crm-tr crm-th"><span>Klient</span><span>Status</span><span>Kontakt</span><span>Następny krok</span><span>Wartość</span><span>Ostatni kontakt</span></div>
    ${items.map((c) => `<div class="crm-tr" data-client="${c.id}">
      <span><strong>${escapeHtml(c.name)}</strong>${c.company ? `<br><small>${escapeHtml(c.company)}</small>` : ''}<div class="tags">${tagChips(c)}</div></span>
      <span><span class="status s-${c.status}">${statusLabel(c.status)}</span></span>
      <span><a href="mailto:${attr(c.email)}">${escapeHtml(c.email)}</a>${c.phone ? `<br><a href="tel:${attr(c.phone)}">${escapeHtml(c.phone)}</a>` : ''}</span>
      <span>${dueBadge(c) || '<small class="soft">—</small>'}</span>
      <span>${c.value_pln ? Number(c.value_pln).toLocaleString('pl-PL') + ' zł' : '<small class="soft">—</small>'}</span>
      <span><small>${c.last_contact_at ? fmtDate(c.last_contact_at, false) : '—'}</small></span>
    </div>`).join('')}
  </div>`;
}

function renderBoard(body, items) {
  body.innerHTML = `<div class="kanban">${KANBAN.map((s) => {
    const col = items.filter((c) => c.status === s);
    return `<div class="kcol" data-col="${s}"><div class="kcol-head"><span>${statusLabel(s)}</span><span class="count">${col.length}</span></div>
      ${col.map((c) => `<div class="kcard" draggable="true" data-client="${c.id}"><strong>${escapeHtml(c.name)}</strong>${c.company ? `<small>${escapeHtml(c.company)}</small>` : ''}${c.value_pln ? `<small>${Number(c.value_pln).toLocaleString('pl-PL')} zł</small>` : ''}${dueBadge(c)}<div class="tags">${tagChips(c)}</div></div>`).join('')}
    </div>`;
  }).join('')}</div>`;
  let dragId = null;
  $$('.kcard', body).forEach((el) => {
    el.addEventListener('dragstart', () => { dragId = el.dataset.client; el.classList.add('is-dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
  });
  $$('.kcol', body).forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('is-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('is-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault(); col.classList.remove('is-over');
      if (!dragId) return; await setStatus(dragId, col.dataset.col); dragId = null;
    });
  });
}

async function setStatus(id, status) {
  const c = C.clients.find((x) => x.id === id); if (!c || c.status === status) return;
  const from = c.status;
  const { error } = await sb.from('crm_clients').update({ status }).eq('id', id);
  if (error) { banner(error.message, 'error'); return; }
  c.status = status;
  await sb.from('crm_activities').insert({ client_id: id, kind: 'status', body: `${statusLabel(from)} → ${statusLabel(status)}` });
  renderCrm(); banner(`${c.name}: ${statusLabel(status)}`, 'ok');
}

// Create/find a client from an inbox message (used by admin-inbox).
export async function upsertClientFromMessage(m) {
  const email = (m.email || '').trim().toLowerCase();
  let { data: existing } = await sb.from('crm_clients').select('*').ilike('email', email).maybeSingle();
  if (!existing) {
    const { data, error } = await sb.from('crm_clients').insert({
      name: m.name || email, email, phone: m.phone || null, company: m.company || null, source: 'website', status: 'lead', tags: ['lead'],
      notes: [m.service ? `Usługa: ${m.service}` : '', m.budget ? `Budżet: ${m.budget}` : ''].filter(Boolean).join('\n') || null,
    }).select().single();
    if (error) throw error;
    existing = data;
  }
  await sb.from('crm_activities').insert({ client_id: existing.id, kind: 'email', body: `Zapytanie ze strony (${m.source || 'formularz'}):\n${m.message || ''}`, happened_at: m.created_at, meta: { submission_id: m.id } });
  await loadCrm(); renderCrm();
  return existing;
}

// ── Client drawer ───────────────────────────────────────────────────────────
export async function openClient(id) {
  const c = id ? C.clients.find((x) => x.id === id) : null;
  const d = c ? { ...c, tags: [...(c.tags || [])] } : { id: null, name: '', email: '', phone: '', company: '', position: '', website: '', source: 'manual', status: 'lead', tags: [], notes: '', value_pln: null, next_action: '', next_action_at: null };
  const m = modal(`
    <div class="modal-head">
      <div><div class="eyebrow">${c ? 'Klient' : 'Nowy klient'}</div><h3 id="cl-head">${escapeHtml(d.name || 'Bez nazwy')}</h3></div>
      <div class="ed-head-actions">
        <select id="cl-status" class="status-select">${STATUSES.map(([k, l, hint]) => `<option value="${k}" title="${attr(hint)}" ${d.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="icon-btn" data-modal-close aria-label="Zamknij">×</button>
      </div>
    </div>
    <nav class="mtabs"><button class="is-active" data-mtab="data">Dane</button><button data-mtab="timeline" ${c ? '' : 'disabled'}>Aktywności</button><button data-mtab="files" ${c ? '' : 'disabled'}>Pliki</button><button data-mtab="messages" ${c ? '' : 'disabled'}>Zapytania</button></nav>
    <div class="mpanel is-active" data-mpanel="data">
      <div class="row-2">
        <div class="field"><label class="field-label">Imię i nazwisko / nazwa</label><input data-f="name" value="${attr(d.name)}" /></div>
        <div class="field"><label class="field-label">Firma</label><input data-f="company" value="${attr(d.company)}" /></div>
        <div class="field"><label class="field-label">E-mail</label><input data-f="email" type="email" value="${attr(d.email)}" /></div>
        <div class="field"><label class="field-label">Telefon</label><input data-f="phone" value="${attr(d.phone)}" /></div>
        <div class="field"><label class="field-label">Stanowisko</label><input data-f="position" value="${attr(d.position)}" /></div>
        <div class="field"><label class="field-label">Strona www</label><input data-f="website" value="${attr(d.website)}" placeholder="https://" /></div>
        <div class="field"><label class="field-label">Źródło</label><select data-f="source">${['manual', 'website', 'referral', 'linkedin', 'other'].map((s) => `<option value="${s}" ${d.source === s ? 'selected' : ''}>${{ manual: 'Ręcznie', website: 'Formularz na stronie', referral: 'Polecenie', linkedin: 'LinkedIn', other: 'Inne' }[s]}</option>`).join('')}</select></div>
        <div class="field"><label class="field-label">Wartość projektu (zł)</label><input data-f="value_pln" data-type="number" type="number" step="100" value="${attr(d.value_pln ?? '')}" /></div>
        <div class="field"><label class="field-label">Następny krok</label><input data-f="next_action" value="${attr(d.next_action)}" placeholder="np. wysłać wycenę" /></div>
        <div class="field"><label class="field-label">Termin następnego kroku</label><input data-f="next_action_at" type="date" value="${attr(d.next_action_at || '')}" /></div>
      </div>
      <div class="field"><label class="field-label">Tagi</label><div class="conn-chips" id="cl-tags">${C.tags.map((t) => `<button type="button" class="conn-chip${d.tags.includes(t.slug) ? ' is-on' : ''}" data-tag="${attr(t.slug)}" style="--chip-accent:${attr(t.color || '#0e0e0e')}"><span class="chip-dot"></span>${escapeHtml(t.label_pl)}</button>`).join('')}</div></div>
      <div class="field"><label class="field-label">Notatki</label><textarea data-f="notes" rows="5">${attr(d.notes)}</textarea></div>
      <div class="button-row"><button class="btn danger" id="cl-delete" ${c ? '' : 'disabled'}>Usuń klienta</button><span class="spread"></span><button class="btn primary" id="cl-save">Zapisz</button></div>
    </div>
    <div class="mpanel" data-mpanel="timeline">
      <form class="act-form" id="cl-act-form">
        <select name="kind">${KINDS.filter((k) => k[0] !== 'status').map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
        <input name="happened_at" type="datetime-local" value="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)}" />
        <textarea name="body" rows="2" placeholder="Co ustaliliśmy…" required></textarea>
        <button class="btn small primary" type="submit">Dodaj</button>
      </form>
      <div class="timeline" id="cl-timeline"><div class="empty-state">Ładowanie…</div></div>
    </div>
    <div class="mpanel" data-mpanel="files">
      <div class="button-row"><button class="btn small primary" id="cl-upload">+ Wgraj plik</button><span class="coords">PDF, obrazy, CSV, XLSX, DOC, ZIP — do 20 MB. Prywatny bucket, linki ważne 5 min.</span></div>
      <div class="file-list" id="cl-files"></div>
    </div>
    <div class="mpanel" data-mpanel="messages"><div id="cl-messages"><div class="empty-state">Ładowanie…</div></div></div>
  `, { wide: true });
  const card = m.card;
  $$('.mtabs button', card).forEach((b) => b.addEventListener('click', () => {
    $$('.mtabs button', card).forEach((x) => x.classList.toggle('is-active', x === b));
    $$('.mpanel', card).forEach((p) => p.classList.toggle('is-active', p.dataset.mpanel === b.dataset.mtab));
  }));
  card.querySelector('[data-f="name"]').addEventListener('input', (e) => { $('#cl-head', card).textContent = e.target.value || 'Bez nazwy'; });
  $('#cl-tags', card).addEventListener('click', (e) => { const t = e.target.closest('[data-tag]'); if (t) t.classList.toggle('is-on'); });
  $('#cl-save', card).addEventListener('click', async () => {
    readForm($('[data-mpanel="data"]', card), d);
    d.status = $('#cl-status', card).value;
    d.tags = $$('#cl-tags .conn-chip.is-on', card).map((t) => t.dataset.tag);
    if (!d.name || !d.email) { banner('Nazwa i e-mail są wymagane', 'error'); return; }
    const payload = { name: d.name, email: d.email.toLowerCase(), phone: d.phone || null, company: d.company || null, position: d.position || null, website: d.website || null, source: d.source || 'manual', status: d.status, tags: d.tags, notes: d.notes || null, value_pln: d.value_pln ?? null, next_action: d.next_action || null, next_action_at: d.next_action_at || null };
    const q = d.id ? sb.from('crm_clients').update(payload).eq('id', d.id).select().single() : sb.from('crm_clients').insert(payload).select().single();
    const { data, error } = await q;
    if (error) { banner(error.message, 'error'); return; }
    if (c && c.status !== data.status) await sb.from('crm_activities').insert({ client_id: data.id, kind: 'status', body: `${statusLabel(c.status)} → ${statusLabel(data.status)}` });
    await loadCrm(); renderCrm(); banner('Zapisano', 'ok');
    if (!d.id) { m.close(); openClient(data.id); } else Object.assign(c, data);
  });
  $('#cl-status', card).addEventListener('change', async (e) => { if (c) await setStatus(c.id, e.target.value); });
  $('#cl-delete', card).addEventListener('click', async () => {
    if (!c || !ask(`Usunąć klienta „${c.name}” z całą historią i plikami?`)) return;
    const { data: files } = await sb.from('crm_files').select('storage_path').eq('client_id', c.id);
    if (files?.length) await sb.storage.from('crm-files').remove(files.map((f) => f.storage_path));
    const { error } = await sb.from('crm_clients').delete().eq('id', c.id);
    if (error) { banner(error.message, 'error'); return; }
    m.close(); await loadCrm(); renderCrm(); banner('Usunięto', 'ok');
  });
  if (!c) return;

  // timeline
  const loadTimeline = async () => {
    const { data } = await sb.from('crm_activities').select('*').eq('client_id', c.id).order('happened_at', { ascending: false });
    const tl = $('#cl-timeline', card);
    tl.innerHTML = (data || []).length ? data.map((a) => `<div class="tl-item k-${a.kind}"><span class="tl-ico">${KIND_ICON[a.kind] || '•'}</span><div><div class="tl-meta">${KINDS.find((k) => k[0] === a.kind)?.[1] || a.kind} · ${fmtDate(a.happened_at)}</div><div class="tl-body">${escapeHtml(a.body || '')}</div></div><button class="icon-btn mini" data-del-act="${a.id}" title="Usuń">×</button></div>`).join('') : '<div class="empty-state">Brak aktywności</div>';
  };
  loadTimeline();
  $('#cl-act-form', card).addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    const { error } = await sb.from('crm_activities').insert({ client_id: c.id, kind: f.kind.value, body: f.body.value.trim(), happened_at: f.happened_at.value ? new Date(f.happened_at.value).toISOString() : new Date().toISOString() });
    if (error) { banner(error.message, 'error'); return; }
    f.body.value = ''; loadTimeline(); loadCrm().then(renderCrm); banner('Dodano', 'ok');
  });
  $('#cl-timeline', card).addEventListener('click', async (e) => { const b = e.target.closest('[data-del-act]'); if (!b) return; await sb.from('crm_activities').delete().eq('id', b.dataset.delAct); loadTimeline(); });

  // files
  const loadFiles = async () => {
    const { data } = await sb.from('crm_files').select('*').eq('client_id', c.id).order('created_at', { ascending: false });
    const wrap = $('#cl-files', card);
    if (!data?.length) { wrap.innerHTML = '<div class="empty-state">Brak plików</div>'; return; }
    wrap.innerHTML = data.map((f) => `<div class="file-row"><span>${escapeHtml(f.original_name)}</span><small>${(f.size_bytes / 1024).toFixed(0)} KB · ${fmtDate(f.created_at, false)}</small><button class="btn small" data-open-file="${f.storage_path}">Otwórz</button><button class="btn small danger" data-del-file="${f.id}" data-path="${attr(f.storage_path)}">Usuń</button></div>`).join('');
  };
  loadFiles();
  $('#cl-upload', card).addEventListener('click', async () => {
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
    input.onchange = async () => {
      for (const file of input.files) {
        banner(`Wysyłanie ${file.name}…`, null);
        const path = `client/${c.id}/${crypto.randomUUID()}-${file.name.replace(/[^\w.\-]+/g, '_')}`;
        const { error } = await sb.storage.from('crm-files').upload(path, file, { contentType: file.type || undefined });
        if (error) { banner(error.message, 'error'); continue; }
        await sb.from('crm_files').insert({ client_id: c.id, storage_path: path, original_name: file.name, mime: file.type, size_bytes: file.size });
        await sb.from('crm_activities').insert({ client_id: c.id, kind: 'file', body: `Plik: ${file.name}` });
      }
      loadFiles(); loadTimeline(); banner('Wgrano', 'ok');
    };
    input.click();
  });
  $('#cl-files', card).addEventListener('click', async (e) => {
    const o = e.target.closest('[data-open-file]'); const del = e.target.closest('[data-del-file]');
    if (o) { const { data, error } = await sb.storage.from('crm-files').createSignedUrl(o.dataset.openFile, 300); if (error) banner(error.message, 'error'); else window.open(data.signedUrl, '_blank'); }
    if (del) { if (!ask('Usunąć plik?')) return; await sb.storage.from('crm-files').remove([del.dataset.path]); await sb.from('crm_files').delete().eq('id', del.dataset.delFile); loadFiles(); }
  });

  // linked messages
  const { data: msgs } = await sb.from('contact_submissions').select('*').or(`client_id.eq.${c.id},email.ilike.${c.email}`).order('created_at', { ascending: false });
  $('#cl-messages', card).innerHTML = msgs?.length ? msgs.map((x) => `<div class="tl-item k-email"><span class="tl-ico">✉</span><div><div class="tl-meta">${fmtDate(x.created_at)} · ${escapeHtml(x.source || '')}${x.service ? ' · ' + escapeHtml(x.service) : ''}${x.budget ? ' · ' + escapeHtml(x.budget) : ''}</div><div class="tl-body">${escapeHtml(x.message || '')}</div></div></div>`).join('') : '<div class="empty-state">Brak zapytań z formularza</div>';
}

function exportCsv() {
  const rows = [['name', 'email', 'phone', 'company', 'status', 'tags', 'value_pln', 'next_action', 'next_action_at', 'last_contact_at', 'notes']];
  for (const c of filtered()) rows.push([c.name, c.email, c.phone || '', c.company || '', c.status, (c.tags || []).join('|'), c.value_pln ?? '', c.next_action || '', c.next_action_at || '', c.last_contact_at || '', (c.notes || '').replace(/\n/g, ' ')]);
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); a.download = `crm-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
}
