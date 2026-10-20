// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractParams, mergeParams, serializeParams } from '../src/params.mjs';

const chunk = `let en=(0,S.r)("slackbotProjectsCreateFetcher","slackbot.projects.create");
async function go(){let e=await a(en({reason:"slackbot-ai-project-create",name:O,description:B||void 0,systemPrompt:V,...rest}));}
function local(){en({key:J,projectId:1})}`;

test('collects keys from the dispatch call site only', () => {
  const m = extractParams(chunk).get('slackbot.projects.create');
  assert.deepEqual([...m.keys()].sort(), ['description', 'name', 'reason', 'systemPrompt']);
  assert.equal(m.get('reason').types.has('string'), true);
});

test('handles imported fetchers, quoted keys, shorthand and nested braces', () => {
  const js = `t5=(0,n("YTsv").r)("clientCodeChannelsMergePullRequestFetcher","client.codeChannels.mergePullRequest");x=await d(t5({channelId:c,"pr_url":u,headSha,opts:{a:1,b:[1,2]},n:3}))`;
  const m = extractParams(js).get('client.codeChannels.mergePullRequest');
  assert.deepEqual([...m.keys()].sort(), ['channelId', 'headSha', 'n', 'opts', 'pr_url']);
  assert.equal(serializeParams(m).n.type, 'number');
  assert.equal(serializeParams(m).opts.type, 'object');
});

test('mergeParams sums call sites across chunks', () => {
  const a = extractParams(`z=(0,S.r)("aFetcher","a.b");q(z({k:1}))`);
  const b = extractParams(`z=(0,S.r)("aFetcher","a.b");q(z({k:2,j:!0}))`);
  const t = mergeParams(new Map(), a); mergeParams(t, b);
  assert.equal(t.get('a.b').get('k').sites, 2);
  assert.equal(serializeParams(t.get('a.b')).j.type, 'boolean');
});
