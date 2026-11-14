// SPDX-License-Identifier: AGPL-3.0-only
// slack.com/release-notes/<platform>/rss -> one line per bullet: `<version (date)> · <section>: <text>`.
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&#8217;/g, '’').replace(/\s+/g, ' ').trim();

export function parseNotes(xml) {
  const out = [];
  for (const it of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = strip(it[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const body = it[1].match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] ?? '';
    const ver = title.replace(/^Slack\s+/, '');
    let section = '';
    for (const part of body.split(/(<h3>[\s\S]*?<\/h3>|<li>[\s\S]*?<\/li>|<p>[\s\S]*?<\/p>)/)) {
      if (part.startsWith('<h3>')) section = strip(part);
      else if (/^<(li|p)>/.test(part)) { const t = strip(part); if (t) out.push(`${ver} · ${section ? `${section}: ` : ''}${t}`); }
    }
  }
  return out;
}
