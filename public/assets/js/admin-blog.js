// Admin → Blog (v2, 2026-11-16): autopilot status, generator settings
// (site_settings.blog_config), publication queue (scheduled posts), topic plan
// (blog_topics), estimator settings (site_settings.estimator_config) and the
// published list. Generator settings are read by the Mac Studio agent on its
// next run (every 3 h); estimator settings are baked into the static pages, so
// they go live after a rebuild (button here, or the next daily publication).
import { sb, $, state, banner, escapeHtml, mediaUrl, MEDIA_BUCKET, slugify, ask, swapList, markExit, invalid } from './admin-core.js?v=2026-11-20a';

// ── defaults (mirror blog-agent/blog-writer.ts and src/lib/estimate-model.ts) ─
const PILLARS = {
  koszty: 'Koszty i budżet', proces: 'Proces i współpraca', technologia: 'Technologia po ludzku', seo: 'SEO i widoczność w AI',
  konwersja: 'Konwersja i UX', ecommerce: 'E-commerce', branze: 'Strony dla branż', case: 'Case study realizacji', trendy: 'Trendy i AI',
};
const FORMATS = {
  przewodnik: 'Przewodnik', checklista: 'Checklista', porownanie: 'Porównanie', 'rozbicie-kosztow': 'Rozbicie kosztów',
  mity: 'Mity i fakty', bledy: 'Błędy', 'case-study': 'Case study', 'pytania-eksperta': 'Pytania do eksperta',
};
const GEN_DEFAULTS = {
  enabled: true, seed_keywords: [], buffer_days: 7, max_per_run: 2, words_min: 1300, words_max: 1900, inline_images: 2,
  langs: ['en', 'ru'], pillars: Object.fromEntries(Object.keys(PILLARS).map((k) => [k, 2])), formats: Object.fromEntries(Object.keys(FORMATS).map((k) => [k, true])),
  style_notes: '', photo_style: '', banned_phrases: [],
};
const TYPE_L = { landing: 'Landing page', site: 'Strona firmowa', shop: 'Sklep internetowy', platform: 'Platforma / aplikacja', redesign: 'Przebudowa strony' };
const TYPE_SERVICE = { site: 'strony-internetowe', shop: 'sklepy-internetowe', platform: 'platformy-i-aplikacje' };
const PAGE_L = { p1: '1–3 podstrony', p2: '4–8', p3: '9–15', p4: '16+' };
const FEAT_L = { cms: 'Panel CMS', blog: 'Blog', i18n: 'Wielojęzyczność', booking: 'Formularze / rezerwacje', payments: 'Płatności', integrations: 'Integracje', accounts: 'Konta klientów', motion: 'Animacje / 3D' };
const EST_DEFAULTS = {
  enabled: true,
  ai: { enabled: true, per_ip_hour: 8, per_day: 300 },
  types: [{ id: 'landing', add: 2500, weeks: 1.5 }, { id: 'site', add: 3500, weeks: 2 }, { id: 'shop', add: 8000, weeks: 3 }, { id: 'platform', add: 15000, weeks: 4 }, { id: 'redesign', add: 3000, weeks: 2 }],
  pages: [{ id: 'p1', add: 0, weeks: 0 }, { id: 'p2', add: 1500, weeks: 0.25, mult: { shop: 1.5, platform: 2 } }, { id: 'p3', add: 3500, weeks: 0.75, mult: { shop: 1.5, platform: 2 } }, { id: 'p4', add: 6000, weeks: 1.5, mult: { shop: 1.5, platform: 2 } }],
  features: [
    { id: 'cms', add: 1000, weeks: 0.25, included: ['shop', 'platform'] }, { id: 'blog', add: 800, weeks: 0.15 }, { id: 'i18n', add: 1500, weeks: 0.25 },
    { id: 'booking', add: 1500, weeks: 0.25 }, { id: 'payments', add: 2000, weeks: 0.25, included: ['shop'] }, { id: 'integrations', add: 3000, weeks: 0.5 },
    { id: 'accounts', add: 2500, weeks: 0.5, included: ['platform'] }, { id: 'motion', add: 2500, weeks: 0.25 },
  ],
  content: [{ id: 'ready', add: 0, weeks: 0 }, { id: 'help', add: 1500, weeks: 0.25 }],
  start: [{ id: 'asap', add: 0, weeks: 0, mult: 1.15 }, { id: 'month', add: 0, weeks: 0 }, { id: 'later', add: 0, weeks: 0 }],
  range: [0.9, 1.25],
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const num = (v, d = 0) => { const n = Number(String(v).replace(',', '.').replace(/\s/g, '')); return Number.isFinite(n) ? n : d; };
const fmtPln = (n) => Math.round(n).toLocaleString('pl-PL');

function genConfig() {
  const c = { ...clone(GEN_DEFAULTS), ...(state.settings.blog_config?.value_meta || {}) };
  c.pillars = { ...GEN_DEFAULTS.pillars, ...(c.pillars || {}) };
  c.formats = { ...GEN_DEFAULTS.formats, ...(c.formats || {}) };
  return c;
}
function estConfig() {
  const o = state.settings.estimator_config?.value_meta || {};
  const c = clone(EST_DEFAULTS);
  for (const k of Object.keys(o)) if (o[k] !== undefined) c[k] = o[k];
  c.ai = { ...EST_DEFAULTS.ai, ...(o.ai || {}) };
  // Keep every option present even if an old saved config lacks it.
  for (const k of ['types', 'pages', 'features', 'content', 'start']) {
    const byId = Object.fromEntries((c[k] || []).map((x) => [x.id, x]));
    c[k] = EST_DEFAULTS[k].map((d) => ({ ...clone(d), ...(byId[d.id] || {}) }));
  }
  return c;
}
const servicePrice = (slug) => {
  const s = (state.services || []).find((x) => x.slug === slug);
  const m = String(s?.price_from || '').replace(/\s| /g, '').match(/\d+/);
  return m ? Number(m[0]) : null;
};

// ── data ────────────────────────────────────────────────────────────────────
state.blogPosts = []; state.blogTopics = []; state.aiUsage = [];
export async function loadBlog() {
  const [{ data: posts, error }, { data: topics }, { data: usage }] = await Promise.all([
    sb.from('blog_posts').select('id,slug,title_pl,cover_path,status,published_at,scheduled_for,pillar,format,body_en,body_ru').neq('status', 'archived').order('published_at', { ascending: false }).limit(1000),
    sb.from('blog_topics').select('id,title,slug,pillar,format,angle,priority,source,status,created_at').in('status', ['queued', 'writing']).order('priority', { ascending: false }).order('created_at').limit(200),
    sb.from('ai_usage').select('feature,cost_usd,ts').gte('ts', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()).limit(5000),
  ]);
  if (error) { console.error(error); banner(`Nie udało się wczytać bloga: ${error.message}`, 'error'); return; }
  state.blogPosts = posts || []; state.blogTopics = topics || []; state.aiUsage = usage || [];
}

const fmtWhen = (iso) => new Date(iso).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDay = (iso) => new Date(iso).toLocaleDateString('pl-PL', { weekday: 'short', day: 'numeric', month: 'short' });
const thumb = (p) => p ? (/^https:\/\/images\.unsplash\.com\//.test(p) ? `${p}&w=160&h=100&fit=crop&auto=format&q=60` : mediaUrl(p)) : '';
const scheduledPosts = () => state.blogPosts.filter((p) => p.status === 'scheduled').sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)));

