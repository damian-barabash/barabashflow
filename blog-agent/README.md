# Blog agent (Mac Studio)

Wersjonowana kopia workera bloga. **Żywa kopia działa na Mac Studio**
(`work@barabash-ai:~/blog-agent/blog-writer.ts`, launchd `ai.barabash.blogwriter`,
przebiegi 08:40 i 13:40 — drugi to idempotentny catch-up). Po zmianie tutaj
wgraj plik na Mac Studio (`scp blog-agent/blog-writer.ts work@barabash-ai:blog-agent/`).
`config.json` (sekrety: edge secret, GitHub PAT) istnieje TYLKO na Mac Studio.
