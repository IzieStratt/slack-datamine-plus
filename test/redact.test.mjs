// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// redact() lives in mine.mjs, which runs main() on import, so evaluate just that definition.
const src = fs.readFileSync(new URL('../src/mine.mjs', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('export const redact'), src.indexOf('const writeDebug'));
const ctx = { process: { env: { SLACK_D_COOKIE: 'xoxd-SeCrEt%2Bvalue%3D' } }, encodeURIComponent, decodeURIComponent };
vm.createContext(ctx);
vm.runInContext(block.replace('export const redact =', 'redact =').replace('const safeDecode =', 'safeDecode ='), ctx);
const redact = ctx.redact;

const SECRETS = [
  'xoxc-1234567890-abcdef', 'xoxd-AbC%2Bdef%3D%3D', 'd%3Dxoxd-AAAA%2Fzz', '{token:"xoxc-12345"}', "{api_token:'abcdefgh'}",
  'api_token=abcdefgh1234', '&token=zzzzzzzz', 'xoxe.xoxp-1-AAAA-BBBB', 'xoxd-SeCrEt%2Bvalue%3D', 'xoxd-SeCrEt+value=', '"email":"someone@example.com"',
];
for (const s of SECRETS) {
  test(`redacts ${s}`, () => {
    const out = redact(`before ${s} after`);
    assert.ok(!/xox[a-z]?[.-]\w/.test(out) && !/abcdefgh|zzzzzzzz|SeCrEt|someone@/.test(out), out);
  });
}

// Generated outputs added later (history, cross-platform table, plugin API, search page) are derived from build/ lists only. Check
// that nothing token- or account-shaped made it into the committed ones; the search page is built from the same history file.
test('generated outputs carry no tokens or account details', () => {
  const files = ['build/history.tsv', 'build/cross-platform.json', 'build/plugin-api/components.v1.json', 'build/plugin-api/redux.v1.json'];
  for (const f of files) {
    const u = new URL(`../${f}`, import.meta.url);
    if (!fs.existsSync(u)) continue;
    const t = fs.readFileSync(u, 'utf8');
    assert.ok(!/xox[a-z]?[.-][A-Za-z0-9-]{6,}/.test(t), `${f}: token-shaped value`);
    assert.ok(!/xoxd-SeCrEt/.test(t) && !/d%3Dxoxd/.test(t), `${f}: cookie`);
    assert.ok(!/"email"\s*:\s*"[^"@]+@/.test(t), `${f}: email field`);
  }
});
