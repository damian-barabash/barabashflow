// blog-ingest — private API for the Mac Studio blog worker.
// Auth: `x-blog-secret` header must equal Vault secret `blog_ingest_secret`
// (same pattern as mail-refresh's x-cron-secret). verify_jwt is off.
//
// Actions (POST { action, ... }):
//   recent        -> { posts, keywords, config } — config comes from
//                    site_settings.blog_config (admin-editable: enabled,
//                    posts_min/max, seed_keywords). Posts include
//                    cover_source_url so the worker never reuses a photo,
//                    and status so the live self-check skips hidden drafts.
//   ingest_post   -> stores the cover in the public `media` bucket under blog/,
//                    inserts a published blog_posts row. The worker downloads
//                    the image itself and sends cover_b64 (see IMG_UA note
//                    below — the 2026-07-06 no-cover incident). 
//                    cover_image_url is the URL fallback.
//                    Cover failures don't block the post.
//   set_cover     -> attach/replace a cover on an existing post by slug
//                    (cover_b64 preferred, cover_image_url fallback).
//   log_keywords  -> bulk-upserts the day's keyword research into seo_keywords.
//   report_status -> stores the run status in site_settings.blog_agent_status
//                    (shown in the admin Blog tab); a failed run also sends an
//                    alert email to office@ via Resend.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const BUCKET = 'media';
const MAX_IMG_BYTES = 8 * 1024 * 1024;
const IMG_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};
// Flickr's CDN answers 502 to fetch()-style clients whose User-Agent contains
// "Bot" — that was the source of every cover 502 in the logs. Browser UA for
// image downloads only.
const IMG_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DEFAULT_CONFIG = { enabled: true, posts_min: 1, posts_max: 2, seed_keywords: [] as string[] };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-blog-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const svc = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: secret, error: secErr } = await svc.rpc('get_secret', { p_name: 'blog_ingest_secret' });
  if (secErr || !secret) return json({ error: 'vault error' }, 500);
  const provided = req.headers.get('x-blog-secret') || '';
  if (provided !== secret) return json({ error: 'unauthorized' }, 401);

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: 'invalid json' }, 400); }

  try {
    switch (payload.action) {
      case 'recent': {
        const { data: posts } = await svc
          .from('blog_posts')
          .select('slug,title_pl,keywords,published_at,cover_source_url,status')
          .order('published_at', { ascending: false })
          .limit(60);
        const { data: keywords } = await svc
          .from('seo_keywords')
          .select('day,keyword,picked')
          .gte('day', new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10))
          .order('day', { ascending: false })
          .limit(400);
        const { data: cfgRow } = await svc
          .from('site_settings')
          .select('value_meta')
          .eq('key', 'blog_config')
          .maybeSingle();
        const config = { ...DEFAULT_CONFIG, ...(cfgRow?.value_meta ?? {}) };
        return json({ ok: true, posts: posts ?? [], keywords: keywords ?? [], config });
      }

      case 'ingest_post': {
        const p = payload.post ?? {};
        if (!p.slug || !p.title_pl || !p.body_pl) return json({ error: 'slug, title_pl, body_pl required' }, 400);

        let cover_path: string | null = null;
        try {
          if (p.cover_b64) {
            cover_path = await storeCoverBytes(svc, String(p.cover_b64), String(p.cover_content_type || 'image/jpeg'), String(p.slug));
          } else if (p.cover_image_url) {
            cover_path = await storeCover(svc, String(p.cover_image_url), String(p.slug));
          }
        } catch (err) {
          console.warn('[blog-ingest] cover failed:', String(err));
        }

        const row = {
          slug: String(p.slug),
          title_pl: String(p.title_pl),
          title_en: p.title_en ?? null,
          title_ru: p.title_ru ?? null,
          excerpt_pl: p.excerpt_pl ?? null,
          excerpt_en: p.excerpt_en ?? null,
          excerpt_ru: p.excerpt_ru ?? null,
          body_pl: String(p.body_pl),
          body_en: p.body_en ?? null,
          body_ru: p.body_ru ?? null,
          cover_path,
          cover_alt: p.cover_alt ?? null,
          cover_credit: p.cover_credit ?? null,
          cover_source_url: p.cover_source_url ?? null,
          tags: Array.isArray(p.tags) ? p.tags.slice(0, 8) : [],
          keywords: Array.isArray(p.keywords) ? p.keywords.slice(0, 20) : [],
          faq: Array.isArray(p.faq) ? p.faq.slice(0, 6) : [],
          status: 'published',
          published_at: p.published_at ?? new Date().toISOString(),
          meta: p.meta ?? {},
        };
        const { data, error } = await svc.from('blog_posts').insert(row).select('id,slug,cover_path').single();
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, ...data });
      }

      case 'set_cover': {
        const { slug, cover_image_url, cover_b64, cover_content_type, cover_alt, cover_credit, cover_source_url } = payload;
        if (!slug || (!cover_image_url && !cover_b64)) return json({ error: 'slug and cover_b64 or cover_image_url required' }, 400);
        const cover_path = cover_b64
          ? await storeCoverBytes(svc, String(cover_b64), String(cover_content_type || 'image/jpeg'), String(slug))
          : await storeCover(svc, String(cover_image_url), String(slug));
        const patch: Record<string, unknown> = { cover_path };
        if (cover_alt) patch.cover_alt = cover_alt;
        if (cover_credit) patch.cover_credit = cover_credit;
        if (cover_source_url) patch.cover_source_url = cover_source_url;
        const { data, error } = await svc.from('blog_posts').update(patch).eq('slug', slug).select('slug,cover_path').single();
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, ...data });
      }

      case 'log_keywords': {
        const items = Array.isArray(payload.items) ? payload.items.slice(0, 300) : [];
        if (!items.length) return json({ ok: true, inserted: 0 });
        const day = payload.day ?? new Date().toISOString().slice(0, 10);
        const rows = items.map((it: any) => ({
          day,
          keyword: String(it.keyword).slice(0, 200),
          locale: it.locale ?? 'pl',
          source: it.source ?? 'google-suggest',
          score: Number.isFinite(it.score) ? it.score : null,
          picked: !!it.picked,
        }));
        const { error, count } = await svc
          .from('seo_keywords')
          .upsert(rows, { onConflict: 'day,keyword', ignoreDuplicates: true, count: 'exact' });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, inserted: count ?? rows.length });
      }

      case 'report_status': {
        const status = payload.status ?? {};
        const { error } = await svc
          .from('site_settings')
          .upsert({ key: 'blog_agent_status', value_meta: status }, { onConflict: 'key' });
        if (error) return json({ error: error.message }, 400);
        // A failed run alerts the owner by email — silent failures were how the
        // 2026-07-05 incident went unnoticed until the evening.
        if (status.ok === false) {
          try {
            const { data: rkey } = await svc.rpc('get_secret', { p_name: 'resend_api_key' });
            if (rkey) {
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: `Bearer ${rkey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  from: 'BarabashFlow <office@barabashflow.pl>',
                  to: ['office@barabashflow.pl'],
                  subject: `⚠ Blog agent: błąd przebiegu ${status.day ?? ''}`.trim(),
                  text: `Blog agent zgłosił błąd.\n\n${JSON.stringify(status, null, 2)}\n\nPełny log: ~/blog-agent/logs/blog-writer.log na Mac Studio.\nDrugi przebieg (catch-up) startuje o 13:40, fallback-build GH Actions o 14:30.`,
                }),
              });
            }
          } catch (e) {
            console.warn('[blog-ingest] alert email failed:', String(e));
          }
        }
        return json({ ok: true });
      }

      default:
        return json({ error: 'unknown action' }, 400);
    }
  } catch (err) {
    console.error('[blog-ingest]', err);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});

async function storeCover(svc: any, url: string, slug: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': IMG_UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`cover HTTP ${resp.status}`);
  const ct = (resp.headers.get('content-type') || '').split(';')[0].trim();
  const ext = IMG_EXT[ct];
  if (!ext) throw new Error(`not an image: ${ct}`);
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > MAX_IMG_BYTES) throw new Error(`too big: ${buf.byteLength}`);
  return uploadCover(svc, buf, ct, ext, slug);
}

async function storeCoverBytes(svc: any, b64: string, contentType: string, slug: string): Promise<string> {
  const ct = contentType.split(';')[0].trim();
  const ext = IMG_EXT[ct];
  if (!ext) throw new Error(`not an image: ${ct}`);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.byteLength > MAX_IMG_BYTES) throw new Error(`too big: ${bytes.byteLength}`);
  if (bytes.byteLength < 1024) throw new Error(`suspiciously small image: ${bytes.byteLength}`);
  return uploadCover(svc, bytes.buffer, ct, ext, slug);
}

async function uploadCover(svc: any, buf: ArrayBuffer, ct: string, ext: string, slug: string): Promise<string> {
  const path = `blog/${slug}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const { error } = await svc.storage.from(BUCKET).upload(path, buf, {
    contentType: ct,
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw new Error(error.message);
  return path;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
