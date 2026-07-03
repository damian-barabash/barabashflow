// ═══════════════════════════════════════════════════════════════════════════
// mail.js — BarabashFlow Mejle (CRM + Rozsyłka + Skrzynka)
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { SUPABASE_URL, SUPABASE_ANON_KEY, mediaUrl } from './supabase-config.js?v=2026-07-03b';
import { getTheme, toggleTheme, onThemeChange } from './theme.js?v=2026-07-03b';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  // Share storageKey with admin.html so signing in once unlocks both pages.
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'bf-admin-auth' },
});

const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  user: null,
  tags: [],
  clients: [],
  templates: [],
  inbox: [],
  // CRM filters
  crmSearch: '',
  crmActiveTags: new Set(),
  // Send state
  selectedRecipients: new Map(),   // email -> { email, name, client_id }
  _pasteEmails: new Set(),
  selectedTemplate: null,
  selectedLocale: 'pl',
  // banner timer
  _bannerTimer: 0,
};

// ─── Bootstrap ────────────────────────────────────────────────────────────

init().catch((err) => {
  console.error('[mail] init failed', err);
  document.body.classList.remove('is-booting');
  // Bulletproof error overlay — independent of admin.css / mail.css loading.
  document.body.innerHTML = `<div style="padding:40px;font-family:Menlo,Consolas,monospace;font-size:13px;line-height:1.6;color:#0e0e0e;background:#f6f4ee;min-height:100vh;box-sizing:border-box;">
    <h2 style="font-family:Georgia,serif;font-weight:300;font-size:22px;margin:0 0 14px 0;">Błąd inicjalizacji Mejli</h2>
    <pre style="white-space:pre-wrap;background:#fff;border:1px solid #d6d3c8;padding:14px;color:#d83a3a;margin:0 0 14px 0;">${String(err?.message || err).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</pre>
    <p style="margin:0;">Otwórz DevTools → Console dla pełnego stack-trace. Wróć do <a href="/admin" style="color:#0e0e0e;">/admin</a>.</p>
  </div>`;
});

async function init() {
  // ── Auth gate ── must be signed-in admin; otherwise redirect to /admin
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const next = encodeURIComponent('/mail');
    window.location.replace(`/admin?next=${next}`);
    return;
  }
  state.user = session.user;

  // Watch for sign-out / token refresh
  sb.auth.onAuthStateChange((evt, sess) => {
    if (evt === 'SIGNED_OUT' || !sess) {
      window.location.replace('/admin');
      return;
    }
    if (sess?.user) state.user = sess.user;
  });

  $('#session-email').textContent = session.user.email;
  document.body.classList.remove('is-booting');
  // .shell has `display: none` in admin.css — needs `is-active` to flex-show.
  // Also clear the `hidden` attribute (was set in HTML so the unauth flow
  // doesn't flash the empty shell before redirect).
  const shell = $('#shell');
  shell.hidden = false;
  shell.classList.add('is-active');

  bindShellUI();
  bindThemeToggle();
  bindCrm();
  bindSend();
  bindInbox();
  setupTabAway();

  await Promise.all([loadTags(), loadClients(), loadTemplates(), loadInbox()]);
  renderTagFilter();
  renderClients();
  renderTemplates();
  renderCrmPicklist();
  renderSendTagPicker();
  renderRecipientChips();
  renderInbox();
  refreshPreview();
}

function bindShellUI() {
  $$('.tab-btn').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  $('#signout').addEventListener('click', async () => {
    await sb.auth.signOut();
    window.location.replace('/admin');
  });
}

function switchTab(tab) {
  $$('.tab-btn').forEach((x) => x.classList.toggle('is-active', x.dataset.tab === tab));
  $$('.panel-page').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab));
}

// ─── Data loaders ─────────────────────────────────────────────────────────

async function loadTags() {
  const { data, error } = await sb.from('crm_tags').select('*').order('sort_order');
  if (error) { console.error(error); return; }
  state.tags = data || [];
}

async function loadClients() {
  const { data, error } = await sb.from('crm_clients').select('*').order('created_at', { ascending: false });
  if (error) { console.error(error); return; }
  state.clients = data || [];
  $('#crm-count').textContent = state.clients.length ? `(${state.clients.length})` : '';
}

async function loadTemplates() {
  const { data, error } = await sb.from('mail_templates').select('*').order('name');
  if (error) { console.error(error); return; }
  state.templates = data || [];
}

async function loadInbox() {
  const [submissions, inbound, outbound] = await Promise.all([
    sb.from('contact_submissions').select('*').order('created_at', { ascending: false }).limit(200),
    sb.from('mail_inbound').select('*').order('received_at', { ascending: false }).limit(200),
    // Only sent replies inside conversation threads — broadcasts (no thread_key) stay out of Skrzynka.
    sb.from('mail_outbound')
      .select('*')
      .not('thread_key', 'is', null)
      .in('status', ['sent', 'delivered', 'opened', 'clicked'])
      .order('sent_at', { ascending: false, nullsFirst: false })
      .limit(200),
  ]);
  const subs = (submissions.data || []).map((s) => ({
    _kind: 'submission',
    id: `sub:${s.id}`,
    raw: s,
    from_email: s.email,
    from_name: s.name,
    subject: (s.message || '').slice(0, 80) || '(brak tematu)',
    body_text: s.message,
    body_html: null,
    source: s.source || 'website',
    is_read: !!s.is_read,
    is_replied: !!s.is_replied,
    client_id: s.client_id || null,
    received_at: s.created_at,
  }));
  const ins = (inbound.data || []).map((m) => ({
    _kind: 'inbound',
    id: `in:${m.id}`,
    raw: m,
    from_email: m.from_email,
    from_name: m.from_name,
    to_email: m.to_email,
    to_name: null,
    subject: m.subject || '(brak tematu)',
    body_text: m.body_text,
    body_html: m.body_html,
    source: 'inbound',
    is_read: !!m.is_read,
    is_replied: !!m.is_replied,
    client_id: m.client_id || null,
    received_at: m.received_at,
  }));
  const outs = (outbound.data || []).map((m) => ({
    _kind: 'outbound',
    id: `out:${m.id}`,
    raw: m,
    from_email: 'office@barabashflow.pl',
    from_name: 'Ja',
    to_email: m.to_email,
    to_name: m.to_name,
    subject: m.subject || '(brak tematu)',
    body_text: null,
    body_html: m.body_html,
    source: 'sent',
    is_read: true,
    is_replied: false,
    client_id: m.client_id || null,
    received_at: m.sent_at || m.created_at,
  }));
  state.inbox = [...subs, ...ins, ...outs].sort(
    (a, b) => new Date(b.received_at) - new Date(a.received_at),
  );
  // Split unread between the two badges (outbound never counts as unread).
  paintBadge('#msgs-badge',  state.inbox.filter((m) => m._kind === 'submission' && !m.is_read).length);
  paintBadge('#inbox-badge', state.inbox.filter((m) => m._kind === 'inbound'    && !m.is_read).length);
}

