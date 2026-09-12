// Site-wide identity constants — one place for everything E-E-A-T related
// (author, publisher, contact, social profiles) so JSON-LD, footers, bylines
// and the about/contact pages never drift apart.

export const SITE = 'https://barabashflow.pl';
export const SITE_NAME = 'BarabashFlow';
export const AUTHOR_NAME = 'Damian Barabash';
export const AUTHOR_URL = `${SITE}/o-mnie/`;
export const CONTACT_URL = `${SITE}/kontakt/`;
export const PRIVACY_URL = `${SITE}/polityka-prywatnosci/`;
export const EMAIL = 'office@barabashflow.pl';
export const LOCATION = { locality: 'Warszawa', country: 'PL' };
// First public launch of barabashflow.pl (datePublished for the WebPage/WebSite entities).
export const SITE_PUBLISHED = '2026-05-25';
export const SOURCES: { label: string; url: string }[] = [
  { label: 'Google Search Central', url: 'https://developers.google.com/search/docs' },
  { label: 'web.dev', url: 'https://web.dev/articles/vitals' },
  { label: 'schema.org', url: 'https://schema.org/' },
  { label: 'WCAG 2.2', url: 'https://www.w3.org/TR/WCAG22/' },
  { label: 'UODO', url: 'https://uodo.gov.pl/' },
];

// Public profiles (schema.org sameAs + footer links). Add LinkedIn / Behance /
// Instagram here when available — everything downstream picks them up.
export const SOCIAL: { label: string; url: string }[] = [
  { label: 'GitHub', url: 'https://github.com/damian-barabash' },
];
export const SAME_AS = SOCIAL.map((s) => s.url);

// Shared JSON-LD entities (referenced by @id from page-level graphs).
export const PERSON_ID = `${SITE}/#person`;
export const ORG_ID = `${SITE}/#organization`;

export const personLd = {
  '@type': 'Person',
  '@id': PERSON_ID,
  name: AUTHOR_NAME,
  url: AUTHOR_URL,
  email: `mailto:${EMAIL}`,
  jobTitle: 'Web Developer',
  knowsAbout: ['Web development', 'Next.js', 'Astro', 'Supabase', 'React', 'Three.js', 'UI/UX', 'SEO'],
  worksFor: { '@id': ORG_ID },
  sameAs: SAME_AS,
  address: { '@type': 'PostalAddress', addressLocality: LOCATION.locality, addressCountry: LOCATION.country },
};

export const organizationLd = {
  '@type': ['Organization', 'ProfessionalService'],
  '@id': ORG_ID,
  name: SITE_NAME,
  url: SITE,
  logo: `${SITE}/assets/img/logo.png`,
  image: `${SITE}/assets/img/og.png`,
  email: EMAIL,
  founder: { '@id': PERSON_ID },
  sameAs: SAME_AS,
  areaServed: 'PL',
  serviceType: ['Tworzenie stron internetowych', 'Platformy internetowe', 'Aplikacje webowe', 'Sklepy internetowe'],
  address: { '@type': 'PostalAddress', addressLocality: LOCATION.locality, addressCountry: LOCATION.country },
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'sales',
    email: EMAIL,
    url: CONTACT_URL,
    availableLanguage: ['pl', 'en', 'ru'],
  },
};
