import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyShapes, diffIconSets, extractIconSet, hasChanges, labelLines, parsePath, renderDiffPdf, renderIconsHtml, renderIconsPdf, renderIconsSprite, safeBody } from '../src/icons.mjs';

const blob = `x=JSON.parse('{"prefix":"v3w","icons":{"b-two":{"body":"<path fill=\\\\"currentColor\\\\" d=\\\\"M1 1h2v2z\\\\"/>"},"a-one":{"body":"<circle cx=\\\\"5\\\\" cy=\\\\"5\\\\" r=\\\\"2\\\\" fill=\\\\"currentColor\\\\"/>"}},"width":20,"height":20}');y=1`;

test('icons: the glyph set is cut out of a chunk and sorted', () => {
  const set = extractIconSet(blob);
  assert.deepEqual(Object.keys(set.icons), ['a-one', 'b-two']);
  assert.equal(set.width, 20);
  assert.equal(extractIconSet('JSON.parse(\'{"other":1}\')'), null);
});

test('icons: path data (relative, implicit lineto, arc flags without separators)', () => {
  assert.deepEqual(parsePath('M1 1h2v2z'), [['M', 1, 1], ['L', 3, 1], ['L', 3, 3], ['Z']]);
  assert.deepEqual(parsePath('m1 1 2 0'), [['M', 1, 1], ['L', 3, 1]]);
  const arc = parsePath('M0 0a1 1 0 0110 0');
  assert.equal(arc.at(-1)[5], 10);
  assert.ok(bodyShapes('<rect x="1" y="1" width="4" height="4" rx="1"/><ellipse cx="3" cy="3" rx="1" ry="2"/>').length === 2);
});

test('icons: labels wrap at hyphens and the PDF is deterministic', () => {
  assert.deepEqual(labelLines('add', 60), ['add']);
  assert.ok(labelLines('brand-adobe-photoshop-filled', 40).length >= 2);
  const set = extractIconSet(blob);
  const a = renderIconsPdf(set), b = renderIconsPdf(set);
  assert.ok(a.equals(b));
  assert.equal(a.subarray(0, 5).toString(), '%PDF-');
});

test('icons: diff, header links in the PDF, searchable gallery, and markup is sanitised', () => {
  const a = extractIconSet(blob);
  const b = { ...a, icons: { 'a-one': { body: '<circle cx="6" cy="5" r="2" fill="currentColor"/>' }, 'c-new': { body: '<path fill="currentColor" d="M1 1h2v2z" onload="x()"/>' } } };
  const d = diffIconSets(a, b);
  assert.deepEqual(d, { added: ['c-new'], removed: ['b-two'], changed: ['a-one'] });
  assert.ok(hasChanges(d) && !hasChanges(diffIconSets(a, a)));
  const pdf = renderIconsPdf(a, { header: [{ text: 'sdmp.izie.top/icons.pdf', url: 'https://sdmp.izie.top/icons.pdf' }, { text: 'Changes: sdmp.izie.top/icons-diff.pdf', url: 'https://sdmp.izie.top/icons-diff.pdf' }] }).toString('latin1');
  assert.equal((pdf.match(/\/Subtype \/Link/g) || []).length, 2);
  assert.ok(pdf.includes('/URI (https://sdmp.izie.top/icons-diff.pdf)'));
  assert.equal(renderDiffPdf(a, b, d).subarray(0, 5).toString(), '%PDF-');
  const html = renderIconsHtml(b, d, { links: [['icons.pdf', 'PDF']] });
  assert.ok(html.includes('id="q"') && html.includes('data-flag="new"') && html.includes('data-flag="redrawn"') && html.includes('<nav'));
  assert.ok(!html.includes('onload') && !safeBody('<script>x</script><path d="M1 1" onclick="x" fill="red"/>').includes('script'));
  assert.equal(safeBody('<path d="M1 1" onclick="x" fill="red"/>'), '<path d="M1 1" fill="red"/>');
  assert.ok(renderIconsSprite(a).includes('<symbol id="a-one" viewBox="0 0 20 20">'));
  const evil = { ...a, icons: { ...a.icons, 'x"><script>': { body: '<path d="M1 1"/>' } } };
  assert.ok(!renderIconsSprite(evil).includes('script') && renderIconsSprite(evil).includes('id="a-one"'));
  const noted = renderIconsHtml(a, null, { notes: { 'a-one': 'A "note" <b>' } });
  assert.ok(noted.includes('data-note="A &quot;note&quot; &lt;b&gt;"') && noted.includes('toLowerCase()'));
});

test('icon pages: tiles link to them, pages escape and show usage', async () => {
  const { renderIconsHtml, renderIconPage, renderIconSvg, validName } = await import('../src/icons.mjs');
  const set = { width: 20, height: 20, icons: { 'ai-sparkle': { body: '<path d="M1 1h2"/>' }, 'ai-sparkle-filled': { body: '<path d="M1 1h3" onclick="x"/>' }, 'bad name"<': { body: '' } } };
  const descs = { 'ai-sparkle': { where: 'AI menu <b>', purpose: 'Marks AI features', confidence: 'high' } };
  const usage = { 'ai-sparkle': { count: 2, labels: ['Write with AI'], snippets: ['name:"ai-sparkle"</script>'] } };
  const g = renderIconsHtml(set, null, { descs });
  assert.ok(g.includes('href="icons/ai-sparkle.html"') && g.includes('data-find="Marks AI features AI menu &lt;b&gt;"') && !g.includes('bad name'));
  const p = renderIconPage(set, 'ai-sparkle', { descs, usage, labels: { 'ai-sparkle': 'AI features' }, next: 'ai-sparkle-filled' });
  assert.ok(p.includes('Marks AI features') && p.includes('AI menu &lt;b&gt;') && p.includes('fairly sure') && p.includes('Referenced by name 2 times'));
  assert.ok(p.includes('<li>Write with AI</li>') && p.includes('&lt;/script&gt;') && !p.includes('"ai-sparkle"</script>'));
  assert.ok(p.includes('href="ai-sparkle-filled.html"') && p.includes('download="ai-sparkle.svg"') && p.includes('<h2>Variants</h2>'));
  assert.ok(renderIconSvg(set, 'ai-sparkle-filled').startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && !renderIconSvg(set, 'ai-sparkle-filled').includes('onclick'));
  assert.ok(validName('a-b_1') && !validName('../x') && !validName('bad name"<'));
  assert.ok(renderIconPage(set, 'ai-sparkle-filled').includes('Not described yet'));
});

test('icon usage: counts name:/icon: references and keeps nearby labels, only for icons in the set', async () => {
  const { emptyIconUsage, scanIconUsage, finishIconUsage } = await import('../src/icons.mjs');
  const acc = emptyIconUsage();
  scanIconUsage('x({name:"send-filled",label:"Send"});y({icon:"request-to-join",title:"Requested to join"});z({name:"not-an-icon"})', acc);
  scanIconUsage('q({name:"send-filled",tooltip:"Send now"})', acc);
  const u = finishIconUsage(acc, { icons: { 'send-filled': {}, 'request-to-join': {}, blocks: {} } });
  assert.deepEqual(Object.keys(u), ['blocks', 'request-to-join', 'send-filled']);
  assert.equal(u['send-filled'].count, 2);
  assert.ok(u['send-filled'].labels.includes('Send'));
  assert.equal(u['request-to-join'].count, 1);
  assert.deepEqual(u.blocks, { count: 0, labels: [], snippets: [] });
});
