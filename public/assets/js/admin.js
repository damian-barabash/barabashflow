// BarabashFlow admin — entry point. Auth, tabs, Strona (site settings +
// stats + FAQ), Blog (AI autopilot), Statystyki; the collection editors live
// in admin-projects / admin-services / admin-inbox / admin-crm.
import { sb, $, $$, state, banner, escapeHtml, attr, mediaUrl, MEDIA_BUCKET, uploadImage, removeMedia, pickFile, translateItems, readForm } from './admin-core.js?v=2026-09-12a';
import { getTheme, toggleTheme, onThemeChange } from './theme.js?v=2026-09-12a';
import { loadProjects, bindProjectsUI, renderProjectList } from './admin-projects.js?v=2026-09-12a';
import { loadServices, loadFaq, bindServicesUI, renderServiceList, renderFaq } from './admin-services.js?v=2026-09-12a';
import { loadInbox, bindInboxUI, renderInbox } from './admin-inbox.js?v=2026-09-12a';
import { loadCrm, bindCrmUI, renderCrm, openClient } from './admin-crm.js?v=2026-09-12a';

init().catch((err) => console.error('[admin] init failed', err));

async function init() {
  bindAuthUI();
  bindShellUI();
  bindThemeToggle();
  setupTabAway();
  const { data: { session } } = await sb.auth.getSession();
  if (session) await onSignedIn(session.user); else showAuth();
  sb.auth.onAuthStateChange((evt, sess) => {
    if (evt === 'SIGNED_OUT' || !sess?.user) { state.user = null; showAuth(); return; }
    if (evt === 'TOKEN_REFRESHED' || evt === 'USER_UPDATED') { state.user = sess.user; return; }
    if (state.user && state.user.id === sess.user.id) { state.user = sess.user; return; }
    onSignedIn(sess.user);
  });
}

function showAuth() { $('#auth-screen').style.display = ''; $('#shell').classList.remove('is-active'); }
async function onSignedIn(user) {
  state.user = user;
  $('#session-email').textContent = user.email;
  $('#auth-screen').style.display = 'none';
  $('#shell').classList.add('is-active');
  await refreshAll();
  // deep link: /admin#crm or #wiadomosci
  const hash = location.hash.replace('#', '');
  if (hash) switchTab(hash);
}

async function refreshAll() {
  await Promise.all([loadSettings(), loadServices(), loadProjects(), loadFaq(), loadInbox(), loadCrm(), loadBlog(), loadStats()]);
  renderSettings(); renderStatsEditor(); renderFaq();
  renderProjectList(); renderServiceList(); renderInbox(); renderCrm(); renderBlog(); renderStats();
}

function bindAuthUI() {
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#auth-status'); status.textContent = 'Logowanie…'; status.style.color = '';
    const { error } = await sb.auth.signInWithPassword({ email: e.target.elements.email.value.trim(), password: e.target.elements.password.value });
    if (error) { status.style.color = 'var(--danger)'; status.textContent = error.message; } else { status.style.color = 'var(--ok)'; status.textContent = 'OK'; }
  });
  $('#signout').addEventListener('click', () => sb.auth.signOut());
}

function switchTab(tab) {
  const btn = $(`.tab-btn[data-tab="${tab}"]`); if (!btn) return;
  $$('.tab-btn').forEach((x) => x.classList.toggle('is-active', x === btn));
  $$('.panel-page').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab));
  history.replaceState(null, '', `#${tab}`);
}

