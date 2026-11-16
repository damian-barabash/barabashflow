-- Blog v2 (2026-11-16): buffered editorial pipeline + cleanup + estimator.
--
-- Why: the agent died on 2026-11-15/16 with "no usable topics" — 269 posts
-- written from Google Autosuggest had exhausted the niche (and dragged in
-- brand/off-topic junk). New model:
--   * generation (Mac Studio, Claude) fills a BUFFER of `scheduled` posts days
--     ahead from a curated topic queue (`blog_topics`);
--   * publication is cloud-only: pg_cron flips exactly one due post per day to
--     `published` and dispatches the GitHub Pages rebuild;
--   * a watchdog (edge `blog-ingest` action `watchdog`) verifies the post is
--     live, re-dispatches once, and alerts on low buffer / stale generator.
--   * removed posts become `archived` + a row in `blog_redirects` (build emits
--     redirect pages), nothing is hard-deleted.

-- ── blog_posts ──────────────────────────────────────────────────────────────
alter table public.blog_posts drop constraint if exists blog_posts_status_check;
alter table public.blog_posts add constraint blog_posts_status_check
  check (status = any (array['draft','scheduled','published','archived']));

alter table public.blog_posts
  add column if not exists scheduled_for timestamptz,
  -- [{role:'cover'|'inline', slot, after_h2, id, url, width, height, color,
  --   blur_hash, alt_pl, alt_en, alt_ru, author, author_url, page_url}]
  add column if not exists images jsonb not null default '[]'::jsonb,
  -- estimator placement (index of the H2 it follows); null = auto
  add column if not exists estimator_after_h2 int,
  add column if not exists pillar text,
  add column if not exists format text,
  add column if not exists topic_id uuid;

create index if not exists blog_posts_sched_idx on public.blog_posts (status, scheduled_for);

-- ── redirects for archived posts ────────────────────────────────────────────
create table if not exists public.blog_redirects (
  from_slug text primary key,
  to_path text not null,               -- '/blog/<slug>/' or '/blog/'
  reason text,
  created_at timestamptz not null default now()
);
alter table public.blog_redirects enable row level security;
drop policy if exists blog_redirects_public_read on public.blog_redirects;
create policy blog_redirects_public_read on public.blog_redirects for select to anon, authenticated using (true);
drop policy if exists blog_redirects_auth_all on public.blog_redirects;
create policy blog_redirects_auth_all on public.blog_redirects for all to authenticated using (true) with check (true);

-- ── topic queue (editorial plan) ────────────────────────────────────────────
create table if not exists public.blog_topics (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,80}$'),
  primary_keyword text,
  pillar text,
  format text,
  angle text,
  notes jsonb not null default '{}'::jsonb,
  priority int not null default 0,     -- admin "own topics" get 10
  status text not null default 'queued' check (status in ('queued','writing','used','rejected')),
  source text not null default 'planner', -- planner | admin | seed
  post_id uuid,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
alter table public.blog_topics enable row level security;
drop policy if exists blog_topics_auth_all on public.blog_topics;
create policy blog_topics_auth_all on public.blog_topics for all to authenticated using (true) with check (true);

-- ── estimator AI call log (rate limiting of the public edge endpoint) ───────
create table if not exists public.estimate_calls (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  ok boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists estimate_calls_ip_idx on public.estimate_calls (ip_hash, created_at desc);
alter table public.estimate_calls enable row level security; -- service role only

-- ── publication: one due post per run → rebuild ─────────────────────────────
create or replace function public.blog_publish_due()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_slug text;
  v_pat text;
  v_req bigint;
begin
  -- Never publish two posts on one calendar day (Warsaw), even after an outage
  -- left several overdue — the buffer just shifts, the cadence stays daily.
  if exists (
    select 1 from blog_posts
    where status = 'published'
      and (published_at at time zone 'Europe/Warsaw')::date = (now() at time zone 'Europe/Warsaw')::date
  ) then
    return jsonb_build_object('ok', true, 'published', null, 'note', 'already published today');
  end if;

  update blog_posts
     set status = 'published', published_at = now()
   where id = (
     select id from blog_posts
      where status = 'scheduled' and scheduled_for <= now() and cover_path is not null
      order by scheduled_for, created_at
      limit 1
      for update skip locked)
  returning slug into v_slug;

  if v_slug is null then
    return jsonb_build_object('ok', true, 'published', null, 'note', 'nothing due');
  end if;

  select decrypted_secret into v_pat from vault.decrypted_secrets where name = 'github_pat' limit 1;
  if v_pat is not null then
    select net.http_post(
      url := 'https://api.github.com/repos/damian-barabash/barabashflow/dispatches',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_pat,
        'Accept', 'application/vnd.github+json',
        'User-Agent', 'barabashflow-pg-cron',
        'Content-Type', 'application/json'),
      body := jsonb_build_object('event_type', 'blog-publish', 'client_payload', jsonb_build_object('slug', v_slug)),
      timeout_milliseconds := 20000
    ) into v_req;
  end if;

  return jsonb_build_object('ok', true, 'published', v_slug, 'dispatch_request', v_req);
