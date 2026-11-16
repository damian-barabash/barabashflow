// Admin → Leady (2026-11-16): daily new companies from public registries with
// an AI fit score and a personalised offer draft (edge `leads`, pg_cron every
// 10 min). The owner reviews each card: edit subject/body, rewrite with AI,
// send (Resend from leads_config.from_email, reply-to + bcc to Gmail), skip.
// Undecided leads simply stay in "Do decyzji". Settings → site_settings.leads_config.
import { sb, $, state, banner, escapeHtml } from './admin-core.js?v=2026-11-10a';

const INDUSTRIES = {
  beauty: 'Beauty i wellness', gastro: 'Gastronomia', budowa: 'Budowa i remonty', zdrowie: 'Zdrowie i medycyna',
  edukacja: 'Edukacja i szkolenia', auto: 'Motoryzacja', nieruchomosci: 'Nieruchomości (agencje)', turystyka: 'Turystyka i noclegi',
  handel: 'Handel / e-commerce', uslugi: 'Usługi profesjonalne', sport: 'Sport i rekreacja', transport: 'Transport i logistyka', produkcja: 'Produkcja / rzemiosło',
};
const VOIV = ['DOLNOŚLĄSKIE', 'KUJAWSKO-POMORSKIE', 'LUBELSKIE', 'LUBUSKIE', 'ŁÓDZKIE', 'MAŁOPOLSKIE', 'MAZOWIECKIE', 'OPOLSKIE', 'PODKARPACKIE', 'PODLASKIE', 'POMORSKIE', 'ŚLĄSKIE', 'ŚWIĘTOKRZYSKIE', 'WARMIŃSKO-MAZURSKIE', 'WIELKOPOLSKIE', 'ZACHODNIOPOMORSKIE'];
const DEFAULTS = {
  enabled: true, per_day: 10, max_age_days: 21, min_fit: 45, industries: Object.keys(INDUSTRIES), voivodeships: [],
  from_name: 'Damian Barabash', from_email: 'office@barabashflow.pl', reply_to: 'dmytrii.barabash@gmail.com', bcc: 'dmytrii.barabash@gmail.com',
  signature: 'Damian Barabash\nBarabashFlow · strony, sklepy i platformy na zamówienie\nbarabashflow.pl', instructions: '', test_mode: false,
};
const FILTERS = { ready: 'Do decyzji', sent: 'Wysłane', skipped: 'Pominięte', rejected: 'Odrzucone przez AI', failed: 'Błędy' };

state.leads = []; state.leadsFilter = 'ready';
const cfg = () => ({ ...DEFAULTS, ...(state.settings.leads_config?.value_meta || {}) });

export async function loadLeads() {
  const { data, error } = await sb.from('leads')
    .select('id,source,ext_id,name,legal_form,registered_at,city,voivodeship,address,email,website,nip,capital,pkd_code,pkd_desc,pkd_other,board,industry,fit_score,fit_reason,subject,body,status,composed_at,sent_at,error,crm_client_id,public_token,views,viewed_at,last_viewed_at,briefed_at')
    .in('status', ['ready', 'sent', 'skipped', 'failed', 'rejected', 'scored'])
    .order('composed_at', { ascending: false, nullsFirst: false }).order('fit_score', { ascending: false }).limit(400);
  if (error) { console.error(error); return; }
  state.leads = data || [];
}

const daysAgo = (d) => { const n = Math.round((Date.now() - new Date(d).getTime()) / 864e5); return n <= 0 ? 'dziś' : n === 1 ? 'wczoraj' : `${n} dni temu`; };
const fitClass = (f) => (f >= 70 ? 'is-hi' : f >= 50 ? 'is-mid' : 'is-lo');
const age = (decade) => !decade ? '' : Number(decade) >= 2000 ? 'ur. po 2000' : `ur. lata ${String(decade).slice(2, 4)}.`;
const autoGrow = (el) => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; };