function bindBurger() {
  const btn = $('#nav-burger'), top = $('.top'); if (!btn || !top) return;
  const close = () => { top.classList.remove('menu-open'); btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); const open = top.classList.toggle('menu-open'); btn.setAttribute('aria-expanded', String(open)); });
  document.addEventListener('click', (e) => { if (top.classList.contains('menu-open') && !e.target.closest('.top-collapsible') && !e.target.closest('#nav-burger')) close(); });
  $('.top-collapsible')?.addEventListener('click', (e) => { if (e.target.closest('.tab-btn, a')) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

function bindShellUI() {
  bindBurger();
  $$('.tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#owner-photo-slot').addEventListener('click', (e) => {
    if (e.target.closest('.remove')) return;
    pickFile().then((file) => { if (!file) return; state.pendingOwnerPhoto = file; state.removeOwnerPhoto = false; paintOwnerPhoto(URL.createObjectURL(file)); });
  });
  $('[data-remove-owner-photo]').addEventListener('click', (e) => { e.stopPropagation(); state.pendingOwnerPhoto = null; state.removeOwnerPhoto = true; paintOwnerPhoto(null); });
  $('#save-settings').addEventListener('click', saveSettings);
  $('#translate-settings')?.addEventListener('click', async () => {
    if (!confirm('Przetłumaczyć WSZYSTKIE pola z polskiego i nadpisać EN/RU?')) return;
    banner('Tłumaczenie PL → EN/RU…', null);
    try { const n = await autoTranslateSettings(true); banner(`Przetłumaczono ${n} pól — sprawdź i kliknij Zapisz`, 'ok'); }
    catch (err) { banner(err.message || 'Błąd tłumaczenia', 'error'); }
  });
  $('#stats-add')?.addEventListener('click', () => { statsDraft().push({ value: '', label_pl: '' }); renderStatsEditor(); });
  $('#stats-editor')?.addEventListener('click', (e) => { const rm = e.target.closest('[data-rm-stat]'); if (!rm) return; syncStats(); statsDraft().splice(Number(rm.dataset.rmStat), 1); renderStatsEditor(); });
  bindProjectsUI(); bindServicesUI(); bindInboxUI(); bindCrmUI(); bindBlogUI();
}

function bindThemeToggle() {
  const btn = $('#theme-toggle'), icon = $('#theme-icon');
  const moon = `<path d="M14.5 11.5a5.5 5.5 0 0 1-7-7 5.5 5.5 0 1 0 7 7Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  const sun = `<circle cx="10" cy="10" r="3.4" stroke="currentColor" stroke-width="1.4"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M10 2.5v2"/><path d="M10 15.5v2"/><path d="M2.5 10h2"/><path d="M15.5 10h2"/><path d="M4.7 4.7l1.4 1.4"/><path d="M13.9 13.9l1.4 1.4"/><path d="M4.7 15.3l1.4-1.4"/><path d="M13.9 6.1l1.4-1.4"/></g>`;
  const paint = () => { icon.innerHTML = getTheme() === 'light' ? moon : sun; };
  paint(); btn.addEventListener('click', toggleTheme); onThemeChange(paint);
}

function setupTabAway() {
  const original = document.title;
  const lines = ['Wróć do studia', 'Wiadomości czekają', 'Tu się dzieje', 'Hej, gdzie ty?', 'Klienci sami się nie zadzwonią', 'Czekam — zerknij', 'Studio bez ciebie cichnie'];
  let last = -1, cycler = 0;
  const pick = () => { let i; do { i = Math.floor(Math.random() * lines.length); } while (i === last); last = i; return lines[i]; };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { document.title = pick(); clearInterval(cycler); cycler = setInterval(() => { document.title = pick(); }, 6000); }
    else { clearInterval(cycler); cycler = 0; document.title = original; }
  });
}

// ── Strona (site_settings) ──────────────────────────────────────────────────
async function loadSettings() {
  const { data, error } = await sb.from('site_settings').select('*');
  if (error) { console.error(error); return; }
  state.settings = Object.fromEntries((data || []).map((r) => [r.key, r]));
}
function renderSettings() {
  $$('input[data-setting], textarea[data-setting]').forEach((el) => {
    const row = state.settings[el.dataset.setting];
    el.value = row ? (row[`value_${el.dataset.lang}`] || '') : '';
  });
  const photoPath = state.settings.owner_photo_path?.value_meta?.path;
  paintOwnerPhoto(photoPath ? mediaUrl(photoPath) : null);
  state.pendingOwnerPhoto = null; state.removeOwnerPhoto = false;
}
function paintOwnerPhoto(url) {
  const slot = $('#owner-photo-slot');
  if (url) { slot.classList.add('has-image'); slot.style.backgroundImage = `url("${url}")`; }
  else { slot.classList.remove('has-image'); slot.style.backgroundImage = ''; }
}
function statsDraft() {
  if (!state._stats) state._stats = (state.settings.home_stats?.value_meta?.items || []).map((x) => ({ ...x }));
  return state._stats;
}
function renderStatsEditor() {
  const wrap = $('#stats-editor'); if (!wrap) return;
  const items = statsDraft();
  wrap.innerHTML = items.map((st, i) => `
    <div class="result-row" data-i="${i}">
      <input class="result-value" data-s="value" value="${attr(st.auto === 'projects' ? 'AUTO' : st.value)}" ${st.auto ? 'disabled title="Liczba opublikowanych projektów — liczona automatycznie"' : ''} placeholder="np. 24 h" />
      <div class="lang-trio">
        <div class="field-input" data-lang="PL"><input data-s="label_pl" value="${attr(st.label_pl)}" /></div>
        <div class="field-input" data-lang="EN"><input data-s="label_en" value="${attr(st.label_en)}" /></div>
        <div class="field-input" data-lang="RU"><input data-s="label_ru" value="${attr(st.label_ru)}" /></div>
      </div>
      <button type="button" class="icon-btn mini" data-rm-stat="${i}" title="Usuń">×</button>
    </div>`).join('');
}
function syncStats() {
  $$('#stats-editor .result-row').forEach((row) => {
    const st = statsDraft()[Number(row.dataset.i)]; if (!st) return;
    $$('[data-s]', row).forEach((el) => { if (el.disabled) return; st[el.dataset.s] = el.value.trim(); });
  });
}

