-- Personal landing page per lead (2026-11-16): every offer e-mail links to
-- https://barabashflow.pl/oferta/?l=<public_token>. The page (static, noindex)
-- fetches the lead's public data from edge `leads` (action "view", no auth,
-- token only), shows "Propozycja dla <firma>", 3 tailored points, a case and
-- the estimator preset for them; the brief lands in contact_submissions and
-- the owner gets an e-mail. Views/brief are tracked on the lead.
alter table public.leads
  add column if not exists public_token text,
  add column if not exists landing jsonb,              -- {headline, intro, bullets[], est_type, est_features[], case_slug, service_slug}
  add column if not exists views int not null default 0,
  add column if not exists viewed_at timestamptz,      -- first open
  add column if not exists last_viewed_at timestamptz,
  add column if not exists briefed_at timestamptz;

update public.leads set public_token = substr(replace(gen_random_uuid()::text, '-', ''), 1, 10) where public_token is null;
alter table public.leads alter column public_token set default substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
create unique index if not exists leads_public_token_uniq on public.leads (public_token);