// ── render ──────────────────────────────────────────────────────────────────
const FEATURE_L = { 'blog-write': 'Blog — pisanie', 'blog-translate': 'Blog — tłumaczenia', 'blog-plan': 'Blog — plan tematów', 'blog-repair': 'Blog — poprawki', 'blog-photos': 'Blog — zdjęcia (stare wpisy)', 'photo-pick': 'Wybór zdjęć', 'leads-compose': 'Leady — oferty', 'leads-score': 'Leady — ocena', estimate: 'Kalkulator — komentarz AI' };
function renderBudget() {
  const box = $('#ai-budget'); if (!box || box.contains(document.activeElement)) return;
  const cap = Number(state.settings.ai_budget?.value_meta?.monthly_usd) || 15;
  const rows = state.aiUsage.filter((r) => !String(r.feature).startsWith('setup'));
  const setup = state.aiUsage.filter((r) => String(r.feature).startsWith('setup')).reduce((a, r) => a + Number(r.cost_usd), 0);
  const spent = rows.reduce((a, r) => a + Number(r.cost_usd), 0);
  const day = new Date().getDate(), days = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const proj = day > 2 ? (spent / day) * days : null;
  const by = {}; for (const r of rows) by[r.feature] = (by[r.feature] || 0) + Number(r.cost_usd);
  const pct = Math.min(100, (spent / cap) * 100);
  box.innerHTML = `
    <div class="ai-meter"><span style="width:${pct}%" class="${pct > 90 ? 'is-hot' : ''}"></span></div>
    <div class="coords">Ten miesiąc: <b>$${spent.toFixed(2)}</b> z $${cap}${proj ? ` · prognoza na koniec miesiąca ≈ $${proj.toFixed(2)}` : ''}${setup ? ` · jednorazowe wdrożenie $${setup.toFixed(2)} (poza limitem)` : ''}</div>
    <div class="coords">${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${escapeHtml(FEATURE_L[k] || k)}: $${v.toFixed(2)}`).join(' · ') || 'brak wywołań w tym miesiącu'}</div>
    <div class="button-row"><label class="field-label" for="ai-cap">Limit miesięczny ($)</label><input id="ai-cap" type="number" min="1" max="200" step="1" value="${cap}" style="max-width:110px" /><span class="coords">Po przekroczeniu: blog publikuje z bufora (nie pisze nowych), leady i komentarz AI w kalkulatorze czekają do 1. dnia miesiąca.</span><span class="spread"></span><button class="btn" data-act="save-budget">Zapisz limit</button></div>`;
}
async function saveBudget() {
  const v = Math.min(Math.max(Math.round(Number($('#ai-cap').value) || 15), 1), 200);
  banner('Zapisywanie limitu…', null);
  const { error } = await sb.from('site_settings').upsert({ key: 'ai_budget', value_meta: { monthly_usd: v } }, { onConflict: 'key' });
  if (error) { banner(error.message, 'error'); return; }
  state.settings.ai_budget = { key: 'ai_budget', value_meta: { monthly_usd: v } }; renderBudget(); banner(`Limit: $${v} / miesiąc`, 'ok');
}

export function renderBlog() {
  const published = state.blogPosts.filter((p) => p.status === 'published' || p.status === 'draft');
  const scheduled = scheduledPosts();
  $('#blog-count').textContent = published.length ? String(published.length) : '';
  renderBudget();
  renderGenForm();
  renderStatus(scheduled);
  renderQueue(scheduled);
  renderTopics();
  renderEstForm();
  renderPublished(published);
}

function renderStatus(scheduled) {
  const st = state.settings.blog_agent_status?.value_meta;
  const el = $('#blog-agent-status');
  if (!st || !st.ts) { el.textContent = 'Generator jeszcze nie raportował.'; el.classList.remove('is-err'); }
  else {
    const gen = (st.generated || []).length ? `napisano: ${st.generated.length}` : 'bez nowych wpisów (bufor pełny)';
    el.textContent = `${st.ok ? '✓' : '⚠'} Generator: ${fmtWhen(st.ts)} — ${gen} · bufor ${st.buffer ?? '?'} · tematów w planie ${st.queue ?? '?'}${(st.errors || []).length ? ' · ' + st.errors.join(' · ') : ''}`;
    el.classList.toggle('is-err', !st.ok);
  }
  const wd = state.settings.blog_watchdog_status?.value_meta;
  const wdEl = $('#blog-watchdog-status');
  if (!wd || !wd.ts) { wdEl.textContent = 'Strażnik publikacji jeszcze nie sprawdzał (codziennie 7:40 i 10:30).'; wdEl.classList.remove('is-err'); }
  else {
    wdEl.textContent = `${wd.ok ? '✓' : '⚠'} Strażnik: ${fmtWhen(wd.ts)} — ${wd.published_today ? `dziś: /blog/${wd.published_today}/ ${wd.live ? 'działa na żywo' : 'jeszcze niewidoczny'}` : 'dziś brak publikacji'}${(wd.problems || []).length ? ' · ' + wd.problems.join(' · ') : ''}`;
    wdEl.classList.toggle('is-err', !wd.ok);
  }
  const future = scheduled.filter((p) => new Date(p.scheduled_for) > new Date());
  $('#blog-buffer-info').textContent = future.length ? `${future.length} gotowych wpisów — do ${fmtDay(future[future.length - 1].scheduled_for)}` : 'pusty — generator dopisze przy najbliższym przebiegu';
}

function renderGenForm() {
  const box = $('#blog-gen-form');
  if (box.contains(document.activeElement)) return; // don't clobber while typing
  const c = genConfig();
  const opt = (v, cur, label) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${label}</option>`;
  box.innerHTML = `
    <div class="row-2">
      <div class="field"><label class="field-label">Publikowanie</label><select data-g="enabled">${opt('true', c.enabled, 'Włączone — 1 wpis dziennie o 7:00')}${opt('false', c.enabled, 'Wstrzymane (generator nie pisze, kolejka stoi)')}</select></div>
      <div class="field"><label class="field-label">Bufor gotowych wpisów</label><div class="coords" id="blog-buffer-info">—</div></div>
    </div>
    <div class="row-3">
      <div class="field"><label class="field-label">Bufor (dni naprzód)</label><input type="number" min="2" max="21" data-g="buffer_days" value="${c.buffer_days}" /></div>
      <div class="field"><label class="field-label">Max wpisów na przebieg (co 3 h)</label><input type="number" min="1" max="4" data-g="max_per_run" value="${c.max_per_run}" /></div>
      <div class="field"><label class="field-label">Zdjęć w treści</label><select data-g="inline_images">${[0, 1, 2, 3].map((n) => opt(n, c.inline_images, String(n))).join('')}</select></div>
    </div>
    <div class="row-3">
      <div class="field"><label class="field-label">Długość od (słów)</label><input type="number" min="600" max="4000" step="100" data-g="words_min" value="${c.words_min}" /></div>
      <div class="field"><label class="field-label">Długość do (słów)</label><input type="number" min="800" max="5000" step="100" data-g="words_max" value="${c.words_max}" /></div>
      <div class="field"><label class="field-label">Tłumaczenia</label><div class="button-row"><label class="check"><input type="checkbox" data-lang="en"${c.langs.includes('en') ? ' checked' : ''} /> EN</label><label class="check"><input type="checkbox" data-lang="ru"${c.langs.includes('ru') ? ' checked' : ''} /> RU</label></div></div>
    </div>
    <div class="field"><label class="field-label">Filary tematyczne — jak często</label>
      <div class="blog-weights">${Object.entries(PILLARS).map(([k, l]) => `<label class="blog-weight"><span>${escapeHtml(l)}</span><select data-pillar="${k}">${opt(0, c.pillars[k], 'wył.')}${opt(1, c.pillars[k], 'rzadko')}${opt(2, c.pillars[k], 'normalnie')}${opt(3, c.pillars[k], 'często')}</select></label>`).join('')}</div>
    </div>
    <div class="field"><label class="field-label">Formaty wpisów</label>
      <div class="conn-chips">${Object.entries(FORMATS).map(([k, l]) => `<button type="button" class="conn-chip${c.formats[k] ? ' is-on' : ''}" data-format="${k}"><span class="chip-dot"></span>${escapeHtml(l)}</button>`).join('')}</div>
    </div>
    <div class="field"><label class="field-label">Własne tematy (po jednym w linii — trafiają na początek planu)</label><textarea data-g="seed_keywords" rows="3" placeholder="np. strona internetowa dla warsztatu samochodowego">${escapeHtml((c.seed_keywords || []).join('\n'))}</textarea></div>
    <div class="field"><label class="field-label">Dodatkowe wskazówki do stylu tekstów</label><textarea data-g="style_notes" rows="3" placeholder="np. więcej przykładów z branży motoryzacyjnej; zawsze wspominaj o opiece po wdrożeniu; mniej technicznego żargonu">${escapeHtml(c.style_notes || '')}</textarea></div>
    <div class="field"><label class="field-label">Styl zdjęć (Unsplash)</label><textarea data-g="photo_style" rows="2" placeholder="np. ciepłe światło, architektura i detale, bez ludzi patrzących w obiektyw">${escapeHtml(c.photo_style || '')}</textarea></div>
    <div class="field"><label class="field-label">Zakazane frazy (po jednej w linii)</label><textarea data-g="banned_phrases" rows="2" placeholder="np. kompleksowe rozwiązania">${escapeHtml((c.banned_phrases || []).join('\n'))}</textarea></div>
    <div class="button-row"><span class="coords">Generator czyta ustawienia przy każdym przebiegu (co 3 h). Publikacja zawsze 1 wpis dziennie.</span><span class="spread"></span><button class="btn primary" data-act="save-gen">Zapisz ustawienia generatora</button></div>`;
}

