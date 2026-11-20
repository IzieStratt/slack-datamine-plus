import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRenames, editDistance, parseArgsLines, renameLine, signatureChanges, similarity } from '../src/diff.mjs';
import { parseItem, plainSummary, splitItem, fullItemHtml } from '../src/feed-lib.mjs';

test('editDistance and similarity ignore case and separators', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('abc', 'abcdefgh', 2), 3, 'gives up past max');
  assert.equal(similarity('huddleInviteModal', 'huddle_invite_modal'), 1);
  assert.ok(similarity('conversations.history', 'conversations.historyV2') > 0.85);
  assert.equal(similarity('chat.postMessage', 'files.upload'), 0);
});

test('detectRenames pairs each removed value with its closest added value once', () => {
  const added = ['HuddleInviteModalV2', 'SomethingElseEntirely', 'admin.users.listV2', 'get2'];
  const removed = ['HuddleInviteModal', 'admin.users.list', 'get', 'TotallyUnrelatedThing'];
  assert.deepEqual(detectRenames(added, removed), [
    { from: 'admin.users.list', to: 'admin.users.listV2' },
    { from: 'HuddleInviteModal', to: 'HuddleInviteModalV2' },
  ]);
  assert.equal(renameLine({ from: 'a', to: 'b' }), 'a → b');
  // two near-identical candidates: the better match wins, the other stays unpaired
  assert.deepEqual(detectRenames(['search_modal_v2', 'search_modal_v3'], ['search_modal_v2x']), [{ from: 'search_modal_v2x', to: 'search_modal_v2' }]);
  assert.deepEqual(detectRenames([], ['x']), []);
  // a mass change is not compared pairwise
  const many = Array.from({ length: 600 }, (_, i) => `value_number_${i}`);
  assert.deepEqual(detectRenames(many, many.map((x) => `${x}x`)), []);
});

test('signatureChanges compares param sets of methods present on both sides', () => {
  const argsBefore = parseArgsLines('chat.postMessage: as_user, channel, text\nfiles.list: count\nusers.info: user\n');
  const argsAfter = parseArgsLines('chat.postMessage: channel, text, thread_ts\nfiles.list: count\nnew.method: a\n');
  const pBefore = new Map([['users.info', new Set(['user'])], ['x.y', new Set(['a'])], ['z.z', new Set(['k'])]]);
  const pAfter = new Map([['users.info', new Set(['user', 'include_locale'])], ['x.y', new Set()], ['z.z', new Set(['k'])]]);
  assert.deepEqual(signatureChanges([[argsBefore, argsAfter], [pBefore, pAfter]]), [
    'chat.postMessage: +thread_ts −as_user',
    'users.info: +include_locale',
  ], 'an empty set (no call site this build) and new/removed methods are not signature changes');
  assert.deepEqual(signatureChanges([[new Map([['a.b', new Set(['x'])]]), new Map([['a.b', new Set(['y'])]])], [new Map([['a.b', new Set(['y'])]]), new Map([['a.b', new Set(['x'])]])]]), [], 'two sources disagreeing cancel out');
});

test('items with renames and signature changes parse and round-trip; old consumers keep their fields', () => {
  const html = '<p>4 changes since abc1234.</p>'
    + '<details open><summary><strong>components: new (1)</strong></summary><ul><li>+ <code>FooV2</code></li></ul></details>'
    + '<details open><summary><strong>components: gone (1)</strong></summary><ul><li>− <code>Foo</code></li></ul></details>'
    + '<details open><summary><strong>components: likely renamed (1)</strong></summary><ul><li><code>Foo → FooV2</code></li></ul></details>'
    + '<details open><summary><strong>api-methods: signature changed (2)</strong></summary><ul><li><code>a.b: +x</code></li><li><code>c.d: −y</code></li></ul></details>';
  const r = parseItem(html);
  assert.deepEqual(r.categories, [
    { name: 'components', new: 1, gone: 1, groups: 0, renamed: 1 },
    { name: 'api-methods', new: 0, gone: 0, groups: 0, signatures: 2 },
  ]);
  assert.equal(plainSummary(html), '4 changes since abc1234: components +1 −1 (1 renamed) · api-methods 2 signatures changed');
  assert.equal(fullItemHtml(splitItem(html)), html.replace('→', '→'));
  assert.deepEqual(splitItem(html).cats[2].v, ['Foo → FooV2']);
});