function paintBadge(sel, n) {
  const el = $(sel);
  if (!el) return;
  if (n > 0) { el.style.display = ''; el.textContent = String(n); }
  else el.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════════════════
// CRM tab
// ═══════════════════════════════════════════════════════════════════════════

function bindCrm() {
  $('#crm-search').addEventListener('input', (e) => {
    state.crmSearch = e.target.value.trim().toLowerCase();
    renderClients();
  });
  $('#crm-add').addEventListener('click', () => openClientModal(null));
  $('#crm-import-csv').addEventListener('click', () => $('#crm-csv-input').click());
  $('#crm-csv-input').addEventListener('change', handleCsvImport);
}

function renderTagFilter() {
  const wrap = $('#crm-tagfilter');
  wrap.innerHTML = '';
  for (const t of state.tags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'crm-tag is-filter' + (state.crmActiveTags.has(t.slug) ? ' is-on' : '');
    chip.style.setProperty('--tag-color', t.color);
    chip.innerHTML = `<span class="dot"></span>${escapeHtml(t.label_pl)}`;
    chip.addEventListener('click', () => {
      if (state.crmActiveTags.has(t.slug)) state.crmActiveTags.delete(t.slug);
      else state.crmActiveTags.add(t.slug);
      renderTagFilter();
      renderClients();
    });
    wrap.appendChild(chip);
  }
}

function renderClients() {
  const list = $('#crm-list');
  list.innerHTML = '';
  const filtered = state.clients.filter((c) => {
    if (state.crmActiveTags.size > 0) {
      const tags = c.tags || [];
      let match = false;
      for (const at of state.crmActiveTags) if (tags.includes(at)) { match = true; break; }
      if (!match) return false;
    }
    if (state.crmSearch) {
      const hay = `${c.name || ''} ${c.email || ''} ${c.company || ''}`.toLowerCase();
      if (!hay.includes(state.crmSearch)) return false;
    }
    return true;
  });
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">Brak klientów spełniających filtry.</div>';
    return;
  }
  for (const c of filtered) {
    const card = document.createElement('div');
    card.className = 'crm-card';
    const tagsHtml = (c.tags || []).map((slug) => {
      const t = state.tags.find((x) => x.slug === slug);
      if (!t) return '';
      return `<span class="crm-tag" style="--tag-color:${t.color}"><span class="dot"></span>${escapeHtml(t.label_pl)}</span>`;
    }).join('');
    card.innerHTML = `
      <div class="crm-card-name">${escapeHtml(c.name || '(bez nazwy)')}</div>
      <div class="crm-card-email">${escapeHtml(c.email || '—')}</div>
      <div class="crm-card-meta">
        ${c.company ? `<span>${escapeHtml(c.company)}</span>` : ''}
        ${c.phone   ? `<span>${escapeHtml(c.phone)}</span>`   : ''}
        <span>${formatDate(c.created_at)}</span>
      </div>
      <div class="crm-card-tags">${tagsHtml}</div>
    `;
    card.addEventListener('click', () => openClientModal(c));
    list.appendChild(card);
  }
}

function openClientModal(client) {
  const modal = $('#modal-root');
  const win = $('#modal-window');
  const isNew = !client;
  const c = client || { name:'', email:'', phone:'', company:'', tags:[], notes:'', source:'manual' };
  win.innerHTML = `
    <div class="eyebrow">${isNew ? 'Nowy klient' : 'Edycja klienta'}</div>
    <h3 style="margin:6px 0 18px 0;font-family:var(--font-display);font-weight:300;font-size:22px;">
      ${escapeHtml(isNew ? 'Dodaj klienta' : (c.name || c.email || '—'))}
    </h3>
    <div class="row-2">
      <div class="field"><label class="field-label">Imię / nazwa</label><input id="cl-name" value="${attr(c.name)}" /></div>
      <div class="field"><label class="field-label">E-mail</label><input id="cl-email" type="email" value="${attr(c.email)}" /></div>
      <div class="field"><label class="field-label">Telefon</label><input id="cl-phone" value="${attr(c.phone)}" /></div>
      <div class="field"><label class="field-label">Firma</label><input id="cl-company" value="${attr(c.company)}" /></div>
    </div>
    <div class="field">
      <label class="field-label">Tagi</label>
      <div class="conn-chips" id="cl-tags"></div>
    </div>
    <div class="field">
      <label class="field-label">Notatki</label>
      <textarea id="cl-notes" rows="4">${escapeHtml(c.notes || '')}</textarea>
    </div>
    ${!isNew ? `
      <div class="section">
        <div class="section-head"><span class="section-title">Pliki</span></div>
        <div id="cl-files"></div>
        <input type="file" id="cl-file-input" hidden multiple />
        <button class="btn small" id="cl-upload" type="button" style="margin-top:8px;">+ Załącz plik</button>
      </div>
    ` : ''}
    <div class="button-row" style="margin-top:18px;">
      ${!isNew ? '<button class="btn danger" id="cl-delete" type="button">Usuń</button>' : ''}
      <span class="spread"></span>
      <button class="btn" id="cl-cancel" type="button">Anuluj</button>
      <button class="btn primary" id="cl-save" type="button">Zapisz</button>
    </div>
  `;
  // Tag picker
  const tagBox = $('#cl-tags', win);
  const tagState = new Set(c.tags || []);
  const renderTagChips = () => {
    tagBox.innerHTML = '';
    for (const t of state.tags) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'conn-chip' + (tagState.has(t.slug) ? ' is-on' : '');
      chip.style.setProperty('--chip-accent', t.color);
      chip.innerHTML = `<span class="chip-dot"></span>${escapeHtml(t.label_pl)}`;
      chip.addEventListener('click', () => {
        if (tagState.has(t.slug)) tagState.delete(t.slug);
        else tagState.add(t.slug);
        renderTagChips();
      });
      tagBox.appendChild(chip);
    }
  };
  renderTagChips();

  if (!isNew) {
    loadAndRenderFiles(c.id);
    $('#cl-upload', win).addEventListener('click', () => $('#cl-file-input', win).click());
    $('#cl-file-input', win).addEventListener('change', (e) => uploadFiles(c.id, e.target.files));
    $('#cl-delete', win).addEventListener('click', async () => {
      if (!confirm(`Usunąć klienta „${c.name || c.email}"?`)) return;
      const { error } = await sb.from('crm_clients').delete().eq('id', c.id);
      if (error) { banner(error.message, 'error'); return; }
      closeModal();
      await loadClients();
      renderClients();
      banner('Usunięto', 'ok');
    });
  }
  $('#cl-cancel', win).addEventListener('click', closeModal);
  modal.querySelector('.modal-backdrop').onclick = closeModal;
  $('#cl-save', win).addEventListener('click', async () => {
    const payload = {
      name:    $('#cl-name', win).value.trim() || null,
      email:   $('#cl-email', win).value.trim() || null,
      phone:   $('#cl-phone', win).value.trim() || null,
      company: $('#cl-company', win).value.trim() || null,
      tags:    [...tagState],
      notes:   $('#cl-notes', win).value.trim() || null,
    };
    banner('Zapisywanie…', null);
    try {
      if (isNew) {
        payload.source = 'manual';
        const { error } = await sb.from('crm_clients').insert(payload);
        if (error) throw error;
      } else {
        const { error } = await sb.from('crm_clients').update(payload).eq('id', c.id);
        if (error) throw error;
      }
      closeModal();
      await loadClients();
      renderClients();
      banner('Zapisano', 'ok');
    } catch (err) {
      console.error(err);
      banner(err.message || 'Błąd', 'error');
    }
  });
  modal.hidden = false;
}

