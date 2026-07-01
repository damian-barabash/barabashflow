// Public Supabase config for barabashflow.pl.
// The anon key is a publishable JWT — safe in the browser. RLS restricts access:
// the public can read published projects/settings and insert contact_submissions
// only; everything else requires an authenticated session (admin/mail).

export const SUPABASE_URL = 'https://yhtzxkhfqzuaafvappln.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlodHp4a2hmcXp1YWFmdmFwcGxuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2OTE4MDUsImV4cCI6MjA5NTI2NzgwNX0.xCW-p1_LTy9tC8BxkrHfarragLOY4kAWUBbnBBzYI3E';

export const MEDIA_BUCKET = 'media';

export function mediaUrl(path?: string | null): string | null {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path;
  return `${SUPABASE_URL}/storage/v1/object/public/${MEDIA_BUCKET}/${path}`;
}

// Lightweight REST reader — avoids the supabase-js client + persistSession
// overhead on the public page's first paint. Returns [] on any failure so the
// graph still renders (with the static SEO fallback content).
const REST = `${SUPABASE_URL}/rest/v1`;
const REST_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

export async function restGet<T = any>(path: string): Promise<T[]> {
  try {
    const r = await fetch(`${REST}/${path}`, { headers: REST_HEADERS });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T[];
  } catch (err) {
    console.warn('[bf] restGet failed', path, err);
    return [];
  }
}

// Single-row insert via REST (used by the contact form + mascot bot). RLS
// allows anon INSERT into contact_submissions only.
export async function restInsert(table: string, row: Record<string, unknown>) {
  const r = await fetch(`${REST}/${table}`, {
    method: 'POST',
    headers: {
      ...REST_HEADERS,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    return { error: new Error(`HTTP ${r.status} ${text}`) };
  }
  return { error: null };
}
