// Project estimator — pure pricing/timeline model shared by the build (config
// defaults, base prices from the `services` table) and the browser widget.
// Numbers are deliberately conservative ranges, not quotes: the AI summary and
// the final offer refine them. Admin can override everything via
// site_settings.estimator_config (value_meta, same shape as EstimatorConfig).

export type Choice = { id: string; add: number; weeks: number };
export type Feature = Choice & { included?: string[] };
export interface EstimatorConfig {
  types: Choice[];               // add = base price (zł netto), weeks = base duration
  pages: (Choice & { mult?: Record<string, number> })[];
  features: Feature[];
  content: Choice[];
  start: (Choice & { mult?: number })[];
  range: [number, number];       // low/high multipliers around the point estimate
}

export const DEFAULT_CONFIG: EstimatorConfig = {
  types: [
    { id: 'landing', add: 2500, weeks: 1.5 },
    { id: 'site', add: 3500, weeks: 2 },
    { id: 'shop', add: 8000, weeks: 3 },
    { id: 'platform', add: 15000, weeks: 4 },
    { id: 'redesign', add: 3000, weeks: 2 },
  ],
  pages: [
    { id: 'p1', add: 0, weeks: 0 },
    { id: 'p2', add: 1500, weeks: 0.25, mult: { shop: 1.5, platform: 2 } },
    { id: 'p3', add: 3500, weeks: 0.75, mult: { shop: 1.5, platform: 2 } },
    { id: 'p4', add: 6000, weeks: 1.5, mult: { shop: 1.5, platform: 2 } },
  ],
  features: [
    { id: 'cms', add: 1000, weeks: 0.25, included: ['shop', 'platform'] },
    { id: 'blog', add: 800, weeks: 0.15 },
    { id: 'i18n', add: 1500, weeks: 0.25 },
    { id: 'booking', add: 1500, weeks: 0.25 },
    { id: 'payments', add: 2000, weeks: 0.25, included: ['shop'] },
    { id: 'integrations', add: 3000, weeks: 0.5 },
    { id: 'accounts', add: 2500, weeks: 0.5, included: ['platform'] },
    { id: 'motion', add: 2500, weeks: 0.25 },
  ],
  content: [
    { id: 'ready', add: 0, weeks: 0 },
    { id: 'help', add: 1500, weeks: 0.25 },
  ],
  start: [
    { id: 'asap', add: 0, weeks: 0, mult: 1.15 },
    { id: 'month', add: 0, weeks: 0 },
    { id: 'later', add: 0, weeks: 0 },
  ],
  range: [0.9, 1.25],
};

// "od 3 500 zł" → 3500 (first number in the string), null if none.
export function parsePrice(s?: string | null): number | null {
  const m = String(s ?? '').replace(/\s| /g, '').match(/\d+/);
  return m ? Number(m[0]) : null;
}

// Base prices follow the live service prices (admin → Usługi), so the widget
// never contradicts the offer block next to it.
export function buildConfig(override: Partial<EstimatorConfig> | null | undefined, services: { slug: string; price_from?: string | null }[]): EstimatorConfig {
  const cfg: EstimatorConfig = JSON.parse(JSON.stringify({ ...DEFAULT_CONFIG, ...(override || {}) }));
  const map: Record<string, string> = { site: 'strony-internetowe', shop: 'sklepy-internetowe', platform: 'platformy-i-aplikacje' };
  for (const t of cfg.types) {
    const sv = services.find((s) => s.slug === map[t.id]);
    const p = parsePrice(sv?.price_from);
    if (p && p > 0) t.add = p;
  }
  return cfg;
}

export interface Brief { type: string; pages: string; features: string[]; content: string; start: string }
export interface Estimate {
  lo: number; hi: number; wlo: number; whi: number;
  lines: { id: string; group: string; amount: number; included?: boolean }[];
}

const round = (n: number, step = 500) => Math.max(step, Math.round(n / step) * step);

export function estimate(cfg: EstimatorConfig, b: Brief): Estimate {
  const type = cfg.types.find((x) => x.id === b.type) || cfg.types[1];
  const pages = cfg.pages.find((x) => x.id === b.pages) || cfg.pages[0];
  const content = cfg.content.find((x) => x.id === b.content) || cfg.content[0];
  const start = cfg.start.find((x) => x.id === b.start) || cfg.start[1];
  const lines: Estimate['lines'] = [{ id: type.id, group: 'type', amount: type.add }];
  let total = type.add;
  let weeks = type.weeks;
  const pAdd = Math.round(pages.add * (pages.mult?.[type.id] ?? 1));
  if (pAdd) { total += pAdd; lines.push({ id: pages.id, group: 'pages', amount: pAdd }); }
  weeks += pages.weeks;
  for (const id of b.features) {
    const f = cfg.features.find((x) => x.id === id);
    if (!f) continue;
    const incl = !!f.included?.includes(type.id);
    lines.push({ id: f.id, group: 'feature', amount: incl ? 0 : f.add, included: incl });
    if (!incl) { total += f.add; weeks += f.weeks; }
  }
  if (content.add) { total += content.add; lines.push({ id: content.id, group: 'content', amount: content.add }); }
  weeks += content.weeks;
  total *= start.mult ?? 1;
  const wlo = Math.max(1, Math.floor(weeks));
  return { lo: round(total * cfg.range[0]), hi: round(total * cfg.range[1]), wlo, whi: wlo + 1, lines };
}

export const fmtPln = (n: number, locale = 'pl') => n.toLocaleString(locale === 'pl' ? 'pl-PL' : locale === 'ru' ? 'ru-RU' : 'en-GB').replace(/,/g, ' ');