async function loadAndRenderFiles(clientId) {
  const { data } = await sb.from('crm_files').select('*').eq('client_id', clientId).order('created_at', { ascending: false });
  const wrap = $('#cl-files');
  if (!wrap) return;
  if (!data || data.length === 0) {
    wrap.innerHTML = '<div class="coords">Brak plików.</div>';
    return;
  }
  wrap.innerHTML = '';
  for (const f of data) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--hair);';
    row.innerHTML = `
      <a href="#" style="font-family:var(--font-mono);font-size:11px;color:var(--ink);text-decoration:none;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        ${escapeHtml(f.original_name)} · ${formatSize(f.size_bytes)}
      </a>
      <button class="btn small danger" type="button">Usuń</button>
    `;
    row.querySelector('a').addEventListener('click', async (e) => {
      e.preventDefault();
      const { data: signed } = await sb.storage.from('crm-files').createSignedUrl(f.storage_path, 300);
      if (signed?.signedUrl) window.open(signed.signedUrl, '_blank');
    });
    row.querySelector('button').addEventListener('click', async () => {
      if (!confirm('Usunąć plik?')) return;
      await sb.storage.from('crm-files').remove([f.storage_path]);
      await sb.from('crm_files').delete().eq('id', f.id);
      loadAndRenderFiles(clientId);
    });
    wrap.appendChild(row);
  }
}

async function uploadFiles(clientId, files) {
  banner(`Wgrywam ${files.length}…`, null);
  for (const f of files) {
    const ext = f.name.split('.').pop()?.toLowerCase() || 'bin';
    const path = `${clientId}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await sb.storage.from('crm-files').upload(path, f, {
      contentType: f.type, cacheControl: '3600',
    });
    if (upErr) { banner(upErr.message, 'error'); continue; }
    await sb.from('crm_files').insert({
      client_id: clientId,
      storage_path: path,
      original_name: f.name,
      mime: f.type || null,
      size_bytes: f.size,
      uploaded_by: state.user.id,
    });
  }
  loadAndRenderFiles(clientId);
  banner('Załączono', 'ok');
}

async function handleCsvImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) { banner('Pusty CSV', 'error'); return; }
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = (k) => headers.indexOf(k);
  if (idx('email') === -1) { banner('CSV musi mieć kolumnę „email"', 'error'); return; }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const email = (cols[idx('email')] || '').trim();
    if (!email) continue;
    rows.push({
      name:    idx('name')    >= 0 ? (cols[idx('name')]    || '').trim() || null : null,
      email,
      phone:   idx('phone')   >= 0 ? (cols[idx('phone')]   || '').trim() || null : null,
      company: idx('company') >= 0 ? (cols[idx('company')] || '').trim() || null : null,
      tags:    idx('tags')    >= 0 ? (cols[idx('tags')]    || '').split('|').map((s) => s.trim()).filter(Boolean) : [],
      source:  'import',
    });
  }
  if (!rows.length) { banner('Brak prawidłowych wierszy', 'error'); return; }
  banner(`Importuję ${rows.length}…`, null);
  const { error } = await sb.from('crm_clients').upsert(rows, { onConflict: 'email', ignoreDuplicates: true });
  if (error) { banner(error.message, 'error'); return; }
  await loadClients();
  renderClients();
  banner(`Zaimportowano ${rows.length}`, 'ok');
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') inQ = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Rozsyłka tab
// ═══════════════════════════════════════════════════════════════════════════

function bindSend() {
  // Recipient mode segmented control
  $$('.recipient-modes .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      $$('.recipient-modes .seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
      $$('.recipient-mode-pane').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.mode; });
      if (b.dataset.mode === 'crm') renderCrmPicklist();
      if (b.dataset.mode === 'tag') renderSendTagPicker();
    });
  });

  $('#send-crm-search').addEventListener('input', renderCrmPicklist);
  $('#send-paste').addEventListener('input', () => {
    const txt = $('#send-paste').value;
    const pasted = txt.split(/[\s,;]+/).filter((s) => /^[^\s]+@[^\s]+\.[^\s]+$/.test(s));
    state._pasteEmails = new Set(pasted);
    renderRecipientChips();
  });

  // Locale switcher (applies template translations)
  $$('.seg-buttons .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      $$('.seg-buttons .seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
      state.selectedLocale = b.dataset.locale;
      applyTemplateToForm(true);
    });
  });

  $('#send-template').addEventListener('change', () => applyTemplateToForm(true));
  $('#send-templates-manage').addEventListener('click', () => openTemplatesManager());
  $('#send-clear-recipients').addEventListener('click', () => {
    state.selectedRecipients.clear();
    state._pasteEmails.clear();
    state._replyContext = null;  // drop In-Reply-To/References — fresh send
    $('#send-paste').value = '';
    renderRecipientChips();
    renderCrmPicklist();
    renderSendTagPicker();
  });

  $('#send-subject').addEventListener('input', refreshPreview);
  $('#send-body').addEventListener('input', refreshPreview);
  $('#send-preview-refresh').addEventListener('click', () => doRefreshPreview());

  // RTE toolbar
  $$('.rte-toolbar button').forEach((b) => {
    b.addEventListener('mousedown', (e) => {
      // mousedown not click — preserves selection in contenteditable
      e.preventDefault();
      $('#send-body').focus();
      const cmd = b.dataset.cmd;
      try {
        if      (cmd === 'bold')   document.execCommand('bold');
        else if (cmd === 'italic') document.execCommand('italic');
        else if (cmd === 'ul')     document.execCommand('insertUnorderedList');
        else if (cmd === 'p')      document.execCommand('formatBlock', false, 'p');
        else if (cmd === 'link') {
          const url = prompt('URL:');
          if (url) document.execCommand('createLink', false, url);
        }
      } catch (err) { console.warn(err); }
      refreshPreview();
    });
  });

  $('#send-dry-run').addEventListener('click', () => sendMail(true));
  $('#send-go').addEventListener('click', () => sendMail(false));
}

function renderTemplates() {
  const sel = $('#send-template');
  // Preserve current selection across re-renders (after CRUD on templates).
  const keepValue = sel.value;
  sel.innerHTML = '<option value="">— bez szablonu —</option>';
  for (const t of state.templates) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = `${t.name} · ${t.kind}`;
    sel.appendChild(opt);
  }
  // Default is intentionally "— bez szablonu —" (empty value) — user picks
  // explicitly. Restore previous selection if it still exists.
  if (keepValue && state.templates.some((t) => t.id === keepValue)) {
    sel.value = keepValue;
  } else {
    sel.value = '';
  }
  applyTemplateToForm(false);
}

function applyTemplateToForm(force) {
  const sel = $('#send-template');
  const t = state.templates.find((x) => x.id === sel.value) || null;
  state.selectedTemplate = t;
  if (!t) {
    if (force) { $('#send-subject').value = ''; $('#send-body').innerHTML = ''; refreshPreview(); }
    return;
  }
  const loc = state.selectedLocale;
  $('#send-subject').value = t[`subject_${loc}`] || t.subject_pl || '';
  $('#send-body').innerHTML = t[`body_${loc}`] || t.body_pl || '';
  refreshPreview();
}

function renderCrmPicklist() {
  const wrap = $('#send-crm-picklist');
  if (!wrap) return;
  const q = ($('#send-crm-search').value || '').trim().toLowerCase();
  wrap.innerHTML = '';
  const filtered = state.clients.filter((c) => {
    if (!c.email) return false;
    if (!q) return true;
    return `${c.name || ''} ${c.email}`.toLowerCase().includes(q);
  });
  if (filtered.length === 0) {
    wrap.innerHTML = '<div class="empty-state" style="padding:20px;">Brak klientów.</div>';
    return;
  }
  for (const c of filtered) {
    const row = document.createElement('div');
    const isPicked = state.selectedRecipients.has(c.email);
    row.className = 'pick-row' + (isPicked ? ' is-picked' : '');
    row.innerHTML = `
      <span>${escapeHtml(c.name || '—')}</span>
      <span class="pick-email">${escapeHtml(c.email)}</span>
    `;
    row.addEventListener('click', () => {
      if (state.selectedRecipients.has(c.email)) state.selectedRecipients.delete(c.email);
      else state.selectedRecipients.set(c.email, { email: c.email, name: c.name, client_id: c.id });
      renderCrmPicklist();
      renderRecipientChips();
    });
    wrap.appendChild(row);
  }
}

function renderSendTagPicker() {
  const wrap = $('#send-tag-picker');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const t of state.tags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'crm-tag is-filter';
    chip.style.setProperty('--tag-color', t.color);
    const matches = state.clients.filter((c) => (c.tags || []).includes(t.slug) && c.email).length;
    chip.innerHTML = `<span class="dot"></span>${escapeHtml(t.label_pl)} (${matches})`;
    chip.addEventListener('click', () => {
      const targets = state.clients.filter((c) => (c.tags || []).includes(t.slug) && c.email);
      for (const c of targets) {
        state.selectedRecipients.set(c.email, { email: c.email, name: c.name, client_id: c.id });
      }
      $('#send-tag-info').textContent = `Dodano ${targets.length} odbiorców z tagu „${t.label_pl}".`;
      renderRecipientChips();
    });
    wrap.appendChild(chip);
  }
}

