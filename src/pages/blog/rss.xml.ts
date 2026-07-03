// RSS feed — helps aggregators and AI crawlers discover fresh posts fast.
import { fetchPostList, escapeXml } from '../../lib/blog';

export async function GET() {
  const site = 'https://barabashflow.pl';
  const posts = (await fetchPostList()).slice(0, 30);
  const items = posts
    .map(
      (p) => `  <item>
    <title>${escapeXml(p.title_pl)}</title>
    <link>${site}/blog/${p.slug}/</link>
    <guid isPermaLink="true">${site}/blog/${p.slug}/</guid>
    <pubDate>${new Date(p.published_at).toUTCString()}</pubDate>
    <description>${escapeXml(p.excerpt_pl || '')}</description>
  </item>`,
    )
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Blog — BarabashFlow</title>
  <link>${site}/blog/</link>
  <description>Praktycznie o stronach internetowych, platformach i SEO dla firm.</description>
  <language>pl</language>
${items}
</channel>
</rss>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
