// Offer block ("next step") — which service + case to show next to content.
// Search Console audit 2026-11-10: blog posts and /o-mnie/ get clicks but
// don't lead to the service page; training-company queries need their own pitch.
import type { Project, Service } from './content';

export type OfferKind = 'training' | 'offer';
export interface Offer { kind: OfferKind; service: Service; project: Project | null }

// Case shown per service; falls back to the first project of the service with a client task.
const PREFERRED_CASE: Record<string, string> = {
  'strony-internetowe': 'dbdc-studio',
};
const TRAINING_CASE = 'aino-pottery-club';

export function caseFor(service: Service, projects: Project[]): Project | null {
  const pref = PREFERRED_CASE[service.slug];
  return (
    (pref && projects.find((p) => p.slug === pref)) ||
    projects.find((p) => p.services.includes(service.slug) && p.challenge_pl) ||
    null
  );
}

const TRAINING = /szkolen/i;
const SHOP = /sklep|e-commerce/i;

// Every post gets an offer block: training pitch for training-company topics,
// the shop service for e-commerce topics, "Strony internetowe" for everything else.
export function offerForPost(
  post: { slug: string; title_pl: string; tags?: string[] | null },
  services: Service[],
  projects: Project[],
): Offer | null {
  // Slug + title only: tags are too loose.
  const hay = `${post.slug.replace(/-/g, ' ')} ${post.title_pl}`;
  const site = services.find((s) => s.slug === 'strony-internetowe');
  if (!site) return null;
  if (TRAINING.test(hay)) {
    return { kind: 'training', service: site, project: projects.find((p) => p.slug === TRAINING_CASE) || caseFor(site, projects) };
  }
  const service = (SHOP.test(hay) && services.find((s) => s.slug === 'sklepy-internetowe')) || site;
  return { kind: 'offer', service, project: caseFor(service, projects) };
}