function renderRecipientChips() {
  const wrap = $('#send-recipient-chips');
  if (!wrap) return;
  const all = collectRecipients();
  $('#send-recipient-count').textContent = all.length;
  wrap.innerHTML = '';
  if (all.length === 0) {
    wrap.innerHTML = '<span class="coords">Brak wybranych odbiorców.</span>';
    return;
  }
  for (const r of all) {
    const chip = document.createElement('span');
    chip.className = 'recip-chip';
    chip.innerHTML = `${escapeHtml(r.name || r.email.split('@')[0])} <span class="pick-email" style="opacity:0.6">${escapeHtml(r.email)}</span><button type="button" title="Usuń">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      state.selectedRecipients.delete(r.email);
      state._pasteEmails.delete(r.email);
      $('#send-paste').value = [...state._pasteEmails].join(', ');
      renderRecipientChips();
      renderCrmPicklist();
    });
    wrap.appendChild(chip);
  }
}

function collectRecipients() {
  const out = new Map();
  for (const [k, v] of state.selectedRecipients) out.set(k, v);
  for (const e of state._pasteEmails) {
    if (!out.has(e)) out.set(e, { email: e, name: null });
  }
  return [...out.values()];
}

// ── Preview (mirrors the Edge Function brand wrapper) ──────────────────────
let _previewTimer = 0;
function refreshPreview() {
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(doRefreshPreview, 220);
}
function doRefreshPreview() {
  const iframe = $('#send-preview');
  if (!iframe) return;
  const subject = $('#send-subject').value || '(no subject)';
  const body = $('#send-body').innerHTML || '<p style="color:#9a9a93">Treść e-maila pojawi się tu…</p>';
  iframe.srcdoc = wrapBrandedLocal(subject, body);
}

function wrapBrandedLocal(subject, bodyHtml) {
  // "Superpower" brand wrapper — must stay in sync with wrapBranded() in the
  // send-mail Edge Function (v6, 2026-07-02).
  const LOGO = `${location.origin}/assets/img/logo.png`;
  const SITE = `${location.origin}`;
  const SANS = `'Helvetica Neue',Helvetica,Arial,-apple-system,'Segoe UI',Roboto,sans-serif`;
  // Sample-substitute {{name}}/{{email}} so preview reads naturally.
  const replaced = String(bodyHtml)
    .replace(/\{\{name\}\}/g, 'Imię')
    .replace(/\{\{email\}\}/g, 'test@example.com');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#e9e8e4;font-family:${SANS};color:#161614;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e9e8e4;">
<tr><td align="center" style="padding:36px 16px;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#fcfcfa;border:1px solid #ffffff;border-radius:24px;">
<tr><td style="padding:26px 36px 18px;">
<table width="100%"><tr>
<td style="vertical-align:middle;"><img src="${LOGO}" width="26" height="32" alt="BF" style="display:inline-block;vertical-align:middle;margin-right:10px;"><span style="font-family:${SANS};font-size:17px;font-weight:700;letter-spacing:-0.02em;color:#161614;vertical-align:middle;">Barabashflow</span></td>
<td align="right" style="vertical-align:middle;"><span style="display:inline-block;background:#f2f1ed;border-radius:999px;padding:6px 14px;font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:0.04em;color:#7d7d75;">MMXXVI</span></td>
</tr></table>
</td></tr>
<tr><td style="padding:14px 36px 10px;font-family:${SANS};font-size:15px;line-height:1.65;color:#161614;">${replaced}</td></tr>
<tr><td align="center" style="padding:26px 36px 32px;">
<a href="${SITE}" style="display:inline-block;background:#e0fe52;border-radius:999px;padding:11px 22px;font-family:${SANS};font-size:13px;font-weight:700;letter-spacing:-0.01em;color:#1c1e08;text-decoration:none;">barabashflow.pl&nbsp;&#8599;</a>
<div style="margin-top:14px;font-family:${SANS};font-size:12px;color:#7d7d75;">office@barabashflow.pl</div>
</td></tr>
</table>
<div style="margin-top:16px;font-family:${SANS};font-size:11px;letter-spacing:0.03em;color:#a5a59c;">Dmytrii Barabash&nbsp;&nbsp;&middot;&nbsp;&nbsp;Warszawa&nbsp;&nbsp;&middot;&nbsp;&nbsp;PL</div>
</td></tr>
</table>
</body></html>`;
}

// ── Send ──────────────────────────────────────────────────────────────────
async function sendMail(dryRun) {
  const recipients = collectRecipients();
  if (recipients.length === 0) { banner('Brak odbiorców', 'error'); return; }
  const subject = $('#send-subject').value.trim();
  const body = $('#send-body').innerHTML.trim();
  if (!subject) { banner('Brak tematu', 'error'); return; }
  if (!body)    { banner('Brak treści', 'error'); return; }
  const throttle = parseInt($('#send-throttle').value, 10);
  const throttle_ms = Number.isFinite(throttle) && throttle >= 0 ? throttle : 250;

  if (!dryRun && !confirm(`Wysłać do ${recipients.length} osób?\nTemat: ${subject}`)) return;

  const prog = $('#send-progress');
  const fill = $('#send-progress-fill');
  const det  = $('#send-progress-detail');
  prog.hidden = false;
  fill.style.width = '0%';
  det.innerHTML = '';
  $('#send-progress-label').textContent = dryRun ? 'Dry-run…' : 'Wysyłanie…';

  try {
    const { data: { session } } = await sb.auth.getSession();
    const resp = await fetch(`${FUNCTIONS_URL}/send-mail`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        recipients,
        subject,
        body_html: body,
        template_id: state.selectedTemplate?.id || null,
        locale: state.selectedLocale,
        throttle_ms,
        dry_run: dryRun,
        in_reply_to: state._replyContext?.in_reply_to || null,
        refs: state._replyContext?.refs || null,
      }),
    });
    fill.style.width = '100%';
    if (!resp.ok) {
      const txt = await resp.text();
      banner(`Błąd serwera: ${txt}`, 'error');
      return;
    }
    const result = await resp.json();
    let ok = 0, err = 0;
    for (const r of result.results) {
      const row = document.createElement('div');
      if (r.ok) { ok++; row.className = 'ok';  row.textContent = `✓ ${r.email}${r.dry_run ? ' (dry-run)' : ''}`; }
      else      { err++; row.className = 'err'; row.textContent = `✗ ${r.email} — ${r.error}`; }
      det.appendChild(row);
    }
    banner(dryRun ? `Dry-run: ${ok} OK / ${err} błędów` : `Wysłano: ${ok} OK / ${err} błędów`, err ? 'error' : 'ok');
  } catch (err) {
    console.error(err);
    banner(err.message || 'Błąd', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Wiadomości + Skrzynka tabs (two instances of the same panel class)
// ═══════════════════════════════════════════════════════════════════════════

class InboxPanel {
  // kindFilter: 'submission' (form/mascot — no threading) | 'inbound' (emails — Gmail-style threading)
  constructor(rootEl, kindFilter) {
    this.root = rootEl;
    this.kindFilter = kindFilter;
    this.subFilter = 'all';
    this.selectedKey = null;   // thread_key for inbound, message id for submission
    this.bind();
  }
  bind() {
    this.root.querySelectorAll('.inbox-filters .seg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        this.root.querySelectorAll('.inbox-filters .seg-btn').forEach((x) =>
          x.classList.toggle('is-active', x === b));
        this.subFilter = b.dataset.filter;
        this.render();
      });
    });
    const refresh = this.root.querySelector('.inbox-refresh-btn');
    if (refresh) refresh.addEventListener('click', async () => {
      const origLabel = refresh.textContent;
      refresh.disabled = true;
      try {
        // Skrzynka → fire IMAP poll via mail-refresh Edge Function.
        // Wiadomości (form/mascot) live in contact_submissions — no IMAP needed.
        if (this.kindFilter === 'inbound') {
          refresh.textContent = 'Sprawdzam pocztę…';
          banner('Łączę z IMAP…', null);
          const { data: { session } } = await sb.auth.getSession();
          const r = await fetch(`${FUNCTIONS_URL}/mail-refresh`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
              'apikey': SUPABASE_ANON_KEY,
              'Content-Type': 'application/json',
            },
            body: '{}',
          });
          const out = await r.json().catch(() => ({}));
          if (!r.ok) {
            banner(`IMAP błąd: ${out.error || r.status}`, 'error');
            return;
          }
          await loadInbox();
          msgsPanel?.render();
          inboxPanel?.render();
          banner(out.ingested ? `Nowe: ${out.ingested}` : 'Brak nowych', 'ok');
          return;
        }
        refresh.textContent = 'Ładuję…';
        await loadInbox();
        msgsPanel?.render();
        inboxPanel?.render();
        banner('Odświeżono', 'ok');
      } finally {
        refresh.disabled = false;
        refresh.textContent = origLabel;
      }
    });
  }
  // All messages of this panel kind, after sub-filter.
  filteredMessages() {
    // For Skrzynka (inbound) — pull both inbound AND outbound so sent replies
    // show up in threads. For Wiadomości — submission only.
    const kinds = this.kindFilter === 'inbound' ? ['inbound', 'outbound'] : [this.kindFilter];
    return state.inbox.filter((m) => kinds.includes(m._kind)).filter((m) => {
      switch (this.subFilter) {
        case 'unread':  return !m.is_read;
        case 'replied': return m.is_replied;
        case 'form':    return m.source === 'website' || m.source === 'form';
        case 'mascot':  return m.source === 'mascot-bot' || m.source === 'mascot';
        default:        return true;
      }
    });
  }
  // Group inbound+outbound by thread_key (oldest-first inside, newest-first across).
  // For submissions, each message is its own "thread of 1".
  groupedThreads() {
    const msgs = this.filteredMessages();
    if (this.kindFilter === 'submission') {
      // Singleton "threads" — preserve flat behavior.
      return msgs.map((m) => ({
        key: m.id, messages: [m], latest: m, anyUnread: !m.is_read, allReplied: m.is_replied,
      }));
    }
    // Inbound+outbound — group by thread_key, fall back to message id if missing.
    const groups = new Map();
    for (const m of msgs) {
      const key = m.raw.thread_key || m.raw.message_id || m.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const threads = [];
    for (const [key, list] of groups) {
      // Hide pure-outbound threads (broadcasts that found a stale thread_key but
      // have no inbound counterpart). Skrzynka = conversations.
      if (!list.some((m) => m._kind === 'inbound')) continue;
      list.sort((a, b) => new Date(a.received_at) - new Date(b.received_at));
      threads.push({
        key,
        messages: list,
        latest: list[list.length - 1],
        anyUnread: list.some((m) => m._kind === 'inbound' && !m.is_read),
        // "Replied" = there's at least one outbound after the last inbound.
        allReplied: (() => {
          const lastInboundIdx = list.map((m) => m._kind).lastIndexOf('inbound');
          const explicitReplied = list.filter((m) => m._kind === 'inbound').every((m) => m.is_replied);
          const hasOutboundAfter = list.slice(lastInboundIdx + 1).some((m) => m._kind === 'outbound');
          return explicitReplied || hasOutboundAfter;
        })(),
      });
    }
    threads.sort((a, b) => new Date(b.latest.received_at) - new Date(a.latest.received_at));
    return threads;
  }
  // Strip leading Re:/Fwd: chain so threads share one subject.
  cleanSubject(s) {
    return String(s || '').replace(/^\s*(re|odp|fwd|fw)\s*:\s*/gi, '').trim() || '(brak tematu)';
  }
  render() {
    const list = this.root.querySelector('.inbox-list');
    if (!list) return;
    list.innerHTML = '';
    const threads = this.groupedThreads();
    if (threads.length === 0) {
      list.innerHTML = '<div class="empty-state">Pusto w tym filtrze.</div>';
      this.renderPane();
      return;
    }
    for (const t of threads) {
      const item = document.createElement('div');
      const cls = ['inbox-item'];
      if (t.anyUnread)                  cls.push('is-unread');
      if (t.allReplied)                 cls.push('is-replied');
      if (this.selectedKey === t.key)   cls.push('is-selected');
      item.className = cls.join(' ');
      // In Skrzynka thread list, surface the conversation partner (first inbound),
      // not "Ja" when the user was last to reply. Falls back to latest for submissions.
      const firstInbound = this.kindFilter === 'inbound'
        ? (t.messages.find((m) => m._kind === 'inbound') || t.latest)
        : t.latest;
      const sourceTag = firstInbound._kind === 'inbound' ? 'inbound'
        : (firstInbound.source === 'mascot-bot' ? 'mascot' : 'form');
      const subj = this.cleanSubject(firstInbound.subject || t.latest.subject);
      const countBadge = t.messages.length > 1
        ? `<span class="thread-count">${t.messages.length}</span>` : '';
      const youArrow = t.latest._kind === 'outbound' ? '<span class="thread-you-arrow">→</span> ' : '';
      item.innerHTML = `
        <div class="inbox-from">${youArrow}${escapeHtml(firstInbound.from_name || firstInbound.from_email || '—')}${countBadge}</div>
        <div class="inbox-subject">${escapeHtml(subj)}</div>
        <div class="inbox-meta">
          <span>${formatDate(t.latest.received_at)}</span>
          <span class="inbox-source is-${sourceTag}">${sourceTag}</span>
        </div>
      `;
      item.addEventListener('click', () => this.openThread(t));
      list.appendChild(item);
    }
    this.renderPane();
  }
  async openThread(t) {
    this.selectedKey = t.key;
    // Mobile single-pane: toggle layout to show pane, hide list.
    const layout = this.root.querySelector('.inbox-layout');
    if (layout) layout.classList.add('has-selection');
    // Mark all messages in the thread as read (outbound is always already read).
    const unreadIds = { sub: [], in: [] };
    for (const m of t.messages) {
      if (m._kind === 'outbound') continue;
      if (!m.is_read) {
        if (m._kind === 'submission') unreadIds.sub.push(m.raw.id);
        else                          unreadIds.in.push(m.raw.id);
        m.is_read = true;
      }
    }
    if (unreadIds.sub.length) await sb.from('contact_submissions').update({ is_read: true }).in('id', unreadIds.sub);
    if (unreadIds.in.length)  await sb.from('mail_inbound').update({ is_read: true }).in('id', unreadIds.in);
    paintBadge('#msgs-badge',  state.inbox.filter((x) => x._kind === 'submission' && !x.is_read).length);
    paintBadge('#inbox-badge', state.inbox.filter((x) => x._kind === 'inbound'    && !x.is_read).length);
    this.render();
  }
  renderPane() {
    const pane = this.root.querySelector('.inbox-pane');
    if (!pane) return;
    const t = this.groupedThreads().find((x) => x.key === this.selectedKey);
    if (!t) {
      // Selection lost (item filtered out, deleted, etc.) — drop the
      // mobile single-pane lock so the list is visible again.
      const layout = this.root.querySelector('.inbox-layout');
      if (layout) layout.classList.remove('has-selection');
      const empty = this.kindFilter === 'inbound'
        ? 'Wybierz e-mail, by zobaczyć rozmowę.'
        : 'Wybierz wiadomość, by zobaczyć szczegóły.';
      pane.innerHTML = `<div class="empty-state">${empty}</div>`;
      return;
    }
    const latest = t.latest;
    // For Skrzynka head, prefer the first inbound message (the actual conversation partner)
    // over a possibly-outbound latest message. For Wiadomości — same flat behavior as before.
    const firstInbound = t.messages.find((m) => m._kind === 'inbound') || latest;
    const partner = this.kindFilter === 'inbound' ? firstInbound : latest;
    const sourceTag = partner._kind === 'inbound' ? 'inbound'
      : (partner.source === 'mascot-bot' ? 'mascot' : 'form');
    const headSubject = this.cleanSubject(partner.subject);

    // Render every message in chronological order. Outbound = "Ja → recipient"
    // with a right-aligned accent, inbound = standard from/to.
    const messagesHtml = t.messages.map((m) => {
      const bodyContent = m.body_html
        ? sanitizeHtml(m.body_html)
        : `<pre style="margin:0;font-family:var(--font-body);font-size:14px;white-space:pre-wrap;">${escapeHtml(m.body_text || '(pusta wiadomość)')}</pre>`;
      const isOut = m._kind === 'outbound';
      const headLeft = isOut
        ? `<span class="thread-msg-from">Ja</span>
           <span class="thread-msg-email">→ ${escapeHtml(m.to_name || m.to_email || '')}</span>`
        : `<span class="thread-msg-from">${escapeHtml(m.from_name || m.from_email)}</span>
           <span class="thread-msg-email">&lt;${escapeHtml(m.from_email)}&gt;</span>`;
      return `
        <article class="thread-msg${isOut ? ' is-outbound' : ''}">
          <header class="thread-msg-head">
            <div>${headLeft}</div>
            <span class="thread-msg-when">${formatDate(m.received_at, true)}</span>
          </header>
          <div class="thread-msg-body">${bodyContent}</div>
        </article>
      `;
    }).join('');

    pane.innerHTML = `
      <button class="pane-back-btn" type="button" aria-label="Wróć do listy">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M12 4l-5 6 5 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Lista</span>
      </button>
      <div class="pane-head">
        <div>
          <div class="pane-subject">${escapeHtml(headSubject)}</div>
          <div class="pane-from" style="font-size:14px;margin-top:4px;">${escapeHtml(partner.from_name || partner.from_email)}</div>
          <div class="pane-email">${escapeHtml(partner.from_email)}</div>
        </div>
        <div class="pane-when">
          ${t.messages.length > 1 ? `<span class="thread-count" style="margin-right:8px;">${t.messages.length}</span>` : ''}
          <span class="inbox-source is-${sourceTag}">${sourceTag}</span>
        </div>
      </div>
      <div class="thread-msgs">${messagesHtml}</div>
      <div class="pane-actions">
        <button class="btn primary pane-reply" type="button">Odpowiedz</button>
        <button class="btn pane-add-crm" type="button" ${partner.client_id ? 'disabled' : ''}>${partner.client_id ? 'Już w CRM' : 'Dodaj do CRM'}</button>
        <button class="btn pane-toggle-replied" type="button">${t.allReplied ? 'Cofnij: odpowiedział' : 'Oznacz: odpowiedział'}</button>
        <span class="spread"></span>
        <button class="btn danger pane-delete" type="button">Usuń wątek</button>
      </div>
    `;
    pane.querySelector('.pane-back-btn').addEventListener('click', () => {
      this.selectedKey = null;
      const layout = this.root.querySelector('.inbox-layout');
      if (layout) layout.classList.remove('has-selection');
      this.render();
    });
    pane.querySelector('.pane-reply').addEventListener('click', () => replyToThread(t));
    pane.querySelector('.pane-add-crm').addEventListener('click', () => addToCrm(partner));
    pane.querySelector('.pane-toggle-replied').addEventListener('click', () => toggleThreadReplied(t));
    pane.querySelector('.pane-delete').addEventListener('click', () => deleteThread(t));
  }
}

