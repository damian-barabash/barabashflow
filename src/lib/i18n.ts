// Three-language UI strings + helpers. Field suffixes use the same locale code
// (title_pl / title_en / title_ru), which keeps pickField trivial.
// SSR-safe: all window/localStorage/document access is guarded so this module
// can also be imported at build time.

export type Locale = 'pl' | 'en' | 'ru';
export const LOCALES: Locale[] = ['pl', 'en', 'ru'];
export const DEFAULT_LOCALE: Locale = 'pl';
const STORAGE_KEY = 'bf:locale';

export const STRINGS: Record<Locale, Record<string, string>> = {
  pl: {
    'nav.about': 'O mnie',
    'nav.privacy': 'Polityka prywatności',
    'blog.h1': 'Blog o stronach internetowych, platformach i SEO',
    'blog.by': 'Autor',
    'blog.published': 'Opublikowano',
    'blog.updated': 'Aktualizacja',
    'blog.related': 'Czytaj także',
    'blog.author.link': 'Więcej o autorze →',
    'home.blog.title': 'Ostatnio na blogu',
    'home.blog.sub': 'Praktyczne odpowiedzi na pytania, które klienci zadają przed zleceniem strony lub platformy.',
    'home.blog.all': 'Wszystkie wpisy',
    'faq.more': 'Więcej w artykule:',
    'svc.more': 'Czytaj na blogu:',
    'about.kicker': 'O mnie',
    'about.title': 'Dmytrii Barabash — web developer i założyciel BarabashFlow',
    'about.lead': 'Projektuję i buduję strony internetowe, platformy i aplikacje webowe dla firm. Pracuję z Warszawy, dla klientów z Polski i zagranicy — po polsku, angielsku i rosyjsku.',
    'about.h.what': 'Czym się zajmuję',
    'about.p.what': 'Całym procesem — od briefu i wyceny, przez projekt graficzny i kod, po wdrożenie na domenie i opiekę po starcie. Nie używam gotowych szablonów: każdy projekt to kod pisany pod konkretną firmę, jej klientów i cele. Zrealizowane projekty zobaczysz na mapie na stronie głównej.',
    'about.h.how': 'Jak pracuję',
    'about.p.how': 'Szybko i przejrzyście. Na brief odpowiadam w 24 godziny z planem i konkretną wyceną. Postęp widzisz na żywo i zgłaszasz uwagi na bieżąco. Strony buduję jako statyczne (Astro, React, Next.js) z backendem Supabase — ładują się natychmiast i dobrze pozycjonują w Google.',
    'about.h.stack': 'Technologie',
    'about.h.editorial': 'Zasady redakcyjne bloga',
    'about.p.editorial': 'Wpisy na blogu odpowiadają na realne pytania, które klienci zadają przed zleceniem strony — tematy wybieram na podstawie wyszukiwań w Google i rozmów z klientami. Nie wymyślam statystyk ani opinii klientów, podaję realne widełki cenowe, a starsze artykuły aktualizuję, gdy zmieniają się ceny lub technologie (data aktualizacji jest widoczna przy każdym wpisie). Blog nie zawiera reklam ani linków afiliacyjnych. Zdjęcia pochodzą z bibliotek na licencjach Creative Commons, z podaniem autora.',
    'about.h.contact': 'Kontakt',
    'about.p.contact': 'Najszybciej przez formularz lub e-mail. Odpowiadam w ciągu 24 godzin w dni robocze.',
    'about.cta': 'Napisz do mnie',
    'contact.kicker': 'Kontakt',
    'contact.page.title': 'Porozmawiajmy o Twoim projekcie',
    'contact.page.lead': 'Opisz pomysł w kilku zdaniach — w ciągu 24 godzin odpiszę z planem, zakresem i wyceną. Strona, platforma, sklep czy panel: zaczynamy od rozmowy.',
    'contact.page.email': 'E-mail',
    'contact.page.location': 'Lokalizacja',
    'contact.page.location.v': 'Warszawa, Polska — praca zdalna dla klientów z całego świata',
    'contact.page.reply': 'Czas odpowiedzi',
    'contact.page.reply.v': 'do 24 godzin w dni robocze',
    'contact.page.langs': 'Języki',
    'contact.page.form': 'Formularz kontaktowy',
    'contact.consent': 'Wysyłając wiadomość, akceptujesz politykę prywatności.',
    'nav.contact': 'Kontakt',
    'nav.home': 'Strona główna',
    'nav.blog': 'Blog',
    'blog.chip': 'Strony · Platformy · SEO',
    'blog.sub': 'Praktycznie o stronach internetowych, platformach i widoczności w Google — ceny, technologie i porady dla firm, bez żargonu.',
    'blog.empty': 'Pierwsze wpisy są w drodze — zajrzyj tu wkrótce.',
    'blog.all': '← Wszystkie wpisy',
    'blog.author': 'Projektuję i wdrażam strony internetowe, platformy i aplikacje webowe dla firm. Warszawa → cały świat.',
    'graph.hint': 'Kliknij — karta projektu. Przeciągnij — przesuń węzeł.',
    'graph.cursor-hint': 'Przeciągnij · Klik',
    'graph.pan-hint': 'To graf — przeciągnij, by przesunąć',
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
    'hero.see-work': 'Zobacz projekty',
    'stats.projects': 'Projekty w grafie',
    'stats.langs': 'Języki obsługi',
    'stats.reply': 'Odpowiedź na brief',
    'stats.custom': 'Kod na miarę, zero szablonów',
    'sec.works.kicker': 'Portfolio',
    'sec.works.title': 'Mapa zrealizowanych projektów',
    'sec.services.kicker': 'Usługi',
    'sec.services.title': 'Co mogę dla Ciebie zbudować',
    'sec.services.sub': 'Od strony-wizytówki po platformę z własnym panelem — projekt, kod i wdrożenie w jednych rękach.',
    'svc.site.t': 'Strony internetowe',
    'svc.site.d': 'Szybkie, dopracowane strony firmowe i wizytówki, które ładują się natychmiast i dobrze pozycjonują.',
    'svc.platform.t': 'Platformy i aplikacje',
    'svc.platform.d': 'Aplikacje webowe na zamówienie: rezerwacje, kalendarze, portale klienta, integracje z API.',
    'svc.cms.t': 'Panele CMS i admin',
    'svc.cms.d': 'Własny panel do edycji treści, zdjęć i zamówień — bez abonamentów i bez WordPressa.',
    'svc.shop.t': 'Sklepy internetowe',
    'svc.shop.d': 'E-commerce z płatnościami, katalogiem i panelem sprzedaży — dopasowany do Twojego produktu.',
    'sec.process.kicker': 'Proces',
    'sec.process.title': 'Jak wygląda współpraca',
    'proc.1.t': 'Brief i wycena',
    'proc.1.d': 'Opisujesz pomysł — w 24 h dostajesz plan, zakres i konkretną wycenę.',
    'proc.2.t': 'Projekt i budowa',
    'proc.2.d': 'Design i kod powstają razem — widzisz postęp na żywo i zgłaszasz uwagi.',
    'proc.3.t': 'Wdrożenie i opieka',
    'proc.3.d': 'Domena, hosting, panel — wszystko działa. Zostaję do pomocy po starcie.',
    'sec.faq.title': 'Częste pytania',
    'faq.1.q': 'Ile kosztuje strona internetowa?',
    'faq.1.a': 'Koszt zależy od zakresu — od prostej strony-wizytówki po rozbudowaną platformę z panelem CMS. Napisz przez formularz, przygotuję wycenę dopasowaną do projektu.',
    'faq.2.q': 'Jak długo trwa realizacja?',
    'faq.2.a': 'Strona-wizytówka to zwykle 1–2 tygodnie, platforma z panelem — od kilku tygodni. Dokładny harmonogram dostajesz razem z wyceną.',
    'faq.3.q': 'W jakich technologiach pracujesz?',
    'faq.3.a': 'Astro, React, Next.js, Supabase, Three.js. Strony są statyczne i wdrażane na GitHub Pages / Cloudflare — dzięki temu ładują się natychmiast.',
    'cta.title': 'Masz pomysł na projekt?',
    'cta.sub': 'Opowiedz o nim w dwóch zdaniach — odpiszę w ciągu 24 godzin z planem i wyceną.',
  },
  en: {
    'nav.about': 'About',
    'nav.privacy': 'Privacy policy',
    'blog.h1': 'Blog about websites, platforms and SEO',
    'blog.by': 'Author',
    'blog.published': 'Published',
    'blog.updated': 'Updated',
    'blog.related': 'Related reading',
    'blog.author.link': 'More about the author →',
    'home.blog.title': 'Latest from the blog',
    'home.blog.sub': 'Practical answers to the questions clients ask before commissioning a website or platform.',
    'home.blog.all': 'All posts',
    'faq.more': 'Read more:',
    'svc.more': 'On the blog:',
    'about.kicker': 'About',
    'about.title': 'Dmytrii Barabash — web developer and founder of BarabashFlow',
    'about.lead': 'I design and build websites, platforms and web applications for businesses. Based in Warsaw, working with clients in Poland and abroad — in Polish, English and Russian.',
    'about.h.what': 'What I do',
    'about.p.what': 'The whole process — from brief and quote, through design and code, to launch on your domain and care after go-live. No templates: every project is code written for a specific business, its customers and goals. Delivered projects are on the map on the home page.',
    'about.h.how': 'How I work',
    'about.p.how': 'Fast and transparent. I answer a brief within 24 hours with a plan and a concrete quote. You watch progress live and give feedback as we go. Sites are built static (Astro, React, Next.js) on a Supabase backend — they load instantly and rank well in Google.',
    'about.h.stack': 'Technologies',
    'about.h.editorial': 'Blog editorial policy',
    'about.p.editorial': 'Blog posts answer the real questions clients ask before commissioning a site — topics come from Google searches and client conversations. No invented statistics or testimonials, real price ranges, and older articles are updated when prices or technology change (the update date is shown on every post). The blog carries no ads or affiliate links. Photos come from Creative Commons libraries, with attribution.',
    'about.h.contact': 'Contact',
    'about.p.contact': 'Fastest via the form or email. I reply within 24 hours on business days.',
    'about.cta': 'Get in touch',
    'contact.kicker': 'Contact',
    'contact.page.title': 'Let’s talk about your project',
    'contact.page.lead': 'Describe the idea in a few sentences — within 24 hours I reply with a plan, scope and quote. Website, platform, store or admin panel: it starts with a conversation.',
    'contact.page.email': 'Email',
    'contact.page.location': 'Location',
    'contact.page.location.v': 'Warsaw, Poland — remote work for clients worldwide',
    'contact.page.reply': 'Response time',
    'contact.page.reply.v': 'within 24 hours on business days',
    'contact.page.langs': 'Languages',
    'contact.page.form': 'Contact form',
    'contact.consent': 'By sending a message you accept the privacy policy.',
    'nav.contact': 'Contact',
    'nav.home': 'Home',
    'nav.blog': 'Blog',
    'blog.chip': 'Websites · Platforms · SEO',
    'blog.sub': 'A practical blog about websites, platforms and Google visibility — prices, technology and advice for businesses, no jargon.',
    'blog.empty': 'The first posts are on their way — check back soon.',
    'blog.all': '← All posts',
    'blog.author': 'I design and build websites, platforms and web applications for businesses. Warsaw → worldwide.',
    'graph.hint': 'Click — open card. Drag — move node.',
    'graph.cursor-hint': 'Drag or click',
    'graph.pan-hint': 'This is a graph — drag to move',
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
    'hero.see-work': 'See the work',
    'stats.projects': 'Projects in the graph',
    'stats.langs': 'Working languages',
    'stats.reply': 'Brief answered within',
    'stats.custom': 'Custom code, zero templates',
    'sec.works.kicker': 'Portfolio',
    'sec.works.title': 'Map of delivered projects',
    'sec.services.kicker': 'Services',
    'sec.services.title': 'What I can build for you',
    'sec.services.sub': 'From a landing page to a platform with its own admin panel — design, code and launch in one pair of hands.',
    'svc.site.t': 'Websites',
    'svc.site.d': 'Fast, polished company sites and landing pages that load instantly and rank well.',
    'svc.platform.t': 'Platforms & web apps',
    'svc.platform.d': 'Custom web applications: bookings, calendars, client portals, API integrations.',
    'svc.cms.t': 'CMS & admin panels',
    'svc.cms.d': 'Your own panel for content, photos and orders — no subscriptions, no WordPress.',
    'svc.shop.t': 'Online stores',
    'svc.shop.d': 'E-commerce with payments, a catalogue and a sales panel — shaped around your product.',
    'sec.process.kicker': 'Process',
    'sec.process.title': 'How we work together',
    'proc.1.t': 'Brief & quote',
    'proc.1.d': 'Describe the idea — within 24 h you get a plan, scope and a concrete quote.',
    'proc.2.t': 'Design & build',
    'proc.2.d': 'Design and code grow together — you watch progress live and give feedback.',
    'proc.3.t': 'Launch & care',
    'proc.3.d': 'Domain, hosting, panel — everything works. I stay around after launch.',
    'sec.faq.title': 'Common questions',
    'faq.1.q': 'How much does a website cost?',
    'faq.1.a': 'It depends on scope — from a simple landing page to a full platform with a CMS panel. Write through the form and I will prepare a quote for your project.',
    'faq.2.q': 'How long does it take?',
    'faq.2.a': 'A landing page usually takes 1–2 weeks, a platform with a panel — from a few weeks. You get an exact timeline with the quote.',
    'faq.3.q': 'What technologies do you work with?',
    'faq.3.a': 'Astro, React, Next.js, Supabase, Three.js. Sites are static and deployed to GitHub Pages / Cloudflare — so they load instantly.',
    'cta.title': 'Have a project in mind?',
    'cta.sub': 'Describe it in two sentences — I will reply within 24 hours with a plan and a quote.',
  },
  ru: {
    'nav.about': 'Обо мне',
    'nav.privacy': 'Политика конфиденциальности',
    'blog.h1': 'Блог о сайтах, платформах и SEO',
    'blog.by': 'Автор',
    'blog.published': 'Опубликовано',
    'blog.updated': 'Обновлено',
    'blog.related': 'Читайте также',
    'blog.author.link': 'Об авторе →',
    'home.blog.title': 'Свежее в блоге',
    'home.blog.sub': 'Практичные ответы на вопросы, которые клиенты задают перед заказом сайта или платформы.',
    'home.blog.all': 'Все записи',
    'faq.more': 'Подробнее в статье:',
    'svc.more': 'В блоге:',
    'about.kicker': 'Обо мне',
    'about.title': 'Дмитрий Барабаш — веб-разработчик и основатель BarabashFlow',
    'about.lead': 'Проектирую и создаю сайты, платформы и веб-приложения для бизнеса. Работаю из Варшавы с клиентами из Польши и других стран — на польском, английском и русском.',
    'about.h.what': 'Чем я занимаюсь',
    'about.p.what': 'Всем процессом — от брифа и сметы через дизайн и код до запуска на домене и поддержки после старта. Без шаблонов: каждый проект — это код, написанный под конкретную компанию, её клиентов и цели. Реализованные проекты — на карте на главной странице.',
    'about.h.how': 'Как я работаю',
    'about.p.how': 'Быстро и прозрачно. На бриф отвечаю в течение 24 часов с планом и конкретной сметой. Прогресс вы видите вживую и даёте правки по ходу. Сайты строю статическими (Astro, React, Next.js) с бэкендом Supabase — они открываются мгновенно и хорошо ранжируются в Google.',
    'about.h.stack': 'Технологии',
    'about.h.editorial': 'Редакционные принципы блога',
    'about.p.editorial': 'Записи в блоге отвечают на реальные вопросы, которые клиенты задают перед заказом сайта, — темы берутся из поисковых запросов Google и разговоров с клиентами. Никакой выдуманной статистики и отзывов, реальные ценовые вилки, а старые статьи обновляются при изменении цен или технологий (дата обновления видна у каждой записи). В блоге нет рекламы и партнёрских ссылок. Фото — из библиотек с лицензией Creative Commons, с указанием автора.',
    'about.h.contact': 'Контакт',
    'about.p.contact': 'Быстрее всего — через форму или e-mail. Отвечаю в течение 24 часов в рабочие дни.',
    'about.cta': 'Написать мне',
    'contact.kicker': 'Контакт',
    'contact.page.title': 'Поговорим о вашем проекте',
    'contact.page.lead': 'Опишите идею в нескольких предложениях — в течение 24 часов отвечу с планом, объёмом и сметой. Сайт, платформа, магазин или панель: всё начинается с разговора.',
    'contact.page.email': 'E-mail',
    'contact.page.location': 'Локация',
    'contact.page.location.v': 'Варшава, Польша — удалённая работа с клиентами по всему миру',
    'contact.page.reply': 'Время ответа',
    'contact.page.reply.v': 'до 24 часов в рабочие дни',
    'contact.page.langs': 'Языки',
    'contact.page.form': 'Форма обратной связи',
    'contact.consent': 'Отправляя сообщение, вы принимаете политику конфиденциальности.',
    'nav.contact': 'Контакт',
    'nav.home': 'Главная',
    'nav.blog': 'Блог',
    'blog.chip': 'Сайты · Платформы · SEO',
    'blog.sub': 'Практично о сайтах, платформах и видимости в Google — цены, технологии и советы для бизнеса, без жаргона.',
    'blog.empty': 'Первые записи уже в пути — загляните чуть позже.',
    'blog.all': '← Все записи',
    'blog.author': 'Проектирую и запускаю сайты, платформы и веб-приложения для бизнеса. Варшава → весь мир.',
    'graph.hint': 'Клик — открыть карточку. Перетащить — двигать узел.',
    'graph.cursor-hint': 'Тащи · Клик',
    'graph.pan-hint': 'Это граф — перетащите, чтобы двигать',
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
    'hero.see-work': 'Смотреть проекты',
    'stats.projects': 'Проектов в графе',
    'stats.langs': 'Языка общения',
    'stats.reply': 'Ответ на бриф',
    'stats.custom': 'Код с нуля, без шаблонов',
    'sec.works.kicker': 'Портфолио',
    'sec.works.title': 'Карта реализованных проектов',
    'sec.services.kicker': 'Услуги',
    'sec.services.title': 'Что я могу для вас построить',
    'sec.services.sub': 'От сайта-визитки до платформы с собственной админкой — дизайн, код и запуск в одних руках.',
    'svc.site.t': 'Сайты',
    'svc.site.d': 'Быстрые, аккуратные сайты компаний и визитки, которые мгновенно загружаются и хорошо ранжируются.',
    'svc.platform.t': 'Платформы и приложения',
    'svc.platform.d': 'Веб-приложения под заказ: бронирования, календари, порталы клиентов, интеграции с API.',
    'svc.cms.t': 'CMS и админ-панели',
    'svc.cms.d': 'Собственная панель для текстов, фото и заказов — без подписок и без WordPress.',
    'svc.shop.t': 'Интернет-магазины',
    'svc.shop.d': 'E-commerce с оплатой, каталогом и панелью продаж — под ваш продукт.',
    'sec.process.kicker': 'Процесс',
    'sec.process.title': 'Как проходит работа',
    'proc.1.t': 'Бриф и смета',
    'proc.1.d': 'Вы описываете идею — за 24 ч получаете план, объём и конкретную смету.',
    'proc.2.t': 'Дизайн и разработка',
    'proc.2.d': 'Дизайн и код растут вместе — вы видите прогресс вживую и даёте правки.',
    'proc.3.t': 'Запуск и поддержка',
    'proc.3.d': 'Домен, хостинг, панель — всё работает. Остаюсь на связи после запуска.',
    'sec.faq.title': 'Частые вопросы',
    'faq.1.q': 'Сколько стоит сайт?',
    'faq.1.a': 'Зависит от объёма — от простой визитки до платформы с CMS-панелью. Напишите через форму, и я подготовлю смету под ваш проект.',
    'faq.2.q': 'Сколько длится разработка?',
    'faq.2.a': 'Сайт-визитка — обычно 1–2 недели, платформа с панелью — от нескольких недель. Точный график вы получаете вместе со сметой.',
    'faq.3.q': 'На каких технологиях вы работаете?',
    'faq.3.a': 'Astro, React, Next.js, Supabase, Three.js. Сайты статические и деплоятся на GitHub Pages / Cloudflare — поэтому открываются мгновенно.',
    'cta.title': 'Есть идея проекта?',
    'cta.sub': 'Опишите её в двух предложениях — отвечу в течение 24 часов с планом и сметой.',
  },
};