async function saveSettings() {
  banner('Zapisywanie…', null);
  try {
    try { banner('Tłumaczenie PL → EN/RU…', null); await autoTranslateSettings(false); banner('Zapisywanie…', null); }
    catch (trErr) { console.warn('auto-translate failed', trErr); banner('Tłumaczenie niedostępne — zapisuję bez niego', null); }
    const keys = new Set(); $$('input[data-setting], textarea[data-setting]').forEach((el) => keys.add(el.dataset.setting));
    const upserts = [];
    for (const key of keys) {
      const row = state.settings[key] || { key };
      const next = { key, value_meta: row.value_meta || {} };
      ['pl', 'en', 'ru'].forEach((l) => { const el = document.querySelector(`[data-setting="${key}"][data-lang="${l}"]`); next[`value_${l}`] = el ? el.value.trim() || null : null; });
      upserts.push(next);
    }
    // owner photo
    let ownerMeta = state.settings.owner_photo_path?.value_meta || {};
    if (state.pendingOwnerPhoto) { const path = await uploadImage(state.pendingOwnerPhoto, 'owner'); if (ownerMeta.path && ownerMeta.path !== path) await removeMedia(ownerMeta.path).catch(() => {}); ownerMeta = { path }; }
    else if (state.removeOwnerPhoto) { if (ownerMeta.path) await removeMedia(ownerMeta.path).catch(() => {}); ownerMeta = {}; }
    upserts.push({ key: 'owner_photo_path', value_meta: ownerMeta });
    // stats (translate labels)
    syncStats();
    const items = statsDraft();
    try {
      const need = items.map((st, i) => ({ key: String(i), text: st.label_pl || '' })).filter((x) => x.text && (!items[Number(x.key)].label_en || !items[Number(x.key)].label_ru));
      if (need.length) { const tr = await translateItems(need, 'podpis pod liczbą w sekcji statystyk studia web'); for (const it of need) { const st = items[Number(it.key)]; if (tr[it.key]?.en && !st.label_en) st.label_en = tr[it.key].en; if (tr[it.key]?.ru && !st.label_ru) st.label_ru = tr[it.key].ru; } }
    } catch {}
    upserts.push({ key: 'home_stats', value_meta: { items: items.filter((st) => st.auto || st.value) } });
    const { error } = await sb.from('site_settings').upsert(upserts, { onConflict: 'key' });
    if (error) throw error;
    state._stats = null;
    await loadSettings(); renderSettings(); renderStatsEditor();
    banner('Zapisano — na stronie po najbliższej przebudowie', 'ok');
  } catch (err) { console.error(err); banner(err.message || 'Błąd zapisu', 'error'); }
}
async function autoTranslateSettings(overwrite = false) {
  const keys = new Set(); $$('input[data-setting], textarea[data-setting]').forEach((el) => keys.add(el.dataset.setting));
  const items = [];
  for (const key of keys) {
    const get = (l) => document.querySelector(`[data-setting="${key}"][data-lang="${l}"]`);
    const pl = get('pl'), en = get('en'), ru = get('ru');
    if (!pl || !pl.value.trim()) continue;
    if (overwrite || !en?.value.trim() || !ru?.value.trim()) items.push({ key, text: pl.value.trim() });
  }
  if (!items.length) return 0;
  const tr = await translateItems(items, 'teksty strony głównej studia web-developmentu (hero, CTA, o studiu). Wielkie litery zachowaj tam, gdzie są.');
  let filled = 0;
  for (const it of items) {
    const t = tr[it.key]; if (!t) continue;
    const en = document.querySelector(`[data-setting="${it.key}"][data-lang="en"]`), ru = document.querySelector(`[data-setting="${it.key}"][data-lang="ru"]`);
    if (en && t.en && (overwrite || !en.value.trim())) { en.value = t.en; filled++; }
    if (ru && t.ru && (overwrite || !ru.value.trim())) { ru.value = t.ru; filled++; }
  }
  return filled;
}