let msgsPanel = null;
let inboxPanel = null;
function bindInbox() {
  msgsPanel  = new InboxPanel(document.querySelector('[data-panel="msgs"]'),  'submission');
  inboxPanel = new InboxPanel(document.querySelector('[data-panel="inbox"]'), 'inbound');
}
function renderInbox() {
  msgsPanel?.render();
  inboxPanel?.render();
}

async function addToCrm(m) {
  if (!m.from_email) { banner('Brak adresu e-mail', 'error'); return; }
  banner('Dodaję…', null);
  const payload = {
    name: m.from_name || null,
    email: m.from_email,
    source: m._kind === 'inbound' ? 'inbound' : (m.source === 'mascot-bot' ? 'mascot' : 'form'),
    notes: m.body_text ? `Pierwsza wiadomość: ${m.body_text.slice(0, 240)}` : null,
  };
  const { data: client, error } = await sb.from('crm_clients')
    .upsert(payload, { onConflict: 'email', ignoreDuplicates: false })
    .select().single();
  if (error) { banner(error.message, 'error'); return; }
  if (m._kind === 'submission') {
    await sb.from('contact_submissions').update({ client_id: client.id }).eq('id', m.raw.id);
  } else {
    await sb.from('mail_inbound').update({ client_id: client.id }).eq('id', m.raw.id);
  }
  m.client_id = client.id;
  await loadClients();
  renderClients();
  renderInbox();
  banner('Dodano do CRM', 'ok');
}

