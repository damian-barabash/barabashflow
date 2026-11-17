// Edge `mail-in` (verify_jwt: false) — CRM correspondence.
//
// 1. Resend webhook (Svix-signed, secret in Vault resend_inbound_webhook_secret):
//    • email.received — a client replied to office+<mail_tag>@reply.barabashflow.pl
//      (MX of the subdomain → Resend Receiving; root mail stays on Hostinger).
//      Full message is fetched from the API, matched to a CRM client (tag →
//      sender address → In-Reply-To of our Message-ID → new client), saved as
//      crm_activities kind 'email' meta.dir 'in' (+ attachments → crm-files),
//      the lead gets replied_at, "NIE" = opt-out, and a short notification goes
//      to leads_config.notify_email (owner's Gmail) unless it is empty.
//    • email.bounced / email.complained — for our outgoing mail: suppression +
//      note in the client's timeline.
// 2. action "send" (admin JWT) — reply / new e-mail from the CRM card: from
//    office@barabashflow.pl, Reply-To = the client's reply address, our own
//    Message-ID + In-Reply-To/References → threads in the client's mailbox.
// 3. action "status" (admin JWT) — is the reply domain verified yet.
import { createClient } from 'npm:@supabase/supabase-js@2';

const REPLY_DOMAIN = 'reply.barabashflow.pl';
const REPLY_DOMAIN_ID = '019a6899-eb09-49a8-b170-3176eda0d0eb';
const ADMIN_URL = 'https://barabashflow.pl/admin/#crm';
const OWNER_GMAIL = 'dmytrii.barabash@gmail.com';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Owner's rule: never an em/en dash in e-mails (same as edge `leads`).
const noDash = (t: string) => String(t ?? '')
  .replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2')
  .replace(/[ \t]+[—–][ \t]+/g, ', ')
  .replace(/[—–]/g, '-');
const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
export const replyAddress = (tag: string) => `office+${tag}@${REPLY_DOMAIN}`;
const parseAddr = (s: string) => {
  const m = String(s || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: m[2].trim().toLowerCase() } : { name: '', email: String(s || '').trim().toLowerCase() };
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const raw = await req.text();

  // ── Resend webhook ──
  if (req.headers.get('svix-id')) {
    const { data: secret } = await svc.rpc('get_secret', { p_name: 'resend_inbound_webhook_secret' });
    if (!secret || !(await verifySvix(String(secret), req.headers, raw))) return json({ error: 'bad signature' }, 401);
    let ev: any = {};
    try { ev = JSON.parse(raw); } catch { return json({ error: 'invalid json' }, 400); }
    try {
      if (ev.type === 'email.received') return json(await onReceived(svc, ev.data || {}));
      if (ev.type === 'email.bounced' || ev.type === 'email.complained') return json(await onBounce(svc, ev));
      return json({ ok: true, ignored: ev.type });
    } catch (e) {
      console.error('[mail-in]', ev.type, e);
      return json({ error: String((e as any)?.message || e) }, 500); // Resend retries
    }
  }

  // ── admin actions ──
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u } = await svc.auth.getUser(jwt);
  if (!u?.user) return json({ error: 'unauthorized' }, 401);
  let body: any = {};
  try { body = JSON.parse(raw || '{}'); } catch { /* empty */ }
  try {
    if (body.action === 'status') return json({ ok: true, ready: await inboxReady(svc), domain: REPLY_DOMAIN });
    if (body.action === 'send') return json(await sendFromCrm(svc, body));
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    console.error('[mail-in] send', e);
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});

