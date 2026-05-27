// ════════════════════════════════════════════════════════════════════════════
// BarabashFlow mail poller (GitHub Actions cron job)
// ────────────────────────────────────────────────────────────────────────────
// Runs every 5 min from GitHub Actions (Azure-based runners — NOT Cloudflare
// IPs — so it can actually reach Hostinger's mail servers).
// 1. GET /state from Supabase to learn last_seen_uid
// 2. IMAP LOGIN to office@barabashflow.pl
// 3. Fetch every UID > last_seen with BODY.PEEK[] (doesn't mark seen)
// 4. Parse MIME with mailparser
// 5. POST each parsed e-mail to Supabase mail-ingest Edge Function
// 6. POST new last_seen_uid back to /state
// ════════════════════════════════════════════════════════════════════════════

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const {
  MAIL_INGEST_URL,
  MAIL_INGEST_SECRET,
  HOSTINGER_EMAIL,
  HOSTINGER_PASSWORD,
  IMAP_HOST,
  IMAP_PORT,
} = process.env;

const required = { MAIL_INGEST_URL, MAIL_INGEST_SECRET, HOSTINGER_EMAIL, HOSTINGER_PASSWORD, IMAP_HOST, IMAP_PORT };
for (const [k, v] of Object.entries(required)) {
  if (!v) {
    console.error(`[poll] missing env var: ${k}`);
    process.exit(1);
  }
}

const startedAt = Date.now();
let stage = 'start';
let client = null;

try {
  // ── 1. Fetch state ────────────────────────────────────────────────────
  stage = 'state-fetch';
  const stateRes = await fetch(`${MAIL_INGEST_URL}/state?folder=INBOX`, {
    headers: { 'x-mail-ingest-secret': MAIL_INGEST_SECRET },
  });
  if (!stateRes.ok) throw new Error(`state fetch ${stateRes.status}: ${await stateRes.text()}`);
  const state = await stateRes.json();
  const lastSeen = Number(state.last_seen_uid) || 0;
  console.log(`[poll] state lastSeen=${lastSeen}`);

  // ── 2. Connect IMAP ───────────────────────────────────────────────────
  stage = 'imap-connect';
  client = new ImapFlow({
    host: IMAP_HOST,
    port: Number(IMAP_PORT),
    secure: true,
    auth: { user: HOSTINGER_EMAIL, pass: HOSTINGER_PASSWORD },
    logger: false,
  });
  await client.connect();
  console.log('[poll] imap connected');

  // ── 3. Open INBOX and search new UIDs ────────────────────────────────
  stage = 'imap-search';
  const lock = await client.getMailboxLock('INBOX');
  let newUids = [];
  try {
    const searched = await client.search({ uid: `${lastSeen + 1}:*` }, { uid: true });
    newUids = (searched || []).filter((u) => u > lastSeen).sort((a, b) => a - b);
    console.log(`[poll] new uids: ${newUids.length}`);

    // ── 4. Fetch + parse + POST each ────────────────────────────────────
    stage = 'imap-fetch';
    let newMax = lastSeen;
    let okCount = 0;
    let errCount = 0;

    for (const uid of newUids) {
      try {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg?.source) {
          console.warn(`[poll] uid ${uid}: no source`);
          continue;
        }
        const parsed = await simpleParser(msg.source);

        const refs = parsed.references
          ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
          : [];

        const rawHeaders = {};
        for (const [k, v] of parsed.headers.entries()) {
          rawHeaders[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }

        const payload = {
          from_email:  parsed.from?.value?.[0]?.address ?? 'unknown@unknown',
          from_name:   parsed.from?.value?.[0]?.name ?? null,
          to_email:    parsed.to?.value?.[0]?.address ?? HOSTINGER_EMAIL,
          subject:     parsed.subject || '(no subject)',
          body_html:   parsed.html || null,
          body_text:   parsed.text || null,
          message_id:  parsed.messageId || null,
          in_reply_to: parsed.inReplyTo || null,
          refs,
          attachments: (parsed.attachments || []).map((a) => ({
            filename: a.filename || null,
            mimeType: a.contentType || null,
            size: a.size || 0,
          })),
          raw_headers: rawHeaders,
          received_at: parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString(),
        };

        const r = await fetch(MAIL_INGEST_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mail-ingest-secret': MAIL_INGEST_SECRET,
          },
          body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error(`ingest ${r.status}: ${await r.text()}`);

        okCount++;
        if (uid > newMax) newMax = uid;
        console.log(`[poll] uid ${uid}: ingested (${payload.from_email})`);
      } catch (err) {
        errCount++;
        console.error(`[poll] uid ${uid} fail:`, err?.message ?? err);
      }
    }

    // ── 5. Save state ──────────────────────────────────────────────────
    stage = 'state-update';
    await fetch(`${MAIL_INGEST_URL}/state`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mail-ingest-secret': MAIL_INGEST_SECRET,
      },
      body: JSON.stringify({ folder: 'INBOX', last_seen_uid: newMax }),
    });

    console.log(`[poll] done fetched=${newUids.length} ok=${okCount} err=${errCount} newMax=${newMax} elapsed=${Date.now() - startedAt}ms`);
  } finally {
    lock.release();
  }

  await client.logout();
  process.exit(0);
} catch (err) {
  const msg = String(err?.message ?? err);
  console.error(`[poll] FAILED at stage=${stage}:`, msg);
  // Best-effort: surface the failure into imap_state.last_error so it shows up in Supabase too
  try {
    await fetch(`${MAIL_INGEST_URL}/state`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mail-ingest-secret': MAIL_INGEST_SECRET,
      },
      body: JSON.stringify({ folder: 'INBOX', last_error: `[${stage}] ${msg.slice(0, 460)}` }),
    });
  } catch (e) {
    console.error('[poll] state update also failed:', e?.message ?? e);
  }
  try { await client?.logout(); } catch {}
  process.exit(1);
}