type Row = Record<string, any> | null | undefined;
const listeners = new Set<(l: Locale) => void>();
let current: Locale = loadLocale();

function loadLocale(): Locale {
  // PL is always the starting language. Only honor an explicit prior choice.
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (LOCALES as string[]).includes(saved)) return saved as Locale;
  } catch {}
  return DEFAULT_LOCALE;
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(next: Locale) {
  if (!LOCALES.includes(next) || next === current) return;
  current = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  applyDom();
  listeners.forEach((fn) => fn(next));
}

export function onLocaleChange(fn: (l: Locale) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key: string): string {
  const table = STRINGS[current] || STRINGS[DEFAULT_LOCALE];
  return table[key] ?? STRINGS[DEFAULT_LOCALE][key] ?? key;
}

// Pick a localized field from a row: pickField(project, 'title').
// Falls back current -> the other locales.
export function pickField(row: Row, base: string): string {
  if (!row) return '';
  const order: Locale[] = [current, ...LOCALES.filter((l) => l !== current)];
  for (const loc of order) {
    const v = row[`${base}_${loc}`];
    if (v && String(v).trim().length) return v;
  }
  return '';
}

export function applyDom(root: Document | HTMLElement = document) {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')!;
    const val = t(key);
    if (val !== key) el.textContent = val;
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder')!;
    const val = t(key);
    if (val !== key) el.setAttribute('placeholder', val);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria')!;
    const val = t(key);
    if (val !== key) el.setAttribute('aria-label', val);
  });
  // Localized text baked into attributes (blog titles/excerpts rendered in PL
  // for crawlers, swapped client-side): data-lm-pl / data-lm-en / data-lm-ru.
  root.querySelectorAll<HTMLElement>('[data-lm-pl]').forEach((el) => {
    const v = el.getAttribute(`data-lm-${current}`) || el.getAttribute('data-lm-pl');
    if (v) el.textContent = v;
  });
}

// Initialize <html lang> on first import (client only).
if (typeof document !== 'undefined') document.documentElement.lang = current;