// ── Svix signature: HMAC-SHA256(base64(secret after whsec_), `${id}.${ts}.${body}`) ──
async function verifySvix(secret: string, h: Headers, payload: string) {
  const id = h.get('svix-id') || '', ts = h.get('svix-timestamp') || '', sig = h.get('svix-signature') || '';
  if (!id || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 600) return false;
  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${payload}`)));
  const expected = btoa(String.fromCharCode(...mac));
  return sig.split(' ').some((p) => p.split(',')[1] === expected);
}

const rkey = async (svc: any) => (await svc.rpc('get_secret', { p_name: 'resend_api_key' })).data as string;
async function resend(svc: any, path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.resend.com${path}`, { ...init, headers: { Authorization: `Bearer ${await rkey(svc)}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend ${path} HTTP ${r.status}: ${j?.message || ''}`);
  return j;
}

let readyCache: { at: number; ok: boolean } | null = null;
export async function inboxReady(svc: any) {
  if (readyCache && Date.now() - readyCache.at < 5 * 60_000) return readyCache.ok;
  try {
    const d = await resend(svc, `/domains/${REPLY_DOMAIN_ID}`);
    const mx = (d.records || []).find((r: any) => r.record === 'Receiving');
    readyCache = { at: Date.now(), ok: (mx?.status || d.status) === 'verified' };
  } catch { readyCache = { at: Date.now(), ok: false }; }
  return readyCache.ok;
}

async function leadsCfg(svc: any) {
  const { data } = await svc.from('site_settings').select('value_meta').eq('key', 'leads_config').maybeSingle();
  return { notify_email: OWNER_GMAIL, signature: 'Damian Barabash\nBarabashFlow · strony, sklepy i platformy na zamówienie\nbarabashflow.pl', from_name: 'Damian Barabash', from_email: 'office@barabashflow.pl', ...(data?.value_meta || {}) };
}

// Cut the quoted history from a reply ("W dniu … napisał:", "On … wrote:", "> …").
export function stripQuote(text: string) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const two = `${l} ${lines[i + 1] || ''}`;
    if (/^\s*>/.test(l)) break;
    if (/^-{2,}\s*(Original Message|Wiadomość oryginalna|Oryginalna wiadomość|Исходное сообщение)/i.test(l)) break;
    if (/^\s*(W dniu|On|Dnia|Am|Le|В)\b.{4,200}(napisał|napisała|napisał\(a\)|wrote|schrieb|a écrit|пишет|написал)/i.test(two) && /(napisał|wrote|schrieb|écrit|пишет|написал)/i.test(two)) break;
    if (/^\s*(Od|From|Von):\s/i.test(l) && /^\s*(Wysłane|Sent|Data|Date|Gesendet):\s/i.test(lines[i + 1] || '') ) break;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
const htmlToText = (html: string) => String(html || '')
  .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|h\d|li|blockquote)>/gi, '\n')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const hdr = (headers: any, name: string) => {
  if (!headers) return '';
  const k = Object.keys(headers).find((x) => x.toLowerCase() === name);
  const v = k ? headers[k] : '';
  return Array.isArray(v) ? v.join(' ') : String(v || '');
};

