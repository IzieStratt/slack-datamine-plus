import test from 'node:test';
import assert from 'node:assert/strict';
import { finishPresence, scanWatched } from '../src/watch.mjs';

const js = 'Ab12(e,t,n){"use strict";function MenuFromTemplate({a:e}){return 1}let getActiveHuddleCallId=H=>H?.callId;(0,Z.KN)("getActiveHuddleTeamId",getActiveHuddleTeamId);let th=(0,G("YTsv").r)("blocksFormatFetcher","blocks.format");class Panel extends Y{}Panel.displayName="Panel";let x={};x.meta={name:"bindVideo",key:"createActionBindVideo"}},Cd34(e,t,n){"use strict";var z=1}';
const watch = [
  { kind: 'component', name: 'MenuFromTemplate' }, { kind: 'component', name: 'Panel' }, { kind: 'component', name: 'Serialized(Panel)' }, { kind: 'component', name: 'Nope' },
  { kind: 'byName', name: 'getActiveHuddleCallId' }, { kind: 'byMeta', name: 'getActiveHuddleTeamId' }, { kind: 'byMeta', name: 'getActiveHuddleCallId' },
  { kind: 'thunk', name: 'blocksFormatFetcher' }, { kind: 'thunk', name: 'bindVideo' }, { kind: 'thunk', name: 'gone' },
];

test('watch: every shape Taut can resolve counts, a plain function is not a meta registration', () => {
  const r = finishPresence(scanWatched(js, watch), watch);
  assert.equal(r.watched.length, 10);
  assert.equal(r.watched.length, 10);
  assert.ok(r.found['fn:getActiveHuddleCallId'], 'a thunk/byMeta name that exists as a plain function is remembered');
  assert.deepEqual(Object.keys(r.found).filter((k) => !k.startsWith('fn:')).sort(), ['byMeta:getActiveHuddleTeamId', 'byName:getActiveHuddleCallId', 'component:MenuFromTemplate', 'component:Panel', 'component:Serialized(Panel)', 'thunk:bindVideo', 'thunk:blocksFormatFetcher']);
  assert.deepEqual(r.found['component:Panel'].forms, ['class', 'displayName']);
  assert.deepEqual(r.found['thunk:blocksFormatFetcher'].forms, ['fetcher']);
  assert.match(r.found['component:MenuFromTemplate'].modules[0], /^Ab12:[0-9a-f]{8}$/);
  assert.ok(!('byMeta:getActiveHuddleCallId' in r.found), 'byMeta needs a registration, a declared function is only a byName match');
});