function renderQueue(scheduled) {
  $('#blog-sched-aside').textContent = scheduled.length ? `${scheduled.length} w kolejce` : '';
  swapList($('#blog-scheduled'), scheduled.length ? scheduled.map((p, i) => `
    <div class="blog-row" data-id="${p.id}">
      <div class="blog-row-thumb" style="${p.cover_path ? `background-image:url('${thumb(p.cover_path)}')` : ''}"></div>
      <div class="blog-row-main">
        <div class="blog-row-title">${escapeHtml(p.title_pl)}</div>
        <div class="blog-row-meta"><strong>${escapeHtml(fmtDay(p.scheduled_for))}</strong> · ${escapeHtml(PILLARS[p.pillar] || p.pillar || '')} / ${escapeHtml(FORMATS[p.format] || p.format || '')}${p.cover_path ? '' : ' · <strong>bez zdjęć</strong>'}${p.body_en && p.body_ru ? '' : ' · <strong>brak tłumaczenia</strong>'}</div>
      </div>
      <div class="blog-row-actions">
        ${i > 0 ? `<button class="btn small" data-act="up" data-id="${p.id}" title="Zamień z poprzednim">↑ Wyżej</button>` : ''}
        <button class="btn small" data-act="publish-now" data-id="${p.id}">Opublikuj teraz</button>
        <button class="btn small danger" data-act="delete" data-id="${p.id}">Usuń</button>
      </div>
    </div>`).join('') : '<div class="empty-state">Kolejka pusta</div>', '.blog-row[data-id]');
}

