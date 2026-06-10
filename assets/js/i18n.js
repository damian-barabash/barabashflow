// Three-language UI strings + helpers. Field suffixes use the same locale code
// (e.g. title_pl / title_en / title_ru), which makes pickField trivial.

export const LOCALES = ['pl', 'en', 'ru'];
export const DEFAULT_LOCALE = 'pl';
const STORAGE_KEY = 'bf:locale';

export const STRINGS = {
  pl: {
    'nav.contact': 'Kontakt',
    'graph.hint': 'Kliknij — karta projektu. Przeciągnij — przesuń węzeł.',
    'graph.cursor-hint': 'Przeciągnij · Klik',
    'graph.pan-hint':    'To graf — przeciągnij, by przesunąć',
    'meta.available': 'Dostępny',
    'meta.location': 'Warszawa → Świat',
    'hero.eyebrow': 'Studio Indywidualne',
    'modal.close': 'Zamknij',
    'modal.visit': 'Otwórz projekt',
    'modal.category': 'Kategoria',
    'contact.eyebrow': 'Współpraca',
    'contact.title': 'Porozmawiajmy',
    'contact.name': 'Imię',
    'contact.email': 'E-mail',
    'contact.message': 'Wiadomość',
    'contact.submit': 'Wyślij wiadomość',
    'contact.sending': 'Wysyłanie…',
    'contact.success': 'Dziękuję — odezwę się w ciągu 24 godzin.',
    'contact.error': 'Coś poszło nie tak. Spróbuj ponownie.',
    'contact.required': 'Uzupełnij wszystkie pola.',
    'category.site': 'Strona',
    'category.panel': 'Panel',
    'category.app': 'Aplikacja',
    'category.platform': 'Platforma',
    'category.other': 'Projekt',
  },
  en: {
    'nav.contact': 'Contact',
    'graph.hint': 'Click — open card. Drag — move node.',
    'graph.cursor-hint': 'Drag or click',
    'graph.pan-hint':    'This is a graph — drag to move',
    'meta.available': 'Available',
    'meta.location': 'Warsaw → Worldwide',
    'hero.eyebrow': 'Independent Studio',
    'modal.close': 'Close',
    'modal.visit': 'Open project',
    'modal.category': 'Category',
    'contact.eyebrow': 'Collaboration',
    'contact.title': 'Let’s talk',
    'contact.name': 'Name',
    'contact.email': 'Email',
    'contact.message': 'Message',
    'contact.submit': 'Send message',
    'contact.sending': 'Sending…',
    'contact.success': 'Thanks — I’ll reply within 24 hours.',
    'contact.error': 'Something went wrong. Please try again.',
    'contact.required': 'Please fill in all fields.',
    'category.site': 'Website',
    'category.panel': 'Panel',
    'category.app': 'App',
    'category.platform': 'Platform',
    'category.other': 'Project',
  },
  ru: {
    'nav.contact': 'Контакт',
    'graph.hint': 'Клик — открыть карточку. Перетащить — двигать узел.',
    'graph.cursor-hint': 'Тащи · Клик',
    'graph.pan-hint':    'Это граф — перетащите, чтобы двигать',
    'meta.available': 'Открыт',
    'meta.location': 'Варшава → Весь мир',
    'hero.eyebrow': 'Независимая Студия',
    'modal.close': 'Закрыть',
    'modal.visit': 'Открыть проект',
    'modal.category': 'Категория',
    'contact.eyebrow': 'Сотрудничество',
    'contact.title': 'Поговорим',
    'contact.name': 'Имя',
    'contact.email': 'E-mail',
    'contact.message': 'Сообщение',
    'contact.submit': 'Отправить',
    'contact.sending': 'Отправка…',
    'contact.success': 'Спасибо — отвечу в течение 24 часов.',
    'contact.error': 'Что-то пошло не так. Попробуйте ещё раз.',
    'contact.required': 'Заполните все поля.',
    'category.site': 'Сайт',
    'category.panel': 'Панель',
    'category.app': 'Приложение',
    'category.platform': 'Платформа',
    'category.other': 'Проект',
  },
};

const listeners = new Set();
let current = loadLocale();

function loadLocale() {
  // PL is always the starting language. Only honor an explicit switch the user made before.
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LOCALES.includes(saved)) return saved;
  } catch {}
  return DEFAULT_LOCALE;
}

export function getLocale() {
  return current;
}

export function setLocale(next) {
  if (!LOCALES.includes(next) || next === current) return;
  current = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  document.documentElement.lang = next;
  applyDom();
  listeners.forEach((fn) => fn(next));
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key) {
  const table = STRINGS[current] || STRINGS[DEFAULT_LOCALE];
  return table[key] ?? STRINGS[DEFAULT_LOCALE][key] ?? key;
}

// Pick a localized field from a row: pickField(project, 'title')
// Falls back PL -> EN -> RU when the current locale is missing.
export function pickField(row, base) {
  if (!row) return '';
  const order = [current, ...LOCALES.filter((l) => l !== current)];
  for (const loc of order) {
    const v = row[`${base}_${loc}`];
    if (v && String(v).trim().length) return v;
  }
  return '';
}

export function applyDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if (val !== key) el.textContent = val;       // keep author fallback if lookup failed
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    const val = t(key);
    if (val !== key) el.setAttribute('placeholder', val);
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    const val = t(key);
    if (val !== key) el.setAttribute('aria-label', val);
  });
}

// Initialize <html lang> on first import.
document.documentElement.lang = current;
