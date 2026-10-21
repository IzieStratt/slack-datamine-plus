import test from 'node:test';
import assert from 'node:assert/strict';
import { extractExtras, finishExperiments, scanExperiments } from '../src/extras.mjs';

const selectors = 'QSkg(e,t,n){"use strict";var i=n("WDEk");let u=(0,i.Ay)((e,t)=>t);u.meta={name:"getGroupForUser",key:"k"};let m=(0,i.Ay)((e,t)=>t);m.meta={name:"getGroupForUserWithoutExposure",key:"k"};n.d(t,{},{_Z:u,ze:m})}';
const user = 'T(e,t,n){"use strict";var c=n("QSkg"),d=n("BN6C");let u="on"===(0,c._Z)(e,"desktop_ui_simplification");let s=(0,c.ze)(e,"two_groups");return["a","b"].includes((0,c._Z)(e,"listed"))||"x"===s||(0,c._Z)(e,"after")==="y"||(0,d._Z)(e,"not_an_experiment")}';

test('experiments: names and groups found through the selector module', () => {
  const r = finishExperiments([scanExperiments(selectors), scanExperiments(user)]);
  assert.equal(r.selectorModules, 1);
  assert.deepEqual(r.experiments.desktop_ui_simplification, ['on']);
  assert.deepEqual(r.experiments.listed, ['a', 'b']);
  assert.deepEqual(r.experiments.after, ['y']);
  assert.deepEqual(r.experiments.two_groups, ['x']);
  assert.equal('not_an_experiment' in r.experiments, false);
});

test('extras: one hit per category', () => {
  const x = extractExtras('a.FOO_BAR="foo";a.AI_THING="ai_thing";a.MCP_X="mcp_x";if(e.error==="channel_not_found");{name:"/shrug"};{name:"/slackperf"};log.track("PFP_ACTION");startSpan("huddle_tti");icon:"close";keys:["mod+k"];i.t("Hello there");"search:read.im";"workflow_id";"x_notification"');
  assert.ok(x.errors.has('channel_not_found') && x['slash-commands'].has('/shrug') && x['dev-commands'].has('/slackperf'));
  assert.ok(x['analytics-events'].has('PFP_ACTION') && x['trace-spans'].has('huddle_tti') && x.icons.has('close'));
  assert.ok(x.shortcuts.has('mod+k') && x['ui-strings'].has('Hello there') && x.scopes.has('search:read.im'));
  assert.ok(x['ai-enums'].has('AI_THING=ai_thing') && x['mcp-enums'].has('MCP_X=mcp_x') && x.workflow.has('workflow_id') && x['notification-types'].has('x_notification'));
});
