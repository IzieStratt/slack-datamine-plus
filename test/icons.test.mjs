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
});