export function renderLeads() {
  const ready = state.leads.filter((l) => l.status === 'ready');
  const badge = $('#leads-badge');
  if (badge) { badge.textContent = String(ready.length); badge.style.display = ready.length ? '' : 'none'; }
  const st = state.settings.leads_status?.value_meta;
  const c = cfg();
  $('#leads-status').textContent = st?.ts
    ? `${st.ok === false ? '⚠ ' : ''}Ostatni krok ${new Date(st.ts).toLocaleString('pl-PL', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}: ${st.error || ({ harvest: `szukanie w KRS (+${st.harvested ?? 0})`, score: `ocena AI (${st.scored ?? 0})`, compose: `pisanie ofert (${st.composed ?? 0})`, idle: 'limit na dziś gotowy' }[st.step] || st.step)} · dziś przygotowano ${st.ready_today ?? 0}/${c.per_day}${c.test_mode ? ' · TRYB TESTOWY (wysyłka tylko do Ciebie)' : ''}${c.enabled ? '' : ' · WSTRZYMANE'}`
    : 'Wyszukiwarka jeszcze nie działała.';
  $('#leads-status').classList.toggle('is-err', st?.ok === false);
  $('#leads-filters').innerHTML = Object.entries(FILTERS).map(([k, l]) => {
    const n = state.leads.filter((x) => (k === 'rejected' ? ['rejected', 'scored'].includes(x.status) : x.status === k)).length;
    return `<button type="button" class="conn-chip${state.leadsFilter === k ? ' is-on' : ''}" data-lfilter="${k}">${l}${n ? ` · ${n}` : ''}</button>`;
  }).join('');
  const list = state.leads.filter((x) => (state.leadsFilter === 'rejected' ? ['rejected', 'scored'].includes(x.status) : x.status === state.leadsFilter));
  if (state.leadsFilter === 'ready' || state.leadsFilter === 'rejected') list.sort((a, b) => (b.fit_score ?? 0) - (a.fit_score ?? 0));
  else list.sort((a, b) => String(b.sent_at || b.composed_at || '').localeCompare(String(a.sent_at || a.composed_at || '')));
  $('#leads-list').innerHTML = list.length ? list.map(card).join('') : `<div class="empty-state">${state.leadsFilter === 'ready' ? 'Wszystko rozpatrzone — nowe leady pojawią się jutro rano' : 'Pusto'}</div>`;
  $('#leads-list').querySelectorAll('textarea[data-f="body"]').forEach(autoGrow);
  renderLeadSettings();
}

