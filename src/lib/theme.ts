// Theme manager: light is default, persists an explicit user choice.
// Colors live in main.css under [data-theme="light|dark"]. SSR-safe.

export type Theme = 'light' | 'dark';
const STORAGE_KEY = 'bf:theme';
const DEFAULT_THEME: Theme = 'light';
const listeners = new Set<(t: Theme) => void>();

let current: Theme = loadTheme();
if (typeof document !== 'undefined') apply(current);

function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {}
  return DEFAULT_THEME;
}

function apply(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
}

export function getTheme(): Theme {
  return current;
}

export function setTheme(next: Theme) {
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

export function onThemeChange(fn: (t: Theme) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