async function toggleReplied(m) {
  const next = !m.is_replied;
  if (m._kind === 'submission') {
    await sb.from('contact_submissions').update({ is_replied: next, is_read: true }).eq('id', m.raw.id);
  } else {
    await sb.from('mail_inbound').update({ is_replied: next, is_read: true }).eq('id', m.raw.id);
  }
  m.is_replied = next; m.is_read = true;
  renderInbox();
}

async function deleteMessage(m) {
  if (!confirm('Usunąć tę wiadomość?')) return;
  if (m._kind === 'submission') {
    await sb.from('contact_submissions').delete().eq('id', m.raw.id);
  } else {
    await sb.from('mail_inbound').delete().eq('id', m.raw.id);
  }
  if (msgsPanel)  msgsPanel.selectedId  = null;
  if (inboxPanel) inboxPanel.selectedId = null;
  await loadInbox();
  renderInbox();
  banner('Usunięto', 'ok');
}

function replyToMessage(m) {
  // Submissions only (no threading). Reply via Rozsyłka without IMAP headers.
  switchTab('send');
  state.selectedRecipients.clear();
  state.selectedRecipients.set(m.from_email, {
    email: m.from_email,
    name: m.from_name,
    client_id: m.client_id,
  });
  state._replyContext = null;
  const sel = $('#send-template');
  sel.value = '';
  applyTemplateToForm(true);
  const original = m.subject || '';
  $('#send-subject').value = original.startsWith('Re:') ? original : `Re: ${original}`;
  refreshPreview();
  renderCrmPicklist();
  renderRecipientChips();
}

