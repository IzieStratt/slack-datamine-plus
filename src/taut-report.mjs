#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Keep ONE GitHub issue (label `taut-watch`) in step with taut-result.json / taut-report.md from src/taut-watch.mjs:
//   open when something Taut looks up is missing or the module behind it changed recently, edit it as the report changes,
//   comment when new names go missing (that is what notifies), close it when everything is fine again. Never fails the run. `--dry` prints.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const dry = process.argv.includes('--dry');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const result = JSON.parse(fs.readFileSync(files[0] || 'taut-result.json', 'utf8'));
const report = fs.readFileSync(files[1] || 'taut-report.md', 'utf8');
const gh = (...a) => (dry ? (console.log('gh', a.join(' ')), '') : execFileSync('gh', a, { encoding: 'utf8' }));
const LABEL = 'taut-watch', TITLE = 'taut-watch: Slack changed things Taut uses';
let open = [];
try { open = JSON.parse(gh('issue', 'list', '--label', LABEL, '--state', 'open', '--json', 'number,body') || '[]'); } catch { open = []; }
const wanted = result.missing.length > 0 || result.recentChanges > 0;
if (!wanted) {
  for (const i of open) gh('issue', 'close', String(i.number), '--comment', 'Everything Taut looks up is present and nothing it uses changed recently.');
  console.log(open.length ? 'all clear; closed the issue' : 'all clear');
  process.exit(0);
}
try { gh('label', 'create', LABEL, '--color', 'FBCA04', '--description', 'Slack changed something Taut looks up in the client'); } catch { /* exists */ }
if (!open.length) { gh('issue', 'create', '--title', TITLE, '--label', LABEL, '--body', report); console.log('opened an issue'); process.exit(0); }
const n = String(open[0].number);
if (open[0].body.trim() !== report.trim()) gh('issue', 'edit', n, '--body', report);
if (result.newMissing.length) gh('issue', 'comment', n, '--body', `Newly missing in build \`${result.build}\`: ${result.newMissing.map((k) => `\`${k.split(':').slice(1).join(':')}\` (${k.split(':')[0]})`).join(', ')}. See the report above.`);
console.log(`updated the issue${result.newMissing.length ? ' and commented' : ''}`);