function card(l) {
  const sent = l.status === 'sent';
  const board = (l.board || []).map((b) => `${escapeHtml((b.role || '').toLowerCase())} ${escapeHtml(b.initials || '')}${b.decade ? ` <em>${age(b.decade)}</em>` : ''}`).join(' · ');
  const regUrl = l.source === 'krs' ? `https://rejestr.io/krs/${Number(l.ext_id)}` : null;
  const c = cfg();
  return `
  <article class="lead${sent ? ' is-sent' : ''}" data-lead="${l.id}">
    <div class="lead-info">
      <div class="lead-top">
        ${l.fit_score != null ? `<span class="lead-fit ${fitClass(l.fit_score)}" title="Dopasowanie wg AI">${l.fit_score}</span>` : ''}
        <div>
          <h3 class="lead-name">${escapeHtml(l.name)}</h3>
          <div class="lead-meta">${escapeHtml(INDUSTRIES[l.industry] || l.industry || '')} · ${escapeHtml(l.city || '')}${l.voivodeship ? `, ${escapeHtml(l.voivodeship.toLowerCase())}` : ''}</div>
        </div>
      </div>
      ${l.briefed_at ? `<div class="lead-signal is-hot">✓ Zostawił brief na swojej stronie · ${new Date(l.briefed_at).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>` : l.views ? `<div class="lead-signal">👁 Otworzył swoją stronę ${l.views}× · ostatnio ${new Date(l.last_viewed_at || l.viewed_at).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>` : ''}
      ${l.fit_reason ? `<p class="lead-reason">${escapeHtml(l.fit_reason)}</p>` : ''}
      <dl class="lead-facts">
        <div><dt>Rejestracja</dt><dd>${escapeHtml(l.registered_at || '')} <span class="coords">(${daysAgo(l.registered_at)})</span></dd></div>
        <div><dt>Działalność</dt><dd>${escapeHtml(l.pkd_desc || '')} <span class="coords">${escapeHtml(l.pkd_code || '')}</span>${(l.pkd_other || []).length ? `<details><summary>+ ${(l.pkd_other || []).length} inne</summary>${(l.pkd_other || []).map((p) => `<div class="coords">${escapeHtml(p.desc || '')}</div>`).join('')}</details>` : ''}</dd></div>
        <div><dt>E-mail</dt><dd><a href="mailto:${escapeHtml(l.email)}">${escapeHtml(l.email)}</a></dd></div>
        <div><dt>Strona</dt><dd>${l.website ? `<a href="${escapeHtml(/^https?:/.test(l.website) ? l.website : 'https://' + l.website)}" target="_blank" rel="noopener">${escapeHtml(l.website)}</a>` : '<strong>brak</strong>'}</dd></div>
        ${board ? `<div><dt>Zarząd</dt><dd>${board}</dd></div>` : ''}
        <div><dt>Forma</dt><dd>${escapeHtml(l.legal_form || '')}${l.capital ? ` · kapitał ${escapeHtml(l.capital)}` : ''}</dd></div>
        <div><dt>Rejestr</dt><dd>${l.source.toUpperCase()} ${escapeHtml(String(Number(l.ext_id) || l.ext_id))}${l.nip ? ` · NIP ${escapeHtml(l.nip)}` : ''}${regUrl ? ` · <a href="${regUrl}" target="_blank" rel="noopener">rejestr.io ↗</a>` : ''}</dd></div>
        ${l.public_token ? `<div><dt>Jego strona</dt><dd><a href="/oferta/?l=${escapeHtml(l.public_token)}&preview=1" target="_blank" rel="noopener">podgląd propozycji ↗</a></dd></div>` : ''}
      </dl>
    </div>
    <div class="lead-mail">
      ${sent ? `<div class="coords">Wysłano ${new Date(l.sent_at).toLocaleString('pl-PL')}${l.crm_client_id ? ' · dodano do CRM' : ''}</div>` : ''}
      ${l.status === 'failed' ? `<div class="blog-agent-status is-err">${escapeHtml(l.error || 'Błąd wysyłki')}</div>` : ''}
      ${l.subject || l.body ? `
        <label class="field-label">Temat</label>
        <input data-f="subject" value="${escapeHtml(l.subject || '')}" ${sent ? 'readonly' : ''} />
        <label class="field-label">Treść</label>
        <textarea data-f="body" rows="8" ${sent ? 'readonly' : ''}>${escapeHtml(l.body || '')}</textarea>
        <div class="lead-foot">Wszystkie moje realizacje (strony, sklepy i platformy) można zobaczyć na https://barabashflow.pl/projekty/<br><br>${escapeHtml(c.signature)}<br><br>Adres pochodzi z publicznego rejestru ${l.source === 'ceidg' ? 'CEIDG' : 'KRS'}. Jeśli to nie temat dla Państwa, wystarczy odpisać „NIE”, a więcej nie napiszę.</div>`
      : '<div class="coords">Oferta jeszcze nienapisana.</div>'}
      ${sent ? '' : `
        <div class="lead-ai"><input data-f="instr" placeholder="Przepisz z AI, np. krócej · bardziej o sklepie · inny przykład realizacji" /><button class="btn small" data-lact="rewrite">✦ Przepisz</button></div>
        <div class="button-row lead-actions">
          <button class="btn primary" data-lact="send">Wyślij${c.test_mode ? ' (test)' : ''}</button>
          <button class="btn" data-lact="save">Zapisz</button>
          <button class="btn" data-lact="test" title="Wyślij tę wersję do siebie (${escapeHtml(c.reply_to)})">Test do mnie</button>
          <span class="spread"></span>
          ${l.status === 'skipped' || l.status === 'rejected' || l.status === 'scored' ? '<button class="btn small" data-lact="restore">Przywróć do decyzji</button>' : '<button class="btn small danger" data-lact="skip">Pomiń</button>'}
        </div>`}
    </div>
  </article>`;
}

function renderLeadSettings() {
  const box = $('#leads-settings');
  if (!box || box.contains(document.activeElement)) return;
  const c = cfg();
  const opt = (v, cur, label) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${label}</option>`;
  box.innerHTML = `
    <div class="row-3">
      <div class="field"><label class="field-label">Wyszukiwanie</label><select data-c="enabled" data-bool>${opt('true', c.enabled, 'Włączone — codziennie')}${opt('false', c.enabled, 'Wstrzymane')}</select></div>
      <div class="field"><label class="field-label">Nowych leadów dziennie</label><input type="number" min="1" max="40" data-c="per_day" value="${c.per_day}" /></div>
      <div class="field"><label class="field-label">Wysyłka</label><select data-c="test_mode" data-bool>${opt('false', c.test_mode, 'Do firm (normalnie)')}${opt('true', c.test_mode, 'Tryb testowy — tylko do mnie')}</select></div>
    </div>
    <div class="row-3">
      <div class="field"><label class="field-label">Firma zarejestrowana max (dni temu)</label><input type="number" min="3" max="90" data-c="max_age_days" value="${c.max_age_days}" /></div>
      <div class="field"><label class="field-label">Minimalne dopasowanie AI (0–100)</label><input type="number" min="0" max="95" data-c="min_fit" value="${c.min_fit}" /></div>
      <div class="field"><label class="field-label">Źródła</label><div class="coords">KRS (spółki) · CEIDG po podaniu tokenu</div></div>
    </div>
    <div class="field"><label class="field-label">Branże</label><div class="conn-chips">${Object.entries(INDUSTRIES).map(([k, l]) => `<button type="button" class="conn-chip${c.industries.includes(k) ? ' is-on' : ''}" data-ind="${k}"><span class="chip-dot"></span>${escapeHtml(l)}</button>`).join('')}</div></div>
    <div class="field"><label class="field-label">Województwa (nic nie zaznaczone = cała Polska)</label><div class="conn-chips">${VOIV.map((v) => `<button type="button" class="conn-chip${c.voivodeships.includes(v) ? ' is-on' : ''}" data-voiv="${v}">${escapeHtml(v.toLowerCase())}</button>`).join('')}</div></div>
    <div class="row-2">
      <div class="field"><label class="field-label">Nadawca — imię</label><input data-c="from_name" value="${escapeHtml(c.from_name)}" /></div>
      <div class="field"><label class="field-label">Nadawca — e-mail (domena barabashflow.pl)</label><input data-c="from_email" value="${escapeHtml(c.from_email)}" /></div>
    </div>
    <div class="row-2">
      <div class="field"><label class="field-label">Odpowiedzi trafiają na (Reply-To)</label><input data-c="reply_to" value="${escapeHtml(c.reply_to)}" /></div>
      <div class="field"><label class="field-label">Kopia wysłanych (BCC)</label><input data-c="bcc" value="${escapeHtml(c.bcc)}" /></div>
    </div>
    <div class="field"><label class="field-label">Podpis</label><textarea data-c="signature" rows="3">${escapeHtml(c.signature)}</textarea></div>
    <div class="field"><label class="field-label">Wskazówki dla AI do ofert</label><textarea data-c="instructions" rows="3" placeholder="np. zawsze proponuj bezpłatną konsultację 15 min; dla gastronomii wspominaj o menu online">${escapeHtml(c.instructions)}</textarea></div>
    <div class="button-row"><span class="coords">Każdy adres dostaje maksymalnie jedną wiadomość. Odpowiedzi przychodzą na Reply-To, kopia wysłanej oferty — na BCC, więc odpowiedź klienta ląduje w tym samym wątku.</span><span class="spread"></span><button class="btn primary" data-lact="save-settings">Zapisz ustawienia</button></div>`;
}

// ── actions ─────────────────────────────────────────────────────────────────
const leadEl = (id) => document.querySelector(`[data-lead="${id}"]`);
const draft = (id) => { const el = leadEl(id); return { subject: el?.querySelector('[data-f="subject"]')?.value ?? '', body: el?.querySelector('[data-f="body"]')?.value ?? '' }; };

async function call(body) {
  const { data, error } = await sb.functions.invoke('leads', { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

async function act(kind, id, btn) {
  const lead = state.leads.find((l) => l.id === id);
  const busy = (on) => { if (btn) { btn.disabled = on; btn.classList.toggle('is-busy', on); } };
  if (kind === 'restore' && !lead.subject) kind = 'rewrite';
  try {
    if (kind === 'save') {
      const d = draft(id);
      const { error } = await sb.from('leads').update(d).eq('id', id); if (error) throw error;
      Object.assign(lead, d); banner('Zapisano', 'ok'); return;
    }
    if (kind === 'skip' || kind === 'restore') {
      const status = kind === 'skip' ? 'skipped' : (lead.subject ? 'ready' : 'scored');
      const { error } = await sb.from('leads').update({ status, decided_at: new Date().toISOString() }).eq('id', id); if (error) throw error;
      lead.status = status; renderLeads(); banner(kind === 'skip' ? 'Pominięto' : 'Przywrócono', 'ok'); return;
    }
    if (kind === 'rewrite' || (kind === 'restore-compose')) {
      busy(true); banner('AI przepisuje ofertę…', null);
      const instruction = leadEl(id)?.querySelector('[data-f="instr"]')?.value || '';
      const r = await call({ action: 'compose', id, instruction });
      Object.assign(lead, { subject: r.subject, body: r.body, status: lead.status === 'sent' ? 'sent' : 'ready' });
      renderLeads(); banner('Nowa wersja gotowa', 'ok'); return;
    }
    if (kind === 'test') {
      busy(true); const d = draft(id);
      const r = await call({ action: 'send', id, ...d, test: true });
      banner(`Test wysłany na ${r.to}`, 'ok'); return;
    }
    if (kind === 'send') {
      const d = draft(id); const c = cfg();
      if (!c.test_mode && !confirm(`Wysłać ofertę do ${lead.email}?\n\nTemat: ${d.subject}`)) return;
      busy(true); banner('Wysyłanie…', null);
      const r = await call({ action: 'send', id, ...d });
      if (r.test) { banner(`Tryb testowy: wysłano do ${r.to}`, 'ok'); return; }
      Object.assign(lead, d, { status: 'sent', sent_at: new Date().toISOString(), crm_client_id: r.crm_client_id });
      renderLeads(); banner('Wysłano · klient dodany do CRM', 'ok');
    }
  } catch (err) { banner(err.message || 'Błąd', 'error'); }
  finally { busy(false); }
}

async function saveSettings() {
  const box = $('#leads-settings');
  const v = { ...cfg() };
  box.querySelectorAll('[data-c]').forEach((el) => {
    const k = el.dataset.c;
    v[k] = el.hasAttribute('data-bool') ? el.value === 'true' : el.type === 'number' ? Number(el.value) : el.value.trim();
  });
  v.industries = [...box.querySelectorAll('[data-ind].is-on')].map((b) => b.dataset.ind);
  v.voivodeships = [...box.querySelectorAll('[data-voiv].is-on')].map((b) => b.dataset.voiv);
  if (!v.industries.length) { banner('Zaznacz przynajmniej jedną branżę', 'error'); return; }
  if (!/@barabashflow\.pl$/i.test(v.from_email)) { banner('Nadawca musi być w domenie barabashflow.pl (zweryfikowana w Resend)', 'error'); return; }
  v.per_day = Math.min(Math.max(Math.round(v.per_day || 10), 1), 40);
  v.max_age_days = Math.min(Math.max(Math.round(v.max_age_days || 21), 3), 90);
  v.min_fit = Math.min(Math.max(Math.round(v.min_fit || 0), 0), 95);
  const { error } = await sb.from('site_settings').upsert({ key: 'leads_config', value_meta: v }, { onConflict: 'key' });
  if (error) { banner(error.message, 'error'); return; }
  state.settings.leads_config = { ...(state.settings.leads_config || { key: 'leads_config' }), value_meta: v };
  renderLeads(); banner('Ustawienia zapisane', 'ok');
}

async function harvestNow(btn) {
  btn.disabled = true; banner('Szukam / oceniam / piszę… (do 2 min)', null);
  try {
    const r = await call({ action: 'harvest_now' });
    await Promise.all([loadLeads(), (async () => { const { data } = await sb.from('site_settings').select('*').eq('key', 'leads_status').maybeSingle(); if (data) state.settings.leads_status = data; })()]);
    renderLeads();
    banner(`Krok: ${r.step}${r.harvested != null ? ` · nowych firm ${r.harvested}` : ''}${r.scored != null ? ` · ocenionych ${r.scored}` : ''}${r.composed != null ? ` · ofert ${r.composed}` : ''}`, 'ok');
  } catch (err) { banner(err.message, 'error'); }
  finally { btn.disabled = false; }
}

export function bindLeadsUI() {
  const panel = $('[data-panel="leads"]'); if (!panel) return;
  panel.addEventListener('click', (e) => {
    const f = e.target.closest('[data-lfilter]'); if (f) { state.leadsFilter = f.dataset.lfilter; renderLeads(); return; }
    const chip = e.target.closest('[data-ind], [data-voiv]'); if (chip) { chip.classList.toggle('is-on'); return; }
    const b = e.target.closest('[data-lact]'); if (!b) return;
    if (b.dataset.lact === 'save-settings') return saveSettings();
    if (b.dataset.lact === 'harvest') return harvestNow(b);
    if (b.dataset.lact === 'toggle-settings') { $('#leads-settings-wrap').hidden = !$('#leads-settings-wrap').hidden; return; }
    act(b.dataset.lact, b.closest('[data-lead]')?.dataset.lead, b);
  });
  panel.addEventListener('input', (e) => { if (e.target.matches('textarea[data-f="body"]')) autoGrow(e.target); });
}