function replyToThread(thread) {
  // Inbound thread reply. Target the LATEST message; pass In-Reply-To +
  // References so Gmail / Outlook keep the conversation grouped.
  switchTab('send');
  const latest = thread.latest;
  // Recipient = the conversation partner, NOT us. If latest was outbound,
  // re-target the same recipient we sent to. Otherwise use latest.from_email.
  const isOutLatest = latest._kind === 'outbound';
  const recipientEmail = isOutLatest ? latest.to_email : latest.from_email;
  const recipientName  = isOutLatest ? latest.to_name  : latest.from_name;
  state.selectedRecipients.clear();
  state.selectedRecipients.set(recipientEmail, {
    email: recipientEmail,
    name: recipientName,
    client_id: latest.client_id,
  });
  // Build References chain: existing refs + latest message_id, deduped.
  const refs = new Set(Array.isArray(latest.raw.refs) ? latest.raw.refs : []);
  if (latest.raw.in_reply_to) refs.add(latest.raw.in_reply_to);
  if (latest.raw.message_id)  refs.add(latest.raw.message_id);
  state._replyContext = {
    in_reply_to: latest.raw.message_id || null,
    refs: [...refs],
  };
  const sel = $('#send-template');
  sel.value = '';
  applyTemplateToForm(true);
  const subj = String(latest.subject || '').replace(/^\s*re\s*:\s*/i, '');
  $('#send-subject').value = `Re: ${subj}`;
  refreshPreview();
  renderCrmPicklist();
  renderRecipientChips();
}

async function toggleThreadReplied(thread) {
  const next = !thread.allReplied;
  const ids = { sub: [], in: [] };
  for (const m of thread.messages) {
    if (m._kind === 'outbound') continue;
    if (m._kind === 'submission') ids.sub.push(m.raw.id);
    else                          ids.in.push(m.raw.id);
    m.is_replied = next;
    m.is_read = true;
  }
  if (ids.sub.length) await sb.from('contact_submissions').update({ is_replied: next, is_read: true }).in('id', ids.sub);
  if (ids.in.length)  await sb.from('mail_inbound').update({ is_replied: next, is_read: true }).in('id', ids.in);
  renderInbox();
}

async function deleteThread(thread) {
  if (!confirm(`Usunąć ${thread.messages.length > 1 ? `wątek (${thread.messages.length} wiadomości)` : 'wiadomość'}?`)) return;
  const ids = { sub: [], in: [], out: [] };
  for (const m of thread.messages) {
    if      (m._kind === 'submission') ids.sub.push(m.raw.id);
    else if (m._kind === 'outbound')   ids.out.push(m.raw.id);
    else                               ids.in.push(m.raw.id);
  }
  if (ids.sub.length) await sb.from('contact_submissions').delete().in('id', ids.sub);
  if (ids.in.length)  await sb.from('mail_inbound').delete().in('id', ids.in);
  if (ids.out.length) await sb.from('mail_outbound').delete().in('id', ids.out);
  if (msgsPanel)  msgsPanel.selectedKey  = null;
  if (inboxPanel) inboxPanel.selectedKey = null;
  await loadInbox();
  renderInbox();
  banner('Usunięto', 'ok');
}

// ═══════════════════════════════════════════════════════════════════════════
// Templates manager
// ═══════════════════════════════════════════════════════════════════════════

function openTemplatesManager() {
  const modal = $('#modal-root');
  const win = $('#modal-window');
  win.innerHTML = `
    <div class="eyebrow">Szablony</div>
    <h3 style="margin:6px 0 12px 0;font-family:var(--font-display);font-weight:300;font-size:22px;">Zarządzaj szablonami</h3>
    <p class="coords" style="margin:0 0 14px 0;">Zmienne dostępne w treści i temacie: <code>{{name}}</code>, <code>{{email}}</code>, <code>{{subject}}</code>.</p>
    <div class="tmpl-list" id="tmpl-list"></div>
    <div class="button-row" style="margin-top:18px;">
      <span class="spread"></span>
      <button class="btn" id="tmpl-close" type="button">Zamknij</button>
      <button class="btn primary" id="tmpl-add" type="button">+ Nowy szablon</button>
    </div>
  `;
  renderTemplateList();
  $('#tmpl-add', win).addEventListener('click', () => openTemplateEditor(null));
  $('#tmpl-close', win).addEventListener('click', closeModal);
  modal.querySelector('.modal-backdrop').onclick = closeModal;
  modal.hidden = false;
}

function renderTemplateList() {
  const wrap = $('#tmpl-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (state.templates.length === 0) {
    wrap.innerHTML = '<div class="empty-state">Brak szablonów. Kliknij „+ Nowy szablon".</div>';
    return;
  }
  for (const t of state.templates) {
    const row = document.createElement('div');
    row.className = 'tmpl-row';
    row.innerHTML = `
      <div class="tmpl-row-main">
        <div class="tmpl-row-name">${escapeHtml(t.name)}</div>
        <div class="tmpl-row-meta">
          <span class="tmpl-kind">${escapeHtml(t.kind)}</span>
          <span class="tmpl-slug">${escapeHtml(t.slug)}</span>
        </div>
        <div class="tmpl-row-subject">${escapeHtml(t.subject_pl || '—')}</div>
      </div>
      <div class="tmpl-row-actions">
        <button class="btn small" data-edit type="button">Edytuj</button>
        <button class="btn small danger" data-del type="button">Usuń</button>
      </div>
    `;
    row.querySelector('[data-edit]').addEventListener('click', () => openTemplateEditor(t));
    row.querySelector('[data-del]').addEventListener('click', async () => {
      if (!confirm(`Usunąć szablon „${t.name}"?`)) return;
      const { error } = await sb.from('mail_templates').delete().eq('id', t.id);
      if (error) { banner(error.message, 'error'); return; }
      await loadTemplates();
      renderTemplates();
      renderTemplateList();
      banner('Usunięto', 'ok');
    });
    wrap.appendChild(row);
  }
}

