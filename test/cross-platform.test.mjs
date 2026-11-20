import test from 'node:test';
import assert from 'node:assert/strict';
import { crossPlatform, serialize } from '../src/cross-platform.mjs';

test('crossPlatform lists the platforms each name is on and keeps unmined platforms as null', () => {
  const o = crossPlatform({
    web: { methods: ['chat.postMessage', 'files.list'], flags: ['shared_flag', 'web_only'] },
    desktop: { methods: ['app.quit'], flags: null },
    android: { methods: ['chat.postMessage'], flags: ['android_x', 'shared_flag'] },
    ios: { methods: null, flags: null },
  });
  assert.deepEqual(o.apiMethods, { 'app.quit': ['desktop'], 'chat.postMessage': ['web', 'android'], 'files.list': ['web'] });
  assert.deepEqual(o.featureFlags, { android_x: ['android'], shared_flag: ['web', 'android'], web_only: ['web'] });
  assert.deepEqual(o.coverage.ios, { apiMethods: null, featureFlags: null });
  assert.deepEqual(o.coverage.desktop, { apiMethods: 1, featureFlags: null });
  assert.deepEqual(o.summary.apiMethods, { desktop: 1, web: 1, 'web+android': 1 });
  assert.deepEqual(JSON.parse(serialize(o)), o, 'the line-per-row serialization is plain JSON');
});
