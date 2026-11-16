-- Lead finder (2026-11-16): new companies from the public KRS registry (later
-- also CEIDG) → AI fit score + personalised offer e-mail → owner reviews in
-- admin → "Wyślij" sends via Resend from office@barabashflow.pl (reply-to +
-- bcc the owner's Gmail). Only companies WITH an e-mail, only NEW ones
-- (registered ≤ max_age_days), every address contacted at most once.

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'krs' check (source in ('krs', 'ceidg', 'manual')),
  ext_id text not null,                    -- KRS number / NIP
  name text not null,
  legal_form text,
  registered_at date,
  city text, voivodeship text, address text,
  email text not null,
  website text, phone text,
  nip text, regon text, capital text,
  pkd_code text, pkd_desc text, pkd_other jsonb not null default '[]'::jsonb,
  board jsonb not null default '[]'::jsonb, -- [{role, initials, decade}] (KRS masks names)
  owner_name text,                          -- CEIDG gives the full name
  industry text,                            -- our bucket (beauty, gastro, …)
  fit_score int,                            -- 0–100 by Claude
  fit_reason text,
  subject text, body text,                  -- editable draft
  status text not null default 'raw' check (status in ('raw', 'scored', 'ready', 'sent', 'skipped', 'failed', 'rejected')),
  composed_at timestamptz, decided_at timestamptz, sent_at timestamptz,
  resend_id text, error text,
  crm_client_id uuid,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, ext_id)
);
create unique index if not exists leads_email_uniq on public.leads (lower(email));
create index if not exists leads_status_idx on public.leads (status, fit_score desc);
alter table public.leads enable row level security;
drop policy if exists leads_auth_all on public.leads;
create policy leads_auth_all on public.leads for all to authenticated using (true) with check (true);

create or replace function public.leads_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads for each row execute function public.leads_touch();

-- Registry numbers already looked at (so the harvester never re-fetches them).
create table if not exists public.lead_seen (
  source text not null, ext_id text not null, seen_at timestamptz not null default now(),
  primary key (source, ext_id)
);
alter table public.lead_seen enable row level security;

-- Never e-mail again: opt-outs ("NIE"), bounces, manual blocks, everyone already contacted.
create table if not exists public.lead_suppression (
  email text primary key, reason text, created_at timestamptz not null default now()
);
alter table public.lead_suppression enable row level security;
drop policy if exists lead_suppression_auth_all on public.lead_suppression;
create policy lead_suppression_auth_all on public.lead_suppression for all to authenticated using (true) with check (true);

-- Cron: one idempotent "tick" every 10 min (harvest → score → compose until
-- today's quota is ready). Secret from Vault; the edge function checks it.
select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'leads_cron_secret', 'pg_cron → edge leads')
where not exists (select 1 from vault.secrets where name = 'leads_cron_secret');

select cron.unschedule(jobname) from cron.job where jobname = 'leads-tick';
select cron.schedule('leads-tick', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://yhtzxkhfqzuaafvappln.supabase.co/functions/v1/leads',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='leads_cron_secret' limit 1)),
    body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 150000)
$$);
