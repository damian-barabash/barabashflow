-- 2026-09-12 — site redesign (agenio-style), CMS/CRM rework, mail removal.
-- Applied to prod via the management API on 2026-09-12. Kept here as the
-- record of what changed.
--
--  * projects: case-study fields (client, year, services, results, long body,
--    tagline, featured flag, explicit cover). Graph positions and
--    project_connections are gone — the public graph was removed.
--  * services / faq_items: new CMS collections (public read when published).
--  * contact_submissions: richer form (phone/company/budget/service/page) +
--    archive flag + admin note. No e-mail integration — enquiries are read
--    in the admin panel, replies go out from Gmail.
--  * crm_clients: pipeline status + next action + deal value; crm_activities
--    timeline (notes / calls / e-mails / meetings / status changes).
--  * mail_* tables, imap_state, the mail-refresh pg_cron job and the mail
--    vault secrets are dropped (backup: PROJEKTY/DMYTRII FLOW/backup-mail-2026-09-12/).

begin;

-- ── projects ────────────────────────────────────────────────────────────────
alter table public.projects
  add column if not exists client        text,
  add column if not exists year          integer,
  add column if not exists services      text[]  not null default '{}',
  add column if not exists stack         text[]  not null default '{}',
  add column if not exists tagline_pl    text,
  add column if not exists tagline_en    text,
  add column if not exists tagline_ru    text,
  add column if not exists body_pl       text,
  add column if not exists body_en       text,
  add column if not exists body_ru       text,
  add column if not exists results       jsonb   not null default '[]'::jsonb,
  add column if not exists is_featured   boolean not null default false,
  add column if not exists cover_path    text;

comment on column public.projects.results is
  'Case-study metrics shown on cards: [{"value":"+35%","label_pl":"…","label_en":"…","label_ru":"…"}]';
comment on column public.projects.services is
  'Service slugs (public.services.slug) this project belongs to — drives the filter on /projekty/.';

drop table if exists public.project_connections;
alter table public.projects drop column if exists position_x;
alter table public.projects drop column if exists position_y;

-- ── services ────────────────────────────────────────────────────────────────
create table if not exists public.services (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  title_pl       text not null,
  title_en       text,
  title_ru       text,
  tagline_pl     text,
  tagline_en     text,
  tagline_ru     text,
  description_pl text,
  description_en text,
  description_ru text,
  bullets_pl     text[] not null default '{}',
  bullets_en     text[] not null default '{}',
  bullets_ru     text[] not null default '{}',
  price_from     text,
  icon           text,
  cover_path     text,
  sort_order     integer not null default 0,
  is_published   boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.services enable row level security;
drop policy if exists services_public_read on public.services;
create policy services_public_read on public.services for select to anon, authenticated using (is_published);
drop policy if exists services_auth_all on public.services;
create policy services_auth_all on public.services for all to authenticated using (true) with check (true);
drop trigger if exists services_touch_updated_at on public.services;
create trigger services_touch_updated_at before update on public.services
  for each row execute function public.touch_updated_at();

-- ── faq_items ───────────────────────────────────────────────────────────────
create table if not exists public.faq_items (
  id           uuid primary key default gen_random_uuid(),
  placement    text not null default 'home',   -- 'home' | 'service:<slug>' | 'contact'
  question_pl  text not null,
  question_en  text,
  question_ru  text,
  answer_pl    text not null,
  answer_en    text,
  answer_ru    text,
  sort_order   integer not null default 0,
  is_published boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.faq_items enable row level security;
drop policy if exists faq_public_read on public.faq_items;
create policy faq_public_read on public.faq_items for select to anon, authenticated using (is_published);
drop policy if exists faq_auth_all on public.faq_items;
create policy faq_auth_all on public.faq_items for all to authenticated using (true) with check (true);
drop trigger if exists faq_touch_updated_at on public.faq_items;
create trigger faq_touch_updated_at before update on public.faq_items
  for each row execute function public.touch_updated_at();

-- ── contact_submissions ─────────────────────────────────────────────────────
alter table public.contact_submissions
  add column if not exists phone        text,
  add column if not exists company      text,
  add column if not exists budget       text,
  add column if not exists service      text,
  add column if not exists page         text,
  add column if not exists locale       text,
  add column if not exists is_archived  boolean not null default false,
  add column if not exists admin_note   text;
create index if not exists contact_submissions_created_idx on public.contact_submissions (created_at desc);

-- (An e-mail notification trigger via Resend was added and then removed the
--  same day on the owner's request: enquiries are read in the admin panel,
--  correspondence happens in Gmail. No e-mail integration remains.)

-- ── CRM ─────────────────────────────────────────────────────────────────────
alter table public.crm_clients
  add column if not exists status          text not null default 'lead',
  add column if not exists position        text,
  add column if not exists website         text,
  add column if not exists value_pln       numeric(12,2),
  add column if not exists next_action     text,
  add column if not exists next_action_at  date,
  add column if not exists last_contact_at timestamptz;
alter table public.crm_clients drop constraint if exists crm_clients_status_check;
alter table public.crm_clients add constraint crm_clients_status_check
  check (status in ('lead','contact','offer','won','active','done','lost','archive'));
alter table public.crm_clients drop constraint if exists crm_clients_source_check;
alter table public.crm_clients add constraint crm_clients_source_check
  check (source in ('manual','form','website','mascot','inbound','import','referral','linkedin','other'));
create index if not exists crm_clients_status_idx on public.crm_clients (status);
create index if not exists crm_clients_next_action_idx on public.crm_clients (next_action_at);

create table if not exists public.crm_activities (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.crm_clients(id) on delete cascade,
  kind        text not null default 'note',  -- note | call | email | meeting | status | task | file
  body        text,
  meta        jsonb not null default '{}'::jsonb,
  happened_at timestamptz not null default now(),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists crm_activities_client_idx on public.crm_activities (client_id, happened_at desc);
alter table public.crm_activities enable row level security;
drop policy if exists crm_activities_auth_all on public.crm_activities;
create policy crm_activities_auth_all on public.crm_activities for all to authenticated using (true) with check (true);

-- keep last_contact_at fresh from the timeline
create or replace function public.crm_touch_last_contact()
returns trigger language plpgsql as $$
begin
  if new.kind in ('call','email','meeting') then
    update public.crm_clients set last_contact_at = greatest(coalesce(last_contact_at, new.happened_at), new.happened_at)
      where id = new.client_id;
  end if;
  return new;
end $$;
drop trigger if exists crm_activities_touch on public.crm_activities;
create trigger crm_activities_touch after insert on public.crm_activities
  for each row execute function public.crm_touch_last_contact();

-- ── mail infrastructure — removed ───────────────────────────────────────────
do $$ begin
  if exists (select 1 from cron.job where jobname = 'mail-refresh-1min') then
    perform cron.unschedule('mail-refresh-1min');
  end if;
end $$;
drop table if exists public.mail_outbound;
drop table if exists public.mail_inbound;
drop table if exists public.mail_templates;
drop table if exists public.imap_state;
delete from vault.secrets where name in ('hostinger_office_password', 'mail_ingest_secret', 'mail_refresh_cron_secret');

commit;

-- ── addendum (same day): enquiry reference shown on the "receipt" animation
-- and in the admin inbox; generated client-side (BF-XXXXXX) because anon
-- inserts cannot read the row back under RLS.
alter table public.contact_submissions add column if not exists ref text;
create index if not exists contact_submissions_ref_idx on public.contact_submissions(ref);