// ── inbound ──
async function onReceived(svc: any, d: any) {
  const id = String(d.email_id || '');
  if (!id) return { ok: false, error: 'no email_id' };
  const { data: dup } = await svc.from('crm_activities').select('id').eq('meta->>inbound_id', id).maybeSingle();
  if (dup) return { ok: true, duplicate: true };

  const em = await resend(svc, `/emails/receiving/${id}`);
  const from = parseAddr(em.from || d.from);
  const toList: string[] = [...(em.to || d.to || []), ...(em.received_for || d.received_for || []), ...(em.cc || [])].map(String);
  const tag = toList.map((a) => parseAddr(a).email.match(/^[^+@]+\+([a-z0-9]+)@/i)?.[1]).find(Boolean)?.toLowerCase() || '';
  const inReplyTo = hdr(em.headers, 'in-reply-to').trim();
  const refs = hdr(em.headers, 'references').trim();
  const fullText = (em.text && String(em.text).trim()) || htmlToText(em.html || '');
  const clean = stripQuote(fullText) || fullText.slice(0, 4000);

  // match the client
  let client: any = null, how = '';
  if (tag) { client = (await svc.from('crm_clients').select('*').eq('mail_tag', tag).maybeSingle()).data; how = client ? 'tag' : ''; }
  if (!client && from.email) { client = (await svc.from('crm_clients').select('*').ilike('email', from.email).maybeSingle()).data; how = client ? 'email' : ''; }
  if (!client) {
    const ids = `${inReplyTo} ${refs}`.match(/<[^>]+>/g) || [];
    for (const mid of ids) {
      const { data: act } = await svc.from('crm_activities').select('client_id').eq('meta->>message_id', mid).limit(1).maybeSingle();
      if (act) { client = (await svc.from('crm_clients').select('*').eq('id', act.client_id).maybeSingle()).data; how = 'thread'; break; }
    }
  }
  if (!client) {
    const { data: c, error } = await svc.from('crm_clients').insert({ name: from.name || from.email, email: from.email, source: 'inbound', status: 'lead', tags: ['lead'], next_action: 'Odpowiedzieć na e-mail', next_action_at: new Date().toISOString().slice(0, 10) }).select('*').single();
    if (error) throw error;
    client = c; how = 'new';
  }

  // attachments → private crm-files (best effort)
  const files: any[] = [];
  if ((em.attachments || []).length) {
    let list: any[] = [];
    try { list = (await resend(svc, `/emails/receiving/${id}/attachments`)).data || []; } catch (e) { console.warn('[mail-in] attachments list', e); }
    for (const a of (em.attachments || []).slice(0, 10)) {
      const meta = { filename: a.filename, content_type: a.content_type, size: a.size };
      const dl = list.find((x: any) => x.id === a.id)?.download_url;
      if (dl && (a.size || 0) <= 20 * 1024 * 1024 && a.content_disposition !== 'inline') {
        try {
          const bytes = new Uint8Array(await (await fetch(dl)).arrayBuffer());
          const path = `client/${client.id}/${crypto.randomUUID()}-${String(a.filename || 'plik').replace(/[^\w.\-]+/g, '_')}`;
          const { error } = await svc.storage.from('crm-files').upload(path, bytes, { contentType: a.content_type || 'application/octet-stream' });
          if (!error) { await svc.from('crm_files').insert({ client_id: client.id, storage_path: path, original_name: a.filename || 'plik', mime: a.content_type, size_bytes: bytes.length }); files.push({ ...meta, path }); continue; }
        } catch (e) { console.warn('[mail-in] attachment', e); }
      }
      files.push(meta);
    }
  }

  const when = em.created_at || d.created_at || new Date().toISOString();
  const { error: actErr } = await svc.from('crm_activities').insert({
    client_id: client.id, kind: 'email', body: clean.slice(0, 20000), happened_at: when,
    meta: { dir: 'in', inbound_id: id, from: from.email, from_name: from.name, to: toList, subject: em.subject || d.subject || '', message_id: em.message_id || d.message_id || '', in_reply_to: inReplyTo, references: refs, full_text: fullText.slice(0, 60000), attachments: files, matched_by: how, spam: em.authentication?.spf === 'fail' && em.authentication?.dkim === 'fail' },
  });
  if (actErr) { if (String(actErr.message).includes('crm_activities_inbound_uq')) return { ok: true, duplicate: true }; throw actErr; }

  // pipeline: a reply moves a fresh contact on, and asks for an answer today
  const upd: any = { next_action: 'Odpowiedzieć na e-mail', next_action_at: new Date().toISOString().slice(0, 10) };
  if (client.status === 'lead') upd.status = 'contact';
  await svc.from('crm_clients').update(upd).eq('id', client.id);

  // lead bookkeeping + opt-out
  const optOut = /^\s*(nie|nie\.|nie,? dziękuję\.?|nie dziekuje\.?|no|stop|wypisz|rezygnuję)\s*$/i.test(clean.split('\n')[0] || '') && clean.length < 80;
  const { data: lead } = await svc.from('leads').select('id,reply_count').eq('crm_client_id', client.id).order('sent_at', { ascending: false }).limit(1).maybeSingle();
  if (lead) await svc.from('leads').update({ replied_at: new Date().toISOString(), reply_count: (lead.reply_count || 0) + 1 }).eq('id', lead.id);
  if (optOut) {
    await svc.from('lead_suppression').upsert({ email: from.email, reason: 'optout' }, { onConflict: 'email' });
    await svc.from('crm_clients').update({ status: 'lost', next_action: null, next_action_at: null }).eq('id', client.id);
    await svc.from('crm_activities').insert({ client_id: client.id, kind: 'status', body: 'Odpisał „NIE”, wypisany z ofert' });
  }

  // notify the owner (not a copy of the thread: answer from the CRM card)
  const cfg = await leadsCfg(svc);
  if (cfg.notify_email) {
    const text = `${client.name} odpisał(a)${optOut ? ' (NIE, wypisany)' : ''}.\n\nTemat: ${em.subject || ''}\nOd: ${from.name ? from.name + ' ' : ''}<${from.email}>\n${files.length ? `Załączniki: ${files.map((f) => f.filename).join(', ')}\n` : ''}\n${clean.slice(0, 3000)}\n\nOdpowiedz w karcie klienta (historia zostanie w CRM):\n${ADMIN_URL}`;
    await resend(svc, '/emails', { method: 'POST', body: JSON.stringify({ from: `BarabashFlow CRM <${cfg.from_email}>`, to: [cfg.notify_email], subject: `↩ ${client.name}: ${em.subject || 'odpowiedź'}`, text: noDash(text), tags: [{ name: 'kind', value: 'crm-notify' }] }) }).catch((e) => console.warn('[mail-in] notify', e));
  }
  return { ok: true, client_id: client.id, matched_by: how, opt_out: optOut };
}

