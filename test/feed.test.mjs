import test from 'node:test';
import assert from 'node:assert/strict';
import { feedHtml, itemSlug, parseItem, plainSummary, renderRss } from '../src/feed-lib.mjs';

const li = (xs, sign = '+ ') => xs.map((x) => `<li>${sign}<code>${x}</code></li>`).join('');
const html = '<p>893 changes since 0808ace.</p>'
  + `<details open><summary><strong>watch: keyword matches (3)</strong></summary><ul>${li(['+ experiments: slackbot_a', '+ icons: spooky', '− errors: x'], '')}</ul></details>`
  + `<details open><summary><strong>api-methods: new (2)</strong></summary><ul>${li(['a.b', 'c.d'])}</ul></details>`
  + `<details open><summary><strong>api-methods: gone (1)</strong></summary><ul>${li(['e.f'], '− ')}</ul></details>`
  + `<details open><summary><strong>components: new (30)</strong></summary><ul>${li(['X'])}</ul><details><summary>…and 29 more</summary><ul>${li(['Y', 'Z'])}</ul></details></details>`
  + `<details open><summary><strong>experiments: new groups (2)</strong></summary><ul>${li(['a: +on', 'b: +off'], '')}</ul></details>`;
const item = { id: 'https://slackdatamineplus.izie.top/#2026-10-28', date: '2026-10-28', title: 'Slack client changes 2026-10-28 (build abc)', html };

test('parseItem reads the headline, the categories and the watch hits', () => {
  const r = parseItem(html);
  assert.equal(r.total, 893);
  assert.equal(r.since, '0808ace');
  assert.deepEqual(r.categories, [
    { name: 'api-methods', new: 2, gone: 1, groups: 0 },
    { name: 'components', new: 30, gone: 0, groups: 0 },
    { name: 'experiments', new: 0, gone: 0, groups: 2 },
  ]);
  assert.deepEqual(r.watch, ['+ experiments: slackbot_a', '+ icons: spooky', '− errors: x']);
});

test('plainSummary is tag-free text with its own separators', () => {
  const s = plainSummary(html);
  assert.equal(s, '893 changes since 0808ace: api-methods +2 −1 · components +30 · experiments ~2\nWatch: + experiments: slackbot_a · + icons: spooky · − errors: x');
  assert.ok(!/[<>]/.test(s));
  assert.equal(plainSummary('<p>Hello <b>there</b> &amp; you</p>'), 'Hello there & you', 'an item that is not a changes item still gets a readable summary');
  assert.match(plainSummary(`<p>5 changes since abc.</p>${'<details open><summary><strong>watch: keyword matches (7)</strong></summary><ul>'}${li(['1', '2', '3', '4', '5', '6', '7'], '')}</ul></details>`), /Watch: 1 · 2 · 3 · 4 · 5 · \+2 more/);
});

test('feedHtml swaps the expanders for a link and keeps the first lists', () => {
  const out = feedHtml(html, 'https://sdmp.izie.top/#2026-10-28');
  assert.ok(!out.includes('<code>Y</code>') && out.includes('<code>X</code>'));
  assert.ok(out.includes('…and 29 more on <a href="https://sdmp.izie.top/#2026-10-28">the site</a>'));
  assert.equal(parseItem(out).categories.length, 3, 'the counts survive');
});

test('itemSlug uses the id fragment, so two items on one date stay distinct', () => {
  assert.equal(itemSlug(item), '2026-10-28');
  assert.equal(itemSlug({ id: 'https://x/#2026-10-23-entry-bundles', date: '2026-10-23' }), '2026-10-23-entry-bundles');
  assert.equal(itemSlug({ id: 'https://x/no-fragment', date: '2026-10-22' }), '2026-10-22');
});

test('renderRss: per-item links, plain description, full content, categories, channel metadata', () => {
  const xml = renderRss([item], { linkBase: 'https://sdmp.izie.top' });
  assert.match(xml, /<atom:link href="https:\/\/sdmp.izie.top\/feed.xml" rel="self" type="application\/rss\+xml"\/>/);
  assert.match(xml, /<language>en<\/language><lastBuildDate>Wed, 28 Oct 2026 06:30:00 GMT<\/lastBuildDate>/);
  assert.match(xml, /<guid isPermaLink="false">https:\/\/slackdatamineplus.izie.top\/#2026-10-28<\/guid>/, 'the guid does not change, or readers show every item twice');
  assert.match(xml, /<link>https:\/\/sdmp.izie.top\/#2026-10-28<\/link>/);
  assert.match(xml, /<category>api-methods<\/category><category>components<\/category><category>experiments<\/category>/);
  assert.match(xml, /<description>893 changes since 0808ace: api-methods \+2 −1/);
  assert.match(xml, /<content:encoded><!\[CDATA\[<p>893 changes since 0808ace\.<\/p>/);
});

test('renderRss: limits the items, and a "]]>" in the html cannot end the CDATA early', () => {
  const many = Array.from({ length: 20 }, (_, n) => ({ ...item, id: `https://x/#d${n}`, date: '2026-10-28' }));
  assert.equal(renderRss(many, { linkBase: 'https://s' }).match(/<item>/g).length, 14);
  const evil = { ...item, html: `${html}<p>a ]]> b</p>` };
  assert.ok(renderRss([evil], { linkBase: 'https://s' }).includes('a ]]]]><![CDATA[> b'));
});
