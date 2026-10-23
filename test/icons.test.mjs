import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyShapes, extractIconSet, labelLines, parsePath, renderIconsPdf } from '../src/icons.mjs';

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
