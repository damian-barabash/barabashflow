# BarabashFlow mail poller — GitHub Actions

Заменяет Cloudflare Worker (который не работал — Hostinger mail-сервера живут на CF IP'шниках, а CF Workers блокирует исходящие к CF). GitHub Actions запускается на Azure-runner'ах — они могут коннектиться к Hostinger без проблем.

## Что нужно сделать один раз

### 1. Удалить CF Worker (cleanup)

В CF dashboard → Workers & Pages → `barabashflow-mail` → Manage → **Delete**.

### 2. Добавить 2 GitHub Secrets

Открой:
```
https://github.com/damian-barabash/barabashflow/settings/secrets/actions
```

→ **New repository secret** ×2:

| Name                  | Value                                                              |
|-----------------------|--------------------------------------------------------------------|
| `HOSTINGER_PASSWORD`  | `Qazxplmn_12` (пароль от office@barabashflow.pl на Hostinger)      |
| `MAIL_INGEST_SECRET`  | `f8decec903c4f32dd11a6238db1cf3eec80b82b34cbf93d28834b8c81ce8333f` |

### 3. Включить Actions (если выключены)

`Settings → Actions → General → Allow all actions and reusable workflows` → Save.

### 4. Запушить + триггернуть первый раз вручную

```bash
git add .github/workflows/mail-poll.yml mail-poll/
git commit -m "Add GitHub Actions mail poller (replaces blocked CF Worker)"
git push
```

После push → открой `https://github.com/damian-barabash/barabashflow/actions` → **Mail poll** → **Run workflow** → выбрать ветку `main` → Run workflow.

Через ~30 секунд job завершится. Логи: клик по run → step «Poll IMAP and ingest» — видно `[poll] state lastSeen=0 → new uids: N → ingested N`. Дальше каждые 5 минут крутится автоматически.

## Как проверить

- **GitHub Actions logs** — см. выше
- **Supabase `imap_state`** — обновляется `last_poll_at` (через меня могу запросить)
- **Mejle → Skrzynka** — должны появиться письма

## Лимиты

- GH Actions free на public-репо: **бесконечно**
- Cron минимум: 5 минут
- GH иногда задерживает cron на 5-15 мин под нагрузкой (не критично для inbox)
- Workflow отключается если 60 дней без push'ей — re-enable вручную

## Альтернативный ручной запуск

В любой момент в Actions → Mail poll → Run workflow.