// ── Blog (AI autopilot) ─────────────────────────────────────────────────────
state.blogPosts = []; state.blogKeywords = [];
async function loadBlog() {
  const [{ data: posts }, { data: kws }] = await Promise.all([
    sb.from('blog_posts').select('id,slug,title_pl,cover_path,status,published_at,keywords,tags').order('published_at', { ascending: false }).limit(300),
    sb.from('seo_keywords').select('day,keyword,picked,source').gte('day', new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)).order('day', { ascending: false }).order('picked', { ascending: false }).limit(160),
  ]);
  state.blogPosts = posts || []; state.blogKeywords = kws || [];
}
function blogConfig() { return { enabled: true, posts_min: 1, posts_max: 2, seed_keywords: [], ...(state.settings.blog_config?.value_meta || {}) }; }
function renderBlog() {
  $('#blog-count').textContent = state.blogPosts.length ? String(state.blogPosts.length) : '';
  const statusEl = $('#blog-agent-status');
  const st = state.settings.blog_agent_status?.value_meta;
  if (!st || !st.ts) { statusEl.textContent = 'Agent jeszcze nie raportował przebiegu.'; statusEl.classList.remove('is-err'); }
  else {
    const when = new Date(st.ts).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    if (st.ok) { statusEl.textContent = `Ostatni przebieg: ${when} — OK · ${st.note ? st.note : `wpisy: ${(st.published || []).length}/${st.planned ?? '?'}`}`; statusEl.classList.remove('is-err'); }
    else { statusEl.textContent = `⚠ Ostatni przebieg: ${when} — BŁĄD: ${(st.errors || []).join(' · ') || 'nieznany'} (alert poszedł na office@)`; statusEl.classList.add('is-err'); }
  }
  const cfg = blogConfig();
  $('#blog-enabled').value = String(!!cfg.enabled);
  const countSel = $('#blog-count-sel'); const v = `${cfg.posts_min}|${cfg.posts_max}`;
  countSel.value = [...countSel.options].some((o) => o.value === v) ? v : '1|2';
  const seeds = $('#blog-seeds'); if (document.activeElement !== seeds) seeds.value = (cfg.seed_keywords || []).join('\n');
  const kwWrap = $('#blog-keywords');
  if (!state.blogKeywords.length) kwWrap.innerHTML = '<span class="coords">Brak danych — agent loguje research przy każdym uruchomieniu.</span>';
  else {
    const days = {}; for (const k of state.blogKeywords) (days[k.day] ||= []).push(k);
    kwWrap.innerHTML = Object.entries(days).slice(0, 3).map(([day, items]) => `<div class="blog-kw-day"><span class="blog-kw-date">${escapeHtml(day)}</span><div class="blog-kw-chips">${items.slice(0, 40).map((k) => `<span class="conn-chip${k.picked ? ' is-on' : ''}" title="${escapeHtml(k.source || '')}">${escapeHtml(k.keyword)}</span>`).join('')}</div></div>`).join('');
  }
  $('#blog-kw-aside').textContent = 'ostatnie 7 dni · na ciemno = wybrane na wpis';
  const list = $('#blog-posts');
  $('#blog-posts-aside').textContent = state.blogPosts.length ? `${state.blogPosts.length} wpisów` : '';
  if (!state.blogPosts.length) { list.innerHTML = '<div class="empty-state">Jeszcze nie ma wpisów</div>'; return; }
  list.innerHTML = state.blogPosts.map((p) => `
    <div class="blog-row${p.status !== 'published' ? ' is-draft' : ''}" data-id="${p.id}">
      <div class="blog-row-thumb" style="${p.cover_path ? `background-image:url('${mediaUrl(p.cover_path)}')` : ''}"></div>
      <div class="blog-row-main">
        <div class="blog-row-title">${escapeHtml(p.title_pl)}</div>
        <div class="blog-row-meta">${new Date(p.published_at).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })} · /blog/${escapeHtml(p.slug)}/${p.status !== 'published' ? ' · <strong>ukryty</strong>' : ''}</div>
      </div>
      <div class="blog-row-actions">
        <a class="btn small" href="/blog/${encodeURIComponent(p.slug)}/" target="_blank" rel="noopener">Otwórz</a>
        <button class="btn small" data-blog-toggle="${p.id}">${p.status === 'published' ? 'Ukryj' : 'Pokaż'}</button>
        <button class="btn small danger" data-blog-delete="${p.id}">Usuń</button>
      </div>
    </div>`).join('');
}
async function saveBlogConfig() {
  banner('Zapisywanie…', null);
  try {
    const [min, max] = ($('#blog-count-sel').value || '1|2').split('|').map(Number);
    const seeds = $('#blog-seeds').value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 30);
    const value_meta = { ...(state.settings.blog_config?.value_meta || {}), enabled: $('#blog-enabled').value === 'true', posts_min: min || 1, posts_max: max || 2, seed_keywords: seeds };
    const { error } = await sb.from('site_settings').upsert({ key: 'blog_config', value_meta }, { onConflict: 'key' });
    if (error) throw error;
    await loadSettings(); banner('Zapisano — agent użyje ustawień przy następnym uruchomieniu', 'ok');
  } catch (err) { banner(err.message || 'Błąd zapisu', 'error'); }
}
async function toggleBlogPost(id) {
  const post = state.blogPosts.find((p) => p.id === id); if (!post) return;
  const next = post.status === 'published' ? 'draft' : 'published';
  const { error } = await sb.from('blog_posts').update({ status: next }).eq('id', id);
  if (error) { banner(error.message, 'error'); return; }
  post.status = next; renderBlog(); banner(next === 'draft' ? 'Ukryto (zniknie ze strony po przebudowie)' : 'Opublikowano ponownie', 'ok');
}
async function deleteBlogPost(id) {
  const post = state.blogPosts.find((p) => p.id === id); if (!post) return;
  if (!confirm(`Usunąć wpis "${post.title_pl}"? Tego nie da się cofnąć.`)) return;
  const { error } = await sb.from('blog_posts').delete().eq('id', id);
  if (error) { banner(error.message, 'error'); return; }
  if (post.cover_path) await sb.storage.from(MEDIA_BUCKET).remove([post.cover_path]).catch(() => {});
  state.blogPosts = state.blogPosts.filter((p) => p.id !== id); renderBlog(); banner('Usunięto', 'ok');
}
function bindBlogUI() {
  $('#blog-save-config')?.addEventListener('click', saveBlogConfig);
  $('#blog-posts')?.addEventListener('click', (e) => {
    const t = e.target.closest('[data-blog-toggle], [data-blog-delete]'); if (!t) return;
    if (t.dataset.blogToggle) toggleBlogPost(t.dataset.blogToggle); else if (t.dataset.blogDelete) deleteBlogPost(t.dataset.blogDelete);
  });
}