function renderTopics() {
  $('#blog-topics-aside').textContent = state.blogTopics.length ? `${state.blogTopics.length} tematów` : '';
  swapList($('#blog-topics'), state.blogTopics.length ? state.blogTopics.map((t) => `
    <div class="blog-row is-topic" data-topic="${t.id}">
      <div class="blog-row-main">
        <div class="blog-row-title">${t.priority > 0 ? '★ ' : ''}${escapeHtml(t.title)}</div>
        <div class="blog-row-meta">${escapeHtml(PILLARS[t.pillar] || t.pillar || 'własny')} / ${escapeHtml(FORMATS[t.format] || t.format || 'dowolny')}${t.status === 'writing' ? ' · <strong>w trakcie pisania</strong>' : ''}${t.angle ? ' · ' + escapeHtml(t.angle) : ''}</div>
      </div>
      <div class="blog-row-actions">
        <button class="btn small" data-act="prio" data-id="${t.id}">${t.priority > 0 ? '☆ Zwykły' : '★ Następny'}</button>
        <button class="btn small" data-act="reject" data-id="${t.id}">Odrzuć</button>
      </div>
    </div>`).join('') : '<div class="empty-state">Planer uzupełni tematy przy najbliższym przebiegu</div>', '[data-topic]');
}

function renderEstForm() {
  const box = $('#est-form');
  if (box.contains(document.activeElement)) return;
  const c = estConfig();
  const opt = (v, cur, label) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${label}</option>`;
  const n = (path, v, step = 100) => `<input type="number" step="${step}" data-e="${path}" value="${v ?? 0}" />`;
  const typeRows = c.types.map((t, i) => {
    const svc = TYPE_SERVICE[t.id];
    const sp = svc ? servicePrice(svc) : null;
    return `<tr><td>${TYPE_L[t.id]}</td><td>${svc ? `<span class="coords">${sp ? `${fmtPln(sp)} zł` : '—'} · z cennika usług</span>` : n(`types.${i}.add`, t.add)}</td><td>${n(`types.${i}.weeks`, t.weeks, 0.25)}</td><td></td><td></td></tr>`;
  }).join('');
  const pageRows = c.pages.map((p, i) => `<tr><td>${PAGE_L[p.id]}</td><td>${n(`pages.${i}.add`, p.add)}</td><td>${n(`pages.${i}.weeks`, p.weeks, 0.25)}</td><td>${p.id === 'p1' ? '' : n(`pages.${i}.mult.shop`, p.mult?.shop ?? 1, 0.1)}</td><td>${p.id === 'p1' ? '' : n(`pages.${i}.mult.platform`, p.mult?.platform ?? 1, 0.1)}</td></tr>`).join('');
  const featRows = c.features.map((f, i) => `<tr><td>${FEAT_L[f.id]}</td><td>${n(`features.${i}.add`, f.add)}</td><td>${n(`features.${i}.weeks`, f.weeks, 0.05)}</td><td colspan="2"><div class="est-incl">${Object.entries(TYPE_L).map(([tid, tl]) => `<label class="check"><input type="checkbox" data-incl="${i}" value="${tid}"${(f.included || []).includes(tid) ? ' checked' : ''} />${escapeHtml(tl.split(' ')[0])}</label>`).join('')}</div></td></tr>`).join('');
  const help = c.content.findIndex((x) => x.id === 'help');
  const asap = c.start.findIndex((x) => x.id === 'asap');
  box.innerHTML = `
    <div class="row-3">
      <div class="field"><label class="field-label">Kalkulator we wpisach</label><select data-e="enabled" data-bool>${opt('true', c.enabled, 'Pokazuj')}${opt('false', c.enabled, 'Ukryj')}</select></div>
      <div class="field"><label class="field-label">Komentarz AI do briefu</label><select data-e="ai.enabled" data-bool>${opt('true', c.ai.enabled, 'Włączony (Claude)')}${opt('false', c.ai.enabled, 'Wyłączony (szablon)')}</select></div>
      <div class="field"><label class="field-label">Limit AI: na osobę / h · na dzień</label><div class="row-2">${n('ai.per_ip_hour', c.ai.per_ip_hour, 1)}${n('ai.per_day', c.ai.per_day, 10)}</div></div>
    </div>
    <div class="row-3">
      <div class="field"><label class="field-label">Widełki: dół × · góra ×</label><div class="row-2">${n('range.0', c.range[0], 0.05)}${n('range.1', c.range[1], 0.05)}</div></div>
      <div class="field"><label class="field-label">„Jak najszybciej” — mnożnik ceny</label>${n(`start.${asap}.mult`, c.start[asap].mult ?? 1, 0.05)}</div>
      <div class="field"><label class="field-label">Pomoc z treściami: zł · tyg.</label><div class="row-2">${n(`content.${help}.add`, c.content[help].add)}${n(`content.${help}.weeks`, c.content[help].weeks, 0.25)}</div></div>
    </div>
    <div class="est-table-wrap"><table class="est-table">
      <thead><tr><th>Opcja</th><th>Cena / dopłata (zł netto)</th><th>Tygodnie</th><th>× sklep</th><th>× platforma</th></tr></thead>
      <tbody>
        <tr class="est-group"><td colspan="5">Typ projektu (cena bazowa · czas bazowy)</td></tr>${typeRows}
        <tr class="est-group"><td colspan="5">Liczba podstron (dopłata · czas · mnożnik dla sklepu/platformy)</td></tr>${pageRows}
        <tr class="est-group"><td colspan="5">Funkcje (dopłata · czas · „w cenie” dla typów)</td></tr>${featRows}
      </tbody>
    </table></div>
    <div class="blog-agent-status" id="est-preview"></div>
    <div class="button-row"><span class="coords">Ceny stron, sklepów i platform bierze z zakładki Usługi. Czas wyświetla się jako „X–X+1 tyg.” (zaokrąglenie w dół).</span><span class="spread"></span><button class="btn" data-act="est-reset">Przywróć domyślne</button><button class="btn primary" data-act="save-est">Zapisz kalkulator</button></div>`;
  updateEstPreview();
}

function readEstForm() {
  const c = estConfig();
  const box = $('#est-form');
  box.querySelectorAll('[data-e]').forEach((el) => {
    const path = el.dataset.e.split('.');
    let o = c;
    for (let i = 0; i < path.length - 1; i++) { const k = path[i]; o[k] ??= /^\d+$/.test(path[i + 1]) ? [] : {}; o = o[k]; }
    const last = path[path.length - 1];
    o[last] = el.hasAttribute('data-bool') ? el.value === 'true' : num(el.value, 0);
  });
  c.features.forEach((f, i) => { f.included = [...box.querySelectorAll(`[data-incl="${i}"]:checked`)].map((x) => x.value); });
  // sanity
  c.range = [Math.min(Math.max(c.range[0], 0.5), 1), Math.min(Math.max(c.range[1], 1), 2)];
  c.ai.per_ip_hour = Math.max(0, Math.round(c.ai.per_ip_hour)); c.ai.per_day = Math.max(0, Math.round(c.ai.per_day));
  return c;
}

// Same math as src/lib/estimate-model.ts, for the live example.
function sample(c, brief) {
  const type = { ...c.types.find((t) => t.id === brief.type) };
  const sp = TYPE_SERVICE[type.id] && servicePrice(TYPE_SERVICE[type.id]); if (sp) type.add = sp;
  const pages = c.pages.find((p) => p.id === brief.pages);
  let total = type.add + Math.round(pages.add * (pages.mult?.[type.id] ?? 1));
  let weeks = type.weeks + pages.weeks;
  for (const id of brief.features) { const f = c.features.find((x) => x.id === id); if (f && !(f.included || []).includes(type.id)) { total += f.add; weeks += f.weeks; } }
  const r = (x) => Math.max(500, Math.round(x / 500) * 500);
  const w = Math.max(1, Math.floor(weeks));
  return `${fmtPln(r(total * c.range[0]))}–${fmtPln(r(total * c.range[1]))} zł · ${w}–${w + 1} tyg.`;
}
function updateEstPreview() {
  const el = $('#est-preview'); if (!el) return;
  const c = readEstForm();
  el.innerHTML = `Podgląd: <b>Landing</b> ${sample(c, { type: 'landing', pages: 'p1', features: [] })} · <b>Strona firmowa</b> 4–8 podstron + CMS + formularze ${sample(c, { type: 'site', pages: 'p2', features: ['cms', 'booking'] })} · <b>Sklep</b> 9–15 + integracje ${sample(c, { type: 'shop', pages: 'p3', features: ['cms', 'payments', 'integrations'] })} · <b>Platforma</b> 4–8 + konta ${sample(c, { type: 'platform', pages: 'p2', features: ['accounts', 'integrations'] })}`;
}

function renderPublished(published) {
  const list = $('#blog-posts');
  $('#blog-posts-aside').textContent = published.length ? `${published.length} wpisów` : '';
  swapList(list, !published.length ? '<div class="empty-state">Jeszcze nie ma wpisów</div>' : published.map((p) => `
    <div class="blog-row${p.status !== 'published' ? ' is-draft' : ''}" data-id="${p.id}">
      <div class="blog-row-thumb" style="${p.cover_path ? `background-image:url('${thumb(p.cover_path)}')` : ''}"></div>
      <div class="blog-row-main">
        <div class="blog-row-title">${escapeHtml(p.title_pl)}</div>
        <div class="blog-row-meta">${new Date(p.published_at).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })} · /blog/${escapeHtml(p.slug)}/${p.status !== 'published' ? ' · <strong>ukryty</strong>' : ''}</div>
      </div>
      <div class="blog-row-actions">
        <a class="btn small" href="/blog/${encodeURIComponent(p.slug)}/" target="_blank" rel="noopener">Otwórz</a>
        <button class="btn small" data-act="toggle" data-id="${p.id}">${p.status === 'published' ? 'Ukryj' : 'Pokaż'}</button>
        <button class="btn small danger" data-act="delete" data-id="${p.id}">Usuń</button>
      </div>
    </div>`).join(''), '.blog-row[data-id]');
}

// ── actions ─────────────────────────────────────────────────────────────────
async function upsertSetting(key, value_meta) {
  const { error } = await sb.from('site_settings').upsert({ key, value_meta }, { onConflict: 'key' });
  if (error) throw error;
  state.settings[key] = { ...(state.settings[key] || { key }), value_meta };
}

async function saveGen() {
  banner('Zapisywanie…', null);
  try {
    const box = $('#blog-gen-form');
    const g = (k) => box.querySelector(`[data-g="${k}"]`);
    const lines = (k) => g(k).value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 40);
    const prev = genConfig();
    const words_min = Math.min(Math.max(num(g('words_min').value, 1300), 600), 4000);
    const value_meta = {
      ...(state.settings.blog_config?.value_meta || {}),
      enabled: g('enabled').value === 'true',
      buffer_days: Math.min(Math.max(Math.round(num(g('buffer_days').value, 7)), 2), 21),
      max_per_run: Math.min(Math.max(Math.round(num(g('max_per_run').value, 2)), 1), 4),
      inline_images: Math.min(Math.max(Math.round(num(g('inline_images').value, 2)), 0), 3),
      words_min, words_max: Math.max(words_min + 200, Math.min(num(g('words_max').value, 1900), 5000)),
      langs: [...box.querySelectorAll('[data-lang]:checked')].map((x) => x.dataset.lang),
      pillars: Object.fromEntries([...box.querySelectorAll('[data-pillar]')].map((s) => [s.dataset.pillar, Number(s.value)])),
      formats: Object.fromEntries([...box.querySelectorAll('[data-format]')].map((b) => [b.dataset.format, b.classList.contains('is-on')])),
      seed_keywords: lines('seed_keywords'), style_notes: g('style_notes').value.trim().slice(0, 2000), photo_style: g('photo_style').value.trim().slice(0, 600),
      banned_phrases: lines('banned_phrases'),
    };
    if (!Object.values(value_meta.pillars).some((w) => w > 0)) throw new Error('Włącz przynajmniej jeden filar');
    if (!Object.values(value_meta.formats).some(Boolean)) throw new Error('Włącz przynajmniej jeden format');
    await upsertSetting('blog_config', value_meta);
    // Own topics go straight to the plan with top priority.
    const known = new Set([...state.blogTopics.map((t) => t.title.toLowerCase()), ...(prev.seed_keywords || []).map((s) => s.toLowerCase())]);
    const rows = value_meta.seed_keywords.filter((s) => !known.has(s.toLowerCase())).map((s) => ({ title: s, slug: slugify(s).slice(0, 72) || `temat-${Date.now()}`, primary_keyword: s.toLowerCase(), source: 'admin', priority: 10 }));
    if (rows.length) { const { error } = await sb.from('blog_topics').upsert(rows, { onConflict: 'slug', ignoreDuplicates: true }); if (error) throw error; }
    await loadBlog(); renderBlog();
    banner(`Zapisano${rows.length ? ` · +${rows.length} własnych tematów w planie` : ''} — generator użyje ustawień przy następnym przebiegu`, 'ok');
  } catch (err) { banner(err.message || 'Błąd zapisu', 'error'); }
}

async function saveEst(reset = false) {
  banner('Zapisywanie…', null);
  try {
    const c = reset ? clone(EST_DEFAULTS) : readEstForm();
    await upsertSetting('estimator_config', c);
    renderEstForm();
    banner('Kalkulator zapisany — zmiany pojawią się na stronie po przebudowie', 'ok');
    $('#blog-rebuild-hint').hidden = false;
  } catch (err) { banner(err.message || 'Błąd zapisu', 'error'); }
}

async function rebuild() {
  banner('Uruchamiam przebudowę…', null);
  const { data, error } = await sb.rpc('site_rebuild', { p_reason: 'admin' });
  if (error || !data?.ok) { banner(error?.message || data?.error || 'Błąd', 'error'); return; }
  $('#blog-rebuild-hint').hidden = true;
  banner('Przebudowa ruszyła — strona odświeży się za ok. 3–5 min', 'ok');
}

const rowEl = (id) => document.querySelector(`.blog-row[data-id="${id}"]`);

async function publishNow(id) {
  const post = state.blogPosts.find((p) => p.id === id); if (!post) return;
  if (!(await ask(`Opublikować teraz „${post.title_pl}”?\nPoza codziennym rytmem — kolejka się przesunie.`))) return;
  banner('Publikuję…', null);
  const { data, error } = await sb.rpc('blog_publish_now', { p_id: id });
  if (error || !data?.ok) { banner(error?.message || data?.error || 'Błąd', 'error'); return; }
  markExit(rowEl(id), 'send'); await loadBlog(); renderBlog(); banner('Opublikowano — strona przebuduje się za ok. 3–5 min', 'ok');
}

async function moveUp(id) {
  const q = scheduledPosts(); const i = q.findIndex((p) => p.id === id); if (i <= 0) return;
  const a = q[i], b = q[i - 1];
  const r1 = await sb.from('blog_posts').update({ scheduled_for: b.scheduled_for, published_at: b.scheduled_for }).eq('id', a.id);
  const r2 = await sb.from('blog_posts').update({ scheduled_for: a.scheduled_for, published_at: a.scheduled_for }).eq('id', b.id);
  if (r1.error || r2.error) { banner((r1.error || r2.error).message, 'error'); return; }
  [a.scheduled_for, b.scheduled_for] = [b.scheduled_for, a.scheduled_for];
  renderBlog(); banner('Kolejność zmieniona', 'ok');
}

async function togglePost(id) {
  const post = state.blogPosts.find((p) => p.id === id); if (!post) return;
  const next = post.status === 'published' ? 'draft' : 'published';
  const { error } = await sb.from('blog_posts').update({ status: next }).eq('id', id);
  if (error) { banner(error.message, 'error'); return; }
  post.status = next; renderBlog(); banner(next === 'draft' ? 'Ukryto (zniknie ze strony po przebudowie)' : 'Opublikowano ponownie', 'ok');
}

async function deletePost(id) {
  const post = state.blogPosts.find((p) => p.id === id); if (!post) return;
  if (!(await ask(`Usunąć wpis „${post.title_pl}”?\nTego nie da się cofnąć.`))) return;
  banner('Usuwanie…', null);
  const { error } = await sb.from('blog_posts').delete().eq('id', id);
  if (error) { banner(error.message, 'error'); return; }
  if (post.cover_path && !/^https?:/.test(post.cover_path)) await sb.storage.from(MEDIA_BUCKET).remove([post.cover_path]).catch(() => {});
  state.blogPosts = state.blogPosts.filter((p) => p.id !== id); renderBlog(); banner('Wpis usunięty', 'ok');
}

async function topicPrio(id) {
  const t = state.blogTopics.find((x) => x.id === id); if (!t) return;
  const priority = t.priority > 0 ? 0 : 20;
  const { error } = await sb.from('blog_topics').update({ priority }).eq('id', id);
  if (error) { banner(error.message, 'error'); return; }
  t.priority = priority; state.blogTopics.sort((a, b) => b.priority - a.priority); renderTopics();
  banner(priority ? 'Ten temat będzie napisany jako następny' : 'Zwykły priorytet', 'ok');
}
async function topicReject(id) {
  const { error } = await sb.from('blog_topics').update({ status: 'rejected' }).eq('id', id);
  if (error) { banner(error.message, 'error'); return; }
  markExit(document.querySelector(`[data-topic="${id}"]`), 'skip');
  state.blogTopics = state.blogTopics.filter((t) => t.id !== id); renderTopics(); banner('Temat odrzucony', 'ok');
}
async function addTopic() {
  const inp = $('#blog-topic-new'); const title = inp.value.trim(); if (!title) { invalid(inp); banner('Wpisz temat', 'error'); return; }
  const { data, error } = await sb.from('blog_topics').insert({ title, slug: slugify(title).slice(0, 72), primary_keyword: title.toLowerCase(), source: 'admin', priority: 10 }).select().single();
  if (error) { banner(/duplicate/.test(error.message) ? 'Taki temat już jest w planie' : error.message, 'error'); return; }
  state.blogTopics.unshift(data); inp.value = ''; renderTopics(); banner('Dodano na początek planu', 'ok');
}

export function bindBlogUI() {
  const panel = $('[data-panel="blog"]'); if (!panel) return;
  panel.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-format]'); if (chip) { chip.classList.toggle('is-on'); return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = b.dataset.id;
    ({
      'save-gen': saveGen, 'save-budget': saveBudget, 'save-est': () => saveEst(false), 'est-reset': async () => (await ask('Przywrócić domyślne ceny i czasy kalkulatora?\nTwoje obecne wartości zostaną nadpisane.')) && saveEst(true),
      rebuild, 'publish-now': () => publishNow(id), up: () => moveUp(id), toggle: () => togglePost(id), delete: () => deletePost(id),
      prio: () => topicPrio(id), reject: () => topicReject(id), 'add-topic': addTopic,
    })[b.dataset.act]?.();
  });
  panel.addEventListener('input', (e) => { if (e.target.closest('#est-form')) updateEstPreview(); });
  panel.addEventListener('change', (e) => { if (e.target.closest('#est-form')) updateEstPreview(); });
  $('#blog-topic-new')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTopic(); } });
}
