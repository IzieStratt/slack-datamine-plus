#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Turn build/health.json into a GitHub issue. One open issue labelled `mine-health` tracks the current gaps: it is opened when a run finds
// problems, edited when the set changes, and closed when a run is clean again. Exits 1 only when the problem set is new or changed, so the
// failed run (and its email) happens once per change rather than every 30 minutes. `--dry` prints what it would do.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const dry = process.argv.includes('--dry');
const health = JSON.parse(fs.readFileSync(process.argv.find((a) => a.endsWith('.json')) || 'build/health.json', 'utf8'));
const gh = (...a) => (dry ? (console.log('gh', a.join(' ')), '') : execFileSync('gh', a, { encoding: 'utf8' }));
const TITLE = 'mine health: gaps in the latest run';
const LABEL = 'mine-health';
const run = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
const body = (ps) => `The last mine run found gaps. These categories or sources may be frozen until this is fixed:\n\n${ps.map((p) => `- ${p}`).join('\n')}\n${run ? `\nLatest run: ${run}\n` : ''}\nThis issue closes by itself when a run is clean.`;

let open = [];
try { open = JSON.parse(gh('issue', 'list', '--label', LABEL, '--state', 'open', '--json', 'number,body') || '[]'); } catch { open = []; }
if (!health.problems.length) {
  for (const i of open) gh('issue', 'close', String(i.number), '--comment', 'The latest run is clean again.');
  console.log(open.length ? 'health ok; closed the open issue' : 'health ok');
  process.exit(0);
}
try { gh('label', 'create', LABEL, '--color', 'B60205', '--description', 'The miner found a gap in what it mined'); } catch { /* exists */ }
const text = body(health.problems);
const same = (i) => i.body.split('\nLatest run:')[0] === text.split('\nLatest run:')[0];
if (open.length && same(open[0])) { console.log('same problems as the open issue; not alerting again'); for (const p of health.problems) console.error(`::warning::${p}`); process.exit(0); }
if (open.length) gh('issue', 'edit', String(open[0].number), '--body', text);
else gh('issue', 'create', '--title', TITLE, '--label', LABEL, '--body', text);
for (const p of health.problems) console.error(`::error::${p}`);
process.exit(1);