// ── Statystyki (first-party page views) ─────────────────────────────────────
state.pageViews = [];
async function loadStats() {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data, error } = await sb.from('page_views').select('path,referrer,is_session,is_mobile,created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(20000);
  if (error) { console.error(error); return; }
  state.pageViews = data || [];
}
function renderStats() {
  const cardsEl = $('#stats-cards'); if (!cardsEl) return;
  const now = Date.now();
  const bucket = (days) => { const from = now - days * 864e5; const rows = state.pageViews.filter((v) => new Date(v.created_at).getTime() >= from); return { views: rows.length, visits: rows.filter((v) => v.is_session).length }; };
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const todayRows = state.pageViews.filter((v) => new Date(v.created_at) >= midnight);
  const today = { views: todayRows.length, visits: todayRows.filter((v) => v.is_session).length };
  const card = (label, b) => `<div class="stat-card"><span class="stat-big">${b.visits}</span><span class="stat-sub">${label} · wizyty</span><span class="stat-sub">${b.views} odsłon</span></div>`;
  const mobile = state.pageViews.length ? Math.round(100 * state.pageViews.filter((v) => v.is_mobile).length / state.pageViews.length) : 0;
  cardsEl.innerHTML = card('Dziś', today) + card('7 dni', bucket(7)) + card('30 dni', bucket(30)) + `<div class="stat-card"><span class="stat-big">${mobile}%</span><span class="stat-sub">z telefonu · 30 dni</span></div>`;
  const agg = (keyFn) => { const m = new Map(); for (const v of state.pageViews) { const k = keyFn(v); if (!k) continue; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14); };
  const pages = agg((v) => v.path || '/');
  $('#stats-pages').innerHTML = pages.length ? pages.map(([p, n]) => `<div class="stats-row"><span class="path">${escapeHtml(p)}</span><span class="num">${n}</span></div>`).join('') : '<div class="empty-state">Jeszcze brak danych</div>';
  const refs = agg((v) => { if (!v.referrer) return '(bezpośrednio / brak)'; try { return new URL(v.referrer).hostname; } catch { return v.referrer.slice(0, 40); } });
  $('#stats-refs').innerHTML = refs.length ? refs.map(([r, n]) => `<div class="stats-row"><span class="path">${escapeHtml(r)}</span><span class="num">${n}</span></div>`).join('') : '<div class="empty-state">Jeszcze brak danych.</div>';
}

// expose for console debugging
window.__bf = { state, sb, openClient };
