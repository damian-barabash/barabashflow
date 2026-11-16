-- AI cost control (2026-11-16): every Claude call (blog generator on the Mac,
-- edge `leads`, edge `estimate`) logs tokens + cost here; callers check the
-- current month's spend against site_settings.ai_budget.monthly_usd (admin)
-- before non-essential work. Prices per 1M tokens (in/out) as of 2026-11:
-- opus-5-5 4/20, sonnet-5-5 2/10, haiku-5-5 0.10/0.50.
create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  feature text not null,          -- blog-write, blog-translate, leads-compose, estimate…
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(10,5) not null default 0
);
create index if not exists ai_usage_ts_idx on public.ai_usage (ts desc);
alter table public.ai_usage enable row level security;
drop policy if exists ai_usage_auth_read on public.ai_usage;
create policy ai_usage_auth_read on public.ai_usage for select to authenticated using (true);

create or replace function public.ai_month_spend()
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(cost_usd), 0) from ai_usage
  where ts >= date_trunc('month', now() at time zone 'Europe/Warsaw') at time zone 'Europe/Warsaw'
    and feature not like 'setup%';  -- one-off setup costs don't eat the running budget
$$;
grant execute on function public.ai_month_spend() to authenticated, service_role;

insert into site_settings (key, value_meta) values ('ai_budget', '{"monthly_usd": 15}'::jsonb)
on conflict (key) do nothing;

-- One-off setup costs on 2026-11-16 (corpus audit, first articles, tests) — estimated from logged usage.
insert into ai_usage (feature, model, input_tokens, output_tokens, cost_usd) values ('setup-2026-11-16', 'mixed', 0, 0, 5.40);
