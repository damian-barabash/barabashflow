// Wiadomości — every enquiry from the site forms (home/footer/kontakt).
// Read/replied/archive flags, internal note, reply via mail client, one-click
// "add to CRM" (creates the client + a timeline entry and links the message).
import { sb, $, $$, banner, escapeHtml, attr, fmtDate, ask } from './admin-core.js?v=2026-09-12a';
import { upsertClientFromMessage, openClient } from './admin-crm.js?v=2026-09-12a';

const I = { items: [], filter: 'inbox' };

export async function loadInbox() {
  const { data, error } = await sb.from('contact_submissions').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) console.error(error);
  I.items = data || [];
  const unread = I.items.filter((m) => !m.is_read && !m.is_archived).length;
  const b = $('#inbox-badge'); if (b) { b.style.display = unread ? '' : 'none'; b.textContent = String(unread); }
}

export function bindInboxUI() {
  $('#inbox-filters')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]'); if (!b) return;
    I.filter = b.dataset.filter; $$('#inbox-filters button').forEach((x) => x.classList.toggle('is-active', x === b)); renderInbox();
  });
  $('#inbox-list')?.addEventListener('click', onAction);
  $('#inbox-list')?.addEventListener('change', async (e) => {
    const note = e.target.closest('[data-note]'); if (!note) return;
    const { error } = await sb.from('contact_submissions').update({ admin_note: note.value.trim() || null }).eq('id', note.dataset.note);
    if (error) banner(error.message, 'error'); else banner('Notatka zapisana', 'ok');
  });
}

const SOURCE_LABEL = { footer: 'formularz w stopce', website: 'strona główna', 'kontakt-page': 'strona Kontakt', 'mascot-bot': 'maskotka' };

export function renderInbox() {
  const list = $('#inbox-list'); if (!list) return;
  let items = I.items;
  if (I.filter === 'inbox') items = items.filter((m) => !m.is_archived);
  if (I.filter === 'unread') items = items.filter((m) => !m.is_read && !m.is_archived);
  if (I.filter === 'replied') items = items.filter((m) => m.is_replied && !m.is_archived);
  if (I.filter === 'archive') items = items.filter((m) => m.is_archived);
  $('#inbox-aside').textContent = `${items.length} z ${I.items.length}`;
  if (!items.length) { list.innerHTML = '<div class="empty-state">Pusto</div>'; return; }
  list.innerHTML = items.map((m) => `
    <article class="msg${m.is_read ? '' : ' is-unread'}${m.is_replied ? ' is-replied' : ''}" data-id="${m.id}">
      <header class="msg-head">
        <div>
          <div class="msg-name">${m.ref ? `<span class="pill dark">${escapeHtml(m.ref)}</span> ` : ''}${escapeHtml(m.name || '—')} ${m.company ? `<span class="pill">${escapeHtml(m.company)}</span>` : ''} ${m.client_id ? '<span class="pill lime">w CRM</span>' : ''}</div>
          <div class="msg-meta">
            <a href="mailto:${attr(m.email)}">${escapeHtml(m.email)}</a>${m.phone ? ` · <a href="tel:${attr(m.phone)}">${escapeHtml(m.phone)}</a>` : ''}
            · ${fmtDate(m.created_at)} · ${escapeHtml(SOURCE_LABEL[m.source] || m.source || '')}${m.page ? ` <span class="soft">${escapeHtml(m.page)}</span>` : ''}
          </div>
        </div>
        <div class="msg-tags">${m.service ? `<span class="pill dark">${escapeHtml(m.service)}</span>` : ''}${m.budget ? `<span class="pill">${escapeHtml(m.budget)}</span>` : ''}${m.locale ? `<span class="pill">${escapeHtml(m.locale.toUpperCase())}</span>` : ''}</div>
      </header>
      <div class="msg-body">${escapeHtml(m.message || '')}</div>
      <div class="msg-note"><input data-note="${m.id}" value="${attr(m.admin_note)}" placeholder="Notatka wewnętrzna (Enter = zapis)…" /></div>
      <footer class="msg-actions">
        <a class="btn small primary" href="mailto:${attr(m.email)}?subject=${encodeURIComponent('Re: ' + (m.service ? m.service + ' — ' : '') + 'BarabashFlow')}" data-act="reply" data-id="${m.id}">Odpowiedz</a>
        <button class="btn small" data-act="read" data-id="${m.id}">${m.is_read ? 'Nieprzeczytane' : 'Przeczytane'}</button>
        <button class="btn small" data-act="replied" data-id="${m.id}">${m.is_replied ? 'Cofnij „odpowiedziano”' : 'Odpowiedziano'}</button>
        ${m.client_id ? `<button class="btn small" data-act="open-client" data-id="${m.id}">Otwórz w CRM</button>` : `<button class="btn small" data-act="crm" data-id="${m.id}">Dodaj do CRM</button>`}
        <span class="spread"></span>
        <button class="btn small" data-act="archive" data-id="${m.id}">${m.is_archived ? 'Przywróć' : 'Archiwizuj'}</button>
        <button class="btn small danger" data-act="delete" data-id="${m.id}">Usuń</button>
      </footer>
    </article>`).join('');
}

async function onAction(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const m = I.items.find((x) => x.id === b.dataset.id); if (!m) return;
  const act = b.dataset.act;
  const patch = async (p) => { const { error } = await sb.from('contact_submissions').update(p).eq('id', m.id); if (error) throw error; Object.assign(m, p); };
  try {
    if (act === 'reply') { await patch({ is_read: true }); await loadInbox(); renderInbox(); return; }
    if (act === 'read') await patch({ is_read: !m.is_read });
    if (act === 'replied') await patch({ is_replied: !m.is_replied, is_read: true });
    if (act === 'archive') await patch({ is_archived: !m.is_archived, is_read: true });
    if (act === 'delete') { if (!ask('Usunąć wiadomość bezpowrotnie?')) return; const { error } = await sb.from('contact_submissions').delete().eq('id', m.id); if (error) throw error; }
    if (act === 'crm') {
      const client = await upsertClientFromMessage(m);
      await patch({ client_id: client.id, is_read: true });
      banner(`Dodano do CRM: ${client.name}`, 'ok');
      openClient(client.id);
    }
    if (act === 'open-client') { openClient(m.client_id); return; }
    await loadInbox(); renderInbox();
    if (act !== 'crm') banner('OK', 'ok');
  } catch (err) { console.error(err); banner(err.message || 'Błąd', 'error'); }
}
