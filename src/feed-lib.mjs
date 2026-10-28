// SPDX-License-Identifier: AGPL-3.0-only
// Pure helpers for the daily changes feed (feed.mjs): turn a stored item's html into the pieces a feed reader, Slack's own RSS bot and
// the music-stalker Slack bot each want. No git, no filesystem, so it can be tested.

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const unesc = (x) => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// the fragment an item is reachable at on the site (ids end in #<fragment>; the date for items from before they did)
export const itemSlug = (i) => (i.id.includes('#') ? i.id.split('#').pop() : i.date);

// What an item says, read back from its html (so items stored before this existed work too): the headline numbers, one entry per
// category with its new / gone / new-group counts, and the watch-keyword matches. Top-level sections are `<details open>`; the
// "…and N more" expanders inside them are plain `<details>`.
export function parseItem(html) {
  const head = html.match(/<p>(\d+) changes since (\w+)\.?<\/p>/);
  const categories = new Map();
  const watch = [];
  for (const chunk of html.split('<details open>').slice(1)) {
    const m = chunk.match(/^<summary><strong>(.+?) \((\d+)\)<\/strong>/);
    if (!m) continue;
    const title = unesc(m[1]);
    const n = Number(m[2]);
    if (title.startsWith('watch: ')) { watch.push(...[...chunk.matchAll(/<li><code>(.*?)<\/code>/g)].map((x) => unesc(x[1]))); continue; }
    const t = title.match(/^(.+?): (new category|new groups|new|gone)$/);
    if (!t) continue;
    const c = categories.get(t[1]) ?? { name: t[1], new: 0, gone: 0, groups: 0 };
    if (t[2] === 'gone') c.gone += n; else if (t[2] === 'new groups') c.groups += n; else c.new += n;
    categories.set(t[1], c);
  }
  return { total: head ? Number(head[1]) : null, since: head ? head[2] : null, categories: [...categories.values()], watch };
}

// Plain text, no tags. Readers show it as the preview and Slack's native RSS bot flattens an item's description into its post, gluing
// list items together, so this is one run of text with its own separators instead of markup.
export function plainSummary(html, { watchMax = 5 } = {}) {
  const { total, since, categories, watch } = parseItem(html);
  if (total === null) return unesc(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 280);
  const counts = categories.map((c) => [c.name, c.new && `+${c.new}`, c.gone && `−${c.gone}`, c.groups && `~${c.groups}`].filter(Boolean).join(' ')).join(' · ');
  const lines = [`${total} changes since ${since}${counts ? `: ${counts}` : '.'}`];
  if (watch.length) lines.push(`Watch: ${watch.slice(0, watchMax).join(' · ')}${watch.length > watchMax ? ` · +${watch.length - watchMax} more` : ''}`);
  return lines.join('\n');
}

// The html a reader gets: the first 25 of each list stay, the "…and N more" expanders (most of the bytes: one item was 1.2 MB) become a
// link to the site, where everything is still listed.
export const feedHtml = (html, link) => html.replace(/<details><summary>…and (\d+) more<\/summary><ul>[\s\S]*?<\/ul><\/details>/g, (_, n) => `<p><em>…and ${n} more on <a href="${esc(link)}">the site</a></em></p>`);

const cdata = (s) => s.replaceAll(']]>', ']]]]><![CDATA[>');

export function renderRss(items, { linkBase, limit = 14 }) {
  const shown = items.slice(0, limit); // the site keeps 90 days; a feed only needs the recent ones
  const built = shown.length ? new Date(`${shown[0].date}T06:30:00Z`) : new Date(0);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>slack-datamine-plus daily changes</title><link>${esc(linkBase)}</link><atom:link href="${esc(linkBase)}/feed.xml" rel="self" type="application/rss+xml"/><description>Daily summary of what changed in Slack's web client bundle.</description><language>en</language><lastBuildDate>${built.toUTCString()}</lastBuildDate><ttl>60</ttl>
${shown.map((i) => {
  const link = `${linkBase}/#${itemSlug(i)}`;
  const cats = parseItem(i.html).categories.map((c) => `<category>${esc(c.name)}</category>`).join('');
  return `<item><title>${esc(i.title)}</title><guid isPermaLink="false">${esc(i.id)}</guid><link>${esc(link)}</link><pubDate>${new Date(`${i.date}T06:30:00Z`).toUTCString()}</pubDate>${cats}<description>${esc(plainSummary(i.html))}</description><content:encoded><![CDATA[${cdata(feedHtml(i.html, link))}]]></content:encoded></item>`;
}).join('\n')}
</channel></rss>
`;
}
