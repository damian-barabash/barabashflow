// Shared admin plumbing: Supabase client, tiny DOM helpers, toast banner,
// storage upload (WebP downscale), AI translation, HTML escaping, dates.
// Every admin module imports from here; nothing here imports the modules.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { SUPABASE_URL, SUPABASE_ANON_KEY, MEDIA_BUCKET, mediaUrl } from './supabase-config.js?v=2026-09-12a';

export { SUPABASE_URL, SUPABASE_ANON_KEY, MEDIA_BUCKET, mediaUrl };

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'bf-admin-auth' },
});

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const LANGS = ['pl', 'en', 'ru'];

// Cross-module state (each module owns its own slice).
export const state = {
  user: null,
  settings: {},
  services: [],
  projects: [],
  photosByProject: new Map(),
};

let bannerTimer;
export function banner(text, kind) {
  const el = $('#banner');
  if (!el) return;
  el.textContent = text;
  el.className = 'banner is-shown ' + (kind || '');
  clearTimeout(bannerTimer);
  if (kind === 'ok' || kind === 'error') bannerTimer = setTimeout(() => el.classList.remove('is-shown'), 2600);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const attr = (s) => escapeHtml(s ?? '');

export function fmtDate(iso, withTime = true) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('pl-PL', withTime ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'medium' }); }
  catch { return iso; }
}
export function relDays(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((d - t) / 864e5);
}
export function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[ąàáâä]/g, 'a').replace(/[ćç]/g, 'c').replace(/[ęèéêë]/g, 'e').replace(/[łl]/g, 'l').replace(/[ńñ]/g, 'n').replace(/[óòôö]/g, 'o').replace(/[śš]/g, 's').replace(/[źżž]/g, 'z').replace(/[ùúûü]/g, 'u').replace(/[ìíîï]/g, 'i')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// Tiny confirm that avoids native dialogs blocking automation: still native
// confirm() by default (the user is a human), but centralised.
export function ask(msg) { return window.confirm(msg); }

// ── Storage ─────────────────────────────────────────────────────────────────
// Downscale + WebP in the browser before upload (4–5 MB PNG → ~80 KB).
export async function optimizeImage(file, maxEdge = 1600, quality = 0.82) {
  const passthrough = /svg|gif/i.test(file.type) || !/^image\//.test(file.type || '');
  if (passthrough) return { blob: file, type: file.type || 'application/octet-stream', ext: (file.name.split('.').pop() || 'bin').toLowerCase() };
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h); bitmap.close?.();
    const encode = (type, q) => new Promise((res) => canvas.toBlob(res, type, q));
    let blob = await encode('image/webp', quality);
    if (blob && blob.type === 'image/webp') return { blob, type: 'image/webp', ext: 'webp' };
    blob = await encode('image/jpeg', 0.85);
    if (blob) return { blob, type: 'image/jpeg', ext: 'jpg' };
  } catch (err) { console.warn('[optimize] fallback to original', err); }
  return { blob: file, type: file.type || 'application/octet-stream', ext: (file.name.split('.').pop() || 'jpg').toLowerCase() };
}

export async function uploadImage(file, folder) {
  const { blob, type, ext } = await optimizeImage(file);
  const safeExt = /^[a-z0-9]+$/.test(ext) ? ext : 'jpg';
  const path = `${folder}/${crypto.randomUUID()}.${safeExt}`;
  const { error } = await sb.storage.from(MEDIA_BUCKET).upload(path, blob, { cacheControl: '31536000', contentType: type || undefined, upsert: false });
  if (error) throw error;
  return path;
}
export async function removeMedia(path) {
  if (!path) return;
  const { error } = await sb.storage.from(MEDIA_BUCKET).remove([path]);
  if (error) console.warn('[remove]', error);
}
export function pickFile(accept = 'image/jpeg,image/png,image/webp,image/avif,image/gif,image/svg+xml', multiple = false) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.multiple = multiple;
    input.onchange = () => resolve(multiple ? Array.from(input.files || []) : (input.files?.[0] || null));
    input.click();
  });
}