async function onBounce(svc: any, ev: any) {
  const d = ev.data || {};
  const sentId = String(d.email_id || '');
  const to = (d.to || []).map((x: string) => parseAddr(x).email);
  const reason = ev.type === 'email.bounced' ? 'bounce' : 'complaint';
  for (const email of to) await svc.from('lead_suppression').upsert({ email, reason }, { onConflict: 'email' });
  const { data: act } = await svc.from('crm_activities').select('client_id').eq('meta->>resend_id', sentId).limit(1).maybeSingle();
  let clientId = act?.client_id;
  if (!clientId && to[0]) clientId = (await svc.from('crm_clients').select('id').ilike('email', to[0]).maybeSingle()).data?.id;
  if (clientId) await svc.from('crm_activities').insert({ client_id: clientId, kind: 'note', body: reason === 'bounce' ? `E-mail nie doszedł (odbity): ${d.bounce?.message || d.subject || ''}`.trim() : 'Odbiorca oznaczył e-mail jako spam, wypisany.', meta: { dir: 'sys', resend_id: sentId, event: ev.type } });
  if (ev.type === 'email.bounced') await svc.from('leads').update({ status: 'failed', error: 'bounce' }).eq('resend_id', sentId);
  return { ok: true };
}

// ── outgoing from the CRM card ──
const toHtml = (text: string) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">${text.split(/\n\n/).map((p) => `<p style="margin:0 0 10px">${esc(p).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#030712">$1</a>')}</p>`).join('')}</div>`;

async function sendFromCrm(svc: any, b: any) {
  const { data: c } = await svc.from('crm_clients').select('*').eq('id', b.client_id).single();
  if (!c?.email) throw new Error('klient bez e-maila');
  const cfg = await leadsCfg(svc);
  let subject = noDash(String(b.subject || '').trim());
  const msg = noDash(String(b.text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim());
  if (!subject || msg.length < 2) throw new Error('pusty temat lub treść');

  // thread on the latest message we have with this client
  const { data: last } = await svc.from('crm_activities').select('meta,body,happened_at').eq('client_id', c.id).eq('kind', 'email').not('meta->>message_id', 'is', null).order('happened_at', { ascending: false }).limit(1).maybeSingle();
  const parent = b.reply === false ? null : last?.meta?.message_id ? last : null;
  const headers: Record<string, string> = {};
  const messageId = `<${crypto.randomUUID()}@barabashflow.pl>`;
  headers['Message-ID'] = messageId;
  let quote = '';
  if (parent) {
    headers['In-Reply-To'] = parent.meta.message_id;
    headers['References'] = `${parent.meta.references || ''} ${parent.meta.message_id}`.trim().split(/\s+/).slice(-10).join(' ');
    if (!/^re:/i.test(subject) && b.keepSubject !== true && parent.meta.subject && subject === parent.meta.subject) subject = `Re: ${subject}`;
    if (parent.meta.dir === 'in') {
      const who = parent.meta.from_name ? `${parent.meta.from_name} <${parent.meta.from}>` : parent.meta.from;
      const dt = new Date(parent.happened_at).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'short', timeStyle: 'short' });
      quote = `\n\nW dniu ${dt} ${who} napisał(a):\n${String(parent.body || '').split('\n').map((l) => `> ${l}`).join('\n')}`;
    }
  }
  const ready = await inboxReady(svc);
  const replyTo = ready ? `${cfg.from_name} <${replyAddress(c.mail_tag)}>` : cfg.from_email;
  const signature = b.signature === false ? '' : `\n\n${cfg.signature}`;
  const text = noDash(`${msg}${signature}${quote}`);
  const html = toHtml(noDash(`${msg}${signature}`)) + (quote ? `<blockquote style="margin:14px 0 0;padding-left:10px;border-left:2px solid #ccc;color:#555;font-family:Arial,sans-serif;font-size:13px">${esc(quote.trim()).replace(/\n/g, '<br>')}</blockquote>` : '');
  const res = await resend(svc, '/emails', { method: 'POST', body: JSON.stringify({ from: `${cfg.from_name} <${cfg.from_email}>`, to: [c.email], reply_to: replyTo, subject, text, html, headers, tags: [{ name: 'kind', value: 'crm' }] }) });
  await svc.from('crm_activities').insert({ client_id: c.id, kind: 'email', body: msg, meta: { dir: 'out', subject, to: c.email, message_id: messageId, in_reply_to: headers['In-Reply-To'] || '', references: headers['References'] || '', resend_id: res.id, reply_to: replyTo } });
  const upd: any = { next_action: b.next_action ?? 'Czekam na odpowiedź', next_action_at: b.next_action_at ?? new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10) };
  if (c.status === 'lead') upd.status = 'contact';
  await svc.from('crm_clients').update(upd).eq('id', c.id);
  return { ok: true, resend_id: res.id, reply_to: replyTo, ready };
}
