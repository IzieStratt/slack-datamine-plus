import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIndex } from '../src/history.mjs';
import { searchData, searchPage } from '../src/search-page.mjs';

const tsv = '# header\napi-methods\tchat.postMessage\t2026-10-19\t\t\napi-methods\told.method\t2026-10-01\t2026-10-20\t2026-10-21\nexperiments\t</script><b>x\t2026-11-01\t\t\nfeature-flags\tRolloutState: shared_flag\t2026-11-02\t\t\n';
const cross = { apiMethods: { 'chat.postMessage': ['web', 'android'] }, featureFlags: { shared_flag: ['web', 'android'] } };

test('searchData interns categories and dates and attaches platforms', () => {
  const d = searchData(parseIndex(tsv), cross);
  assert.deepEqual(d.cats, ['api-methods', 'experiments', 'feature-flags']);
  assert.deepEqual(d.dates, ['2026-10-01', '2026-10-19', '2026-10-20', '2026-10-21', '2026-11-01', '2026-11-02']);
  assert.deepEqual(d.rows[0], [0, 'chat.postMessage', 1, -1, -1, 0b101]);
  assert.deepEqual(d.rows[1], [0, 'old.method', 0, 2, 3, 0]);
  assert.equal(d.rows[3][5], 0b101, 'flags match without their "Kind: " prefix');
});

test('searchPage inlines the data without letting a value close the script', () => {
  const html = searchPage(searchData(parseIndex(tsv), cross), { generated: '2026-11-15' });
  assert.equal(html.match(/<\/script>/g).length, 2, 'only the two real script ends');
  const json = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(json).rows[2][1], '</script><b>x');
  assert.ok(!/https?:\/\/(?!json-schema)/.test(html.replace(/<p id="foot"[\s\S]*?<\/p>/, '')), 'no external requests');
});
