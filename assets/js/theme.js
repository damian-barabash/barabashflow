// Theme manager: light is default, persists explicit user choice.
// All colors live in main.css under [data-theme="light|dark"].

const STORAGE_KEY = 'bf:theme';
const DEFAULT_THEME = 'light';
const listeners = new Set();

let current = loadTheme();
apply(current);

function loadTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {}
  return DEFAULT_THEME;
}

function apply(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
}

export function getTheme() {
  return current;
}

export function setTheme(next) {
  if (next !== 'light' && next !== 'dark') return;
  if (next === current) return;
  current = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  apply(next);
  listeners.forEach((fn) => fn(next));
}

export function toggleTheme() {
  setTheme(current === 'light' ? 'dark' : 'light');
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
