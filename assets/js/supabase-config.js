// Public Supabase client config for barabashflow.pl
// The "anon" key below is a publishable JWT — safe to ship to the browser.
// RLS protects the data: public can read published projects/settings and
// insert into contact_submissions only. Everything else requires auth.

export const SUPABASE_URL = 'https://yhtzxkhfqzuaafvappln.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlodHp4a2hmcXp1YWFmdmFwcGxuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2OTE4MDUsImV4cCI6MjA5NTI2NzgwNX0.xCW-p1_LTy9tC8BxkrHfarragLOY4kAWUBbnBBzYI3E';

export const MEDIA_BUCKET = 'media';

export function mediaUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path;
  return `${SUPABASE_URL}/storage/v1/object/public/${MEDIA_BUCKET}/${path}`;
}