end;
$$;
revoke all on function public.blog_publish_due() from public, anon, authenticated;

-- ── schedules ───────────────────────────────────────────────────────────────
-- 06:00 UTC (07:00/08:00 Warsaw): publish one due post + rebuild.
-- 06:40 / 09:30 UTC: watchdog (live check → re-dispatch; buffer; heartbeat).
select cron.unschedule(jobname) from cron.job where jobname in ('blog-publish-daily','blog-watchdog-1','blog-watchdog-2');
select cron.schedule('blog-publish-daily', '0 6 * * *', $$select public.blog_publish_due()$$);
select cron.schedule('blog-watchdog-1', '40 6 * * *', $$
  select net.http_post(
    url := 'https://yhtzxkhfqzuaafvappln.supabase.co/functions/v1/blog-ingest',
    headers := jsonb_build_object('Content-Type','application/json','x-blog-secret',(select decrypted_secret from vault.decrypted_secrets where name='blog_ingest_secret' limit 1)),
    body := '{"action":"watchdog"}'::jsonb, timeout_milliseconds := 60000)
$$);
select cron.schedule('blog-watchdog-2', '30 9 * * *', $$
  select net.http_post(
    url := 'https://yhtzxkhfqzuaafvappln.supabase.co/functions/v1/blog-ingest',
    headers := jsonb_build_object('Content-Type','application/json','x-blog-secret',(select decrypted_secret from vault.decrypted_secrets where name='blog_ingest_secret' limit 1)),
    body := '{"action":"watchdog","final":true}'::jsonb, timeout_milliseconds := 60000)
$$);

-- ── admin actions (authenticated = the site owner) ──────────────────────────
-- Rebuild GitHub Pages now (e.g. after changing calculator settings).
create or replace function public.site_rebuild(p_reason text default 'admin')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_pat text; v_req bigint;
begin
  if auth.role() <> 'authenticated' then raise exception 'forbidden'; end if;
  select decrypted_secret into v_pat from vault.decrypted_secrets where name = 'github_pat' limit 1;
  if v_pat is null then return jsonb_build_object('ok', false, 'error', 'brak github_pat w Vault'); end if;
  select net.http_post(
    url := 'https://api.github.com/repos/damian-barabash/barabashflow/dispatches',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_pat, 'Accept', 'application/vnd.github+json', 'User-Agent', 'barabashflow-admin', 'Content-Type', 'application/json'),
    body := jsonb_build_object('event_type', 'blog-publish', 'client_payload', jsonb_build_object('by', left(coalesce(p_reason, 'admin'), 60))),
    timeout_milliseconds := 20000) into v_req;
  return jsonb_build_object('ok', true, 'request', v_req);
end; $$;
revoke all on function public.site_rebuild(text) from public, anon;
grant execute on function public.site_rebuild(text) to authenticated;

-- Publish a queued post right now (outside the daily cadence) + rebuild.
create or replace function public.blog_publish_now(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_slug text;
begin
  if auth.role() <> 'authenticated' then raise exception 'forbidden'; end if;
  update blog_posts set status = 'published', published_at = now(), scheduled_for = now()
   where id = p_id and status in ('scheduled', 'draft') and cover_path is not null
  returning slug into v_slug;
  if v_slug is null then return jsonb_build_object('ok', false, 'error', 'wpis nie istnieje, jest już opublikowany albo nie ma jeszcze zdjęć'); end if;
  perform public.site_rebuild('publish-now ' || v_slug);
  return jsonb_build_object('ok', true, 'slug', v_slug);
end; $$;
revoke all on function public.blog_publish_now(uuid) from public, anon;
grant execute on function public.blog_publish_now(uuid) to authenticated;