function openTemplateEditor(t) {
  const modal = $('#modal-root');
  const win = $('#modal-window');
  const isNew = !t;
  const initial = t || {
    name: '', slug: '', kind: 'custom',
    subject_pl: '', subject_en: '', subject_ru: '',
    body_pl: '', body_en: '', body_ru: '',
  };
  win.innerHTML = `
    <div class="eyebrow">${isNew ? 'Nowy szablon' : 'Edycja szablonu'}</div>
    <h3 style="margin:6px 0 16px 0;font-family:var(--font-display);font-weight:300;font-size:22px;">${escapeHtml(initial.name || 'Bez nazwy')}</h3>
    <div class="row-2">
      <div class="field">
        <label class="field-label">Nazwa (widoczna tylko w panelu)</label>
        <input id="tpl-name" value="${attr(initial.name)}" />
      </div>
      <div class="field">
        <label class="field-label">Slug (URL-friendly id)</label>
        <input id="tpl-slug" value="${attr(initial.slug)}" placeholder="np. welcome, broadcast-update" />
      </div>
      <div class="field">
        <label class="field-label">Rodzaj</label>
        <select id="tpl-kind">
          <option value="welcome">welcome</option>
          <option value="broadcast">broadcast</option>
          <option value="reply">reply</option>
          <option value="followup">followup</option>
          <option value="custom">custom</option>
        </select>
      </div>
    </div>
    <div class="field">
      <label class="field-label">Temat (PL · EN · RU)</label>
      <div class="lang-trio">
        <div class="field-input" data-lang="PL"><input id="tpl-subject-pl" value="${attr(initial.subject_pl)}" placeholder="Polski" /></div>
        <div class="field-input" data-lang="EN"><input id="tpl-subject-en" value="${attr(initial.subject_en)}" placeholder="English" /></div>
        <div class="field-input" data-lang="RU"><input id="tpl-subject-ru" value="${attr(initial.subject_ru)}" placeholder="Русский" /></div>
      </div>
    </div>
    <div class="field">
      <label class="field-label">Treść HTML — Polski</label>
      <textarea id="tpl-body-pl" rows="6">${escapeHtml(initial.body_pl)}</textarea>
    </div>
    <div class="field">
      <label class="field-label">Treść HTML — English</label>
      <textarea id="tpl-body-en" rows="6">${escapeHtml(initial.body_en)}</textarea>
    </div>
    <div class="field">
      <label class="field-label">Treść HTML — Русский</label>
      <textarea id="tpl-body-ru" rows="6">${escapeHtml(initial.body_ru)}</textarea>
    </div>
    <div class="button-row" style="margin-top:18px;">
      <button class="btn" id="tpl-back" type="button">← Wróć</button>
      <span class="spread"></span>
      <button class="btn" id="tpl-cancel" type="button">Anuluj</button>
      <button class="btn primary" id="tpl-save" type="button">${isNew ? 'Utwórz' : 'Zapisz'}</button>
    </div>
  `;
  $('#tpl-kind', win).value = initial.kind || 'custom';
  $('#tpl-back', win).addEventListener('click', () => openTemplatesManager());
  $('#tpl-cancel', win).addEventListener('click', closeModal);
  modal.querySelector('.modal-backdrop').onclick = closeModal;
  $('#tpl-save', win).addEventListener('click', async () => {
    const name = $('#tpl-name', win).value.trim();
    const slug = $('#tpl-slug', win).value.trim().toLowerCase();
    if (!name) { banner('Brak nazwy', 'error'); return; }
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) { banner('Slug: tylko a-z, 0-9, -', 'error'); return; }
    const payload = {
      name,
      slug,
      kind: $('#tpl-kind', win).value,
      subject_pl: $('#tpl-subject-pl', win).value.trim() || null,
      subject_en: $('#tpl-subject-en', win).value.trim() || null,
      subject_ru: $('#tpl-subject-ru', win).value.trim() || null,
      body_pl:    $('#tpl-body-pl', win).value || '',
      body_en:    $('#tpl-body-en', win).value || null,
      body_ru:    $('#tpl-body-ru', win).value || null,
    };
    if (!payload.subject_pl) { banner('Brak tematu (PL)', 'error'); return; }
    if (!payload.body_pl)    { banner('Brak treści (PL)', 'error'); return; }
    banner('Zapisywanie…', null);
    try {
      if (isNew) {
        const { error } = await sb.from('mail_templates').insert(payload);
        if (error) throw error;
      } else {
        const { error } = await sb.from('mail_templates').update(payload).eq('id', t.id);
        if (error) throw error;
      }
      await loadTemplates();
      renderTemplates();
      openTemplatesManager();   // back to list view
      banner('Zapisano', 'ok');
    } catch (err) {
      console.error(err);
      banner(err.message || 'Błąd', 'error');
    }
  });
  modal.hidden = false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Theme + tab-away
// ═══════════════════════════════════════════════════════════════════════════

function bindThemeToggle() {
  const btn = $('#theme-toggle');
  const icon = $('#theme-icon');
  const moon = `<path d="M14.5 11.5a5.5 5.5 0 0 1-7-7 5.5 5.5 0 1 0 7 7Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  const sun  = `<circle cx="10" cy="10" r="3.4" stroke="currentColor" stroke-width="1.4"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M10 2.5v2"/><path d="M10 15.5v2"/><path d="M2.5 10h2"/><path d="M15.5 10h2"/><path d="M4.7 4.7l1.4 1.4"/><path d="M13.9 13.9l1.4 1.4"/><path d="M4.7 15.3l1.4-1.4"/><path d="M13.9 6.1l1.4-1.4"/></g>`;
  const paint = () => { icon.innerHTML = getTheme() === 'light' ? moon : sun; };
  paint();
  btn.addEventListener('click', toggleTheme);
  onThemeChange(paint);
}

function setupTabAway() {
  const original = document.title;
  const lines = [
    'Wróć do skrzynki', 'Maile czekają', 'Jeszcze jeden szablon…',
    'CRM bez ciebie cichnie', 'Klient odpisał, sprawdź',
    'Dmytrii, gdzie idziesz?', 'Skrzynka nie sortuje się sama',
  ];
  let last = -1, cycler = 0;
  const pick = () => {
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

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function closeModal() {
  $('#modal-root').hidden = true;
  $('#modal-window').innerHTML = '';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function attr(s) { return escapeHtml(s).replace(/\n/g, ' '); }

function formatDate(d, withTime = false) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  const today = new Date();
  const sameDay = dt.toDateString() === today.toDateString();
  if (sameDay) {
    return `dziś · ${dt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`;
  }
  const opts = withTime
    ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short' };
  return dt.toLocaleString('pl-PL', opts);
}

function formatSize(b) {
  if (!b || b < 1024) return `${b || 0} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function sanitizeHtml(html) {
  // Strip <script>/<iframe>/<style>/event handlers. Trust other tags from our DB.
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
}

function banner(text, kind = null) {
  const el = $('#banner');
  if (!el) return;
  el.className = 'banner' + (kind ? ` ${kind}` : '') + ' is-visible';
  el.textContent = text;
  clearTimeout(state._bannerTimer);
  if (kind === 'ok' || kind === 'error') {
    state._bannerTimer = setTimeout(() => el.classList.remove('is-visible'), 2200);
  }
}