// ── AI translation (Edge Function `translate` → Barabash AI) ────────────────
// items: [{ key, text }] → { key: { en, ru } }
export async function translateItems(items, context) {
  if (!items.length) return {};
  const { data: { session } } = await sb.auth.getSession();
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ items, context }),
  });
  const data = await resp.json();
  if (!resp.ok || data.error) throw new Error(data.error || `translate HTTP ${resp.status}`);
  return data.translations || {};
}

// Fill missing EN/RU on an object for the given PL-based field names.
// fields: ['title', 'tagline'] → looks at title_pl/en/ru. Returns count filled.
export async function autoTranslateRow(row, fields, context, overwrite = false) {
  const items = [];
  for (const f of fields) {
    const pl = (row[`${f}_pl`] || '').trim();
    if (!pl) continue;
    if (overwrite || !(row[`${f}_en`] || '').trim() || !(row[`${f}_ru`] || '').trim()) items.push({ key: f, text: pl });
  }
  if (!items.length) return 0;
  const tr = await translateItems(items, context);
  let n = 0;
  for (const it of items) {
    const t = tr[it.key]; if (!t) continue;
    if (t.en && (overwrite || !(row[`${it.key}_en`] || '').trim())) { row[`${it.key}_en`] = t.en; n++; }
    if (t.ru && (overwrite || !(row[`${it.key}_ru`] || '').trim())) { row[`${it.key}_ru`] = t.ru; n++; }
  }
  return n;
}

// Translate arrays of strings (bullets) PL → EN/RU when the targets are shorter.
export async function autoTranslateList(row, base, context, overwrite = false) {
  const pl = row[`${base}_pl`] || [];
  if (!pl.length) return 0;
  const needEn = overwrite || (row[`${base}_en`] || []).length !== pl.length;
  const needRu = overwrite || (row[`${base}_ru`] || []).length !== pl.length;
  if (!needEn && !needRu) return 0;
  const tr = await translateItems(pl.map((text, i) => ({ key: String(i), text })), context);
  const en = [], ru = [];
  pl.forEach((text, i) => { en.push(tr[String(i)]?.en || text); ru.push(tr[String(i)]?.ru || text); });
  if (needEn) row[`${base}_en`] = en;
  if (needRu) row[`${base}_ru`] = ru;
  return pl.length;
}

// ── Lang trio markup helper ─────────────────────────────────────────────────
export function trio(field, values, { textarea = false, rows = 3, placeholder = '' } = {}) {
  const inp = (l) => textarea
    ? `<textarea data-f="${field}" data-l="${l}" rows="${rows}" placeholder="${attr(placeholder)}">${attr(values?.[`${field}_${l}`])}</textarea>`
    : `<input data-f="${field}" data-l="${l}" value="${attr(values?.[`${field}_${l}`])}" placeholder="${attr(placeholder)}" />`;
  return `<div class="lang-trio">
    <div class="field-input" data-lang="PL">${inp('pl')}</div>
    <div class="field-input" data-lang="EN">${inp('en')}</div>
    <div class="field-input" data-lang="RU">${inp('ru')}</div>
  </div>`;
}
// Read every [data-f][data-l] / [data-f] input inside root into obj.
export function readForm(root, obj = {}) {
  $$('[data-f]', root).forEach((el) => {
    const f = el.dataset.f, l = el.dataset.l;
    const key = l ? `${f}_${l}` : f;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (typeof v === 'string') v = v.trim();
    if (el.dataset.type === 'number') v = v === '' ? null : Number(v);
    if (el.dataset.type === 'list') v = String(v).split('\n').map((x) => x.trim()).filter(Boolean);
    if (el.dataset.type === 'csv') v = String(v).split(',').map((x) => x.trim()).filter(Boolean);
    obj[key] = v === '' ? null : v;
  });
  return obj;
}

export function modal(html, { wide = false } = {}) {
  const root = document.createElement('div');
  root.className = 'modal-root' + (wide ? ' is-wide' : '');
  root.innerHTML = `<div class="modal-backdrop"></div><div class="modal-card" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add('is-open'));
  const close = () => { root.classList.remove('is-open'); setTimeout(() => root.remove(), 220); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  root.querySelector('.modal-backdrop').addEventListener('click', close);
  $$('[data-modal-close]', root).forEach((b) => b.addEventListener('click', close));
  return { root, close, card: root.querySelector('.modal-card') };
}
