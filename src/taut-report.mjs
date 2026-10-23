#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// File the taut-watch report where it belongs: ONE issue on the Taut repo itself, written as the account behind TAUT_ISSUES_TOKEN (not the
// Actions bot). Without that token nothing is filed (the report is still in the job summary), so there are never stray issues in this repo.
//   node src/taut-report.mjs [--dry] [taut-result.json] [taut-report.md]      env: GH_TOKEN, UPSTREAM=true, TAUT_REPO=owner/name
// Behaviour: open when something Taut looks up is missing or the code behind one changed recently; edit the body as the report changes;
// comment when NEW names go missing (that is what notifies); close it when all is well. If the maintainer closes it, stay quiet: only file
// again when a name goes missing that the closed issue never mentioned. Never fails the run.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const dry = process.argv.includes('--dry');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const result = JSON.parse(fs.readFileSync(files[0] || 'taut-result.json', 'utf8'));
const report = fs.readFileSync(files[1] || 'taut-report.md', 'utf8');
const repo = process.env.TAUT_REPO || 'jeremy46231/taut';
if (process.env.UPSTREAM !== 'true' && !dry) { console.log('no TAUT_ISSUES_TOKEN set: not filing an issue (the report is in the job summary)'); process.exit(0); }

const gh = (...a) => (dry ? (console.log('gh', a.join(' ')), '') : execFileSync('gh', a, { encoding: 'utf8' }));
const TITLE = "Automated check: names Taut looks up that changed in Slack's web client";
const intro = `> Automated report from [slack-datamine-plus](https://github.com/IzieStratt/slack-datamine-plus) (workflow \`taut-watch\`, run by IzieStratt). It compares the names Taut looks up in Slack's client with Slack's current **web** build, so a name missing here may still exist in the desktop build or in the client's boot bundle, which the miner can't reach yet. This issue edits itself as things change and comments when new names go missing. Close it to silence it: it won't be reopened or filed again unless a name goes missing that this issue never mentioned.\n\n`;
const body = intro + report;

let issues = [];
try { issues = JSON.parse(gh('issue', 'list', '--repo', repo, '--author', '@me', '--state', 'all', '--search', `in:title "Automated check: names Taut looks up"`, '--limit', '20', '--json', 'number,state,body') || '[]'); } catch { issues = []; }
const open = issues.find((i) => i.state === 'OPEN'), closed = issues.find((i) => i.state === 'CLOSED');
const wanted = result.missing.length > 0 || result.recentChanges > 0;

if (!wanted) {
  if (open) gh('issue', 'close', String(open.number), '--repo', repo, '--comment', 'Everything Taut looks up is present in the current web build and nothing it uses changed recently.');
  console.log(open ? 'all clear; closed the issue' : 'all clear');
  process.exit(0);
}
if (open) {
  const n = String(open.number);
  if (open.body.trim() !== body.trim()) gh('issue', 'edit', n, '--repo', repo, '--body', body);
  if (result.newMissing.length) gh('issue', 'comment', n, '--repo', repo, '--body', `Newly missing in build \`${result.build}\`: ${result.newMissing.map((k) => `\`${k.split(':').slice(1).join(':')}\` (${k.split(':')[0]})`).join(', ')}. See the report above.`);
  console.log('updated the issue');
} else if (closed && result.missing.every((k) => closed.body.includes(k.split(':').slice(1).join(':')))) {
  console.log('the issue was closed and nothing new is missing; staying quiet');
} else {
  gh('issue', 'create', '--repo', repo, '--title', TITLE, '--body', body);
  console.log('opened an issue');
}
