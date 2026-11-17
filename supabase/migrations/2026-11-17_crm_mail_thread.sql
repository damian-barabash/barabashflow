-- CRM correspondence (2026-11-17)
--  * Client replies arrive at <tag>@reply.barabashflow.pl (Resend Receiving,
--    MX on the subdomain only, root mail stays on Hostinger) → webhook → edge
--    `mail-in` → crm_activities kind 'email', meta.dir = 'in'.
--  * Outgoing mail from the CRM card / lead offers → meta.dir = 'out' with our
--    own Message-ID so replies thread correctly.
--  * Vault secret `resend_inbound_webhook_secret` (whsec_…) is inserted
--    separately (not in git).

begin;

-- one activity per received e-mail (webhook retries are idempotent)
create unique index if not exists crm_activities_inbound_uq
  on public.crm_activities ((meta->>'inbound_id')) where meta ? 'inbound_id';
-- lookup of our outgoing Message-IDs when a reply comes in
create index if not exists crm_activities_msgid_idx
  on public.crm_activities ((meta->>'message_id')) where meta ? 'message_id';

alter table public.leads
  add column if not exists replied_at timestamptz,
  add column if not exists reply_count integer not null default 0;

-- inbound e-mail without any match creates a client with source 'inbound'
-- (already allowed by crm_clients_source_check since 2026-09-12)

commit;

-- short per-client tag for the reply address office+<tag>@reply.barabashflow.pl
alter table public.crm_clients
  add column if not exists mail_tag text not null default substr(md5(gen_random_uuid()::text), 1, 10);
create unique index if not exists crm_clients_mail_tag_uq on public.crm_clients (mail_tag);
