# Blog agent v2 (Mac Studio)

Wersjonowana kopia generatora bloga. **Żywa kopia działa na Mac Studio**
(`work@barabash-ai:~/blog-agent/`), launchd `ai.barabash.blogwriter`
(plik `ai.barabash.blogwriter.plist` — co 3 h + przy starcie/wybudzeniu).

## Jak to działa (od 2026-11-16)

```
Mac Studio (co 3 h, idempotentnie)            Supabase (chmura)
  blog-writer.ts                                pg_cron 06:00 UTC  blog_publish_due()
   1. naprawa zaplanowanych (zdjęcia/tłum.)        → 1 wpis scheduled → published
   2. plan tematów (blog_topics ≥ 12, Claude)      → repository_dispatch → GH Pages build
   3. dopóki bufor < 7 dni (max 2 na przebieg):  pg_cron 06:40 / 09:30 UTC  watchdog
      temat → artykuł (Claude Opus) → QA →         → czy wpis działa na żywo? jak nie: rebuild
      EN/RU → Unsplash (1 wyszukiwanie,            → bufor < 3? generator milczy > 26 h?
      Claude vision wybiera zdjęcia) →               PAT wygasa? → e-mail (Resend)
      blog_posts status=scheduled
   4. report_status → site_settings.blog_agent_status (admin + heartbeat)
```

- Publikacja nie zależy od Maca: padnięty Mac = 7 dni zapasu w buforze, a strażnik alarmuje po 26 h ciszy.
- Zdjęcia: Unsplash hotlink (wymóg API) + atrybucja + `download_location`. Limit demo 50 zapytań/h.
- Kalkulator wyceny w każdym wpisie: `src/components/Estimator.astro`, model `src/lib/estimate-model.ts`, komentarz AI: edge `estimate`.

## Pliki

- `lib.ts` — Supabase REST (service role, retry), Claude (JSON schema), Unsplash, wybór zdjęć.
- `blog-writer.ts` — generator (patrz wyżej).
- `backfill-images.ts` — jednorazowo: zdjęcia Unsplash dla starych wpisów (wznawialny).
- `config.json` — TYLKO na Mac Studio (chmod 600): supabaseUrl, serviceKey, anthropicKey, unsplashKey, edgeUrl, secret, bufferDays, maxPerRun.
- `v1-archive/` na Macu — stara wersja (Ollama + Google Autosuggest).

## Wdrożenie zmian

```bash
scp blog-agent/{lib.ts,blog-writer.ts,backfill-images.ts,package.json} work@barabash-ai:blog-agent/
ssh work@barabash-ai 'cd ~/blog-agent && ~/.bun/bin/bun install'
# plist:
scp blog-agent/ai.barabash.blogwriter.plist work@barabash-ai:Library/LaunchAgents/
ssh work@barabash-ai 'launchctl unload ~/Library/LaunchAgents/ai.barabash.blogwriter.plist; launchctl load ~/Library/LaunchAgents/ai.barabash.blogwriter.plist'
```
