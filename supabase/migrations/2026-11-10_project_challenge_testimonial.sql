-- Audit 2026-11-10: each case states the client's task up front (above the
-- tech list) and can carry a client testimonial. Home hero shows one case,
-- chosen in admin → Strona (site_settings.hero_case.value_meta.slug).
alter table public.projects
  add column if not exists challenge_pl text,
  add column if not exists challenge_en text,
  add column if not exists challenge_ru text,
  add column if not exists testimonial_pl text,
  add column if not exists testimonial_en text,
  add column if not exists testimonial_ru text,
  add column if not exists testimonial_author text;

insert into public.site_settings (key, value_meta)
values ('hero_case', '{"slug":"mercedes-maybach-autoforum"}'::jsonb)
on conflict (key) do nothing;
