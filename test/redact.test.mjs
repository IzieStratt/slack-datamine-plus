import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// redact() lives in mine.mjs, which runs main() on import, so test the same regexes from source text.
const src = fs.readFileSync(new URL('../src/mine.mjs', import.meta.url), 'utf8');
const body = src.match(/export const redact = \(t\) => t([\s\S]*?);\nconst writeDebug/)[1];
const redact = new Function('t', `return t${body};`);

test('redact strips xox tokens and token-ish JSON fields', () => {
  const out = redact('{"api_token":"xoxc-1234567890-abcdef","x":"xoxd-AAAAAAAAAA%2Bbb","d":"abcdefghijkl"}');
  assert.ok(!/xox[a-z]-\d/.test(out) && !out.includes('AAAAAAAAAA') && !out.includes('abcdefghijkl'), out);
});
