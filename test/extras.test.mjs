import test from 'node:test';
import assert from 'node:assert/strict';
import { extractExtras, finishBlockRegistry, finishExperiments, scanExperiments } from '../src/extras.mjs';

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

test('extras: design tokens, internal paths and hosts', () => {
  const x = extractExtras('{"property":"--dt_color-content-pry"};var a="--dt_color-plt-"+b;var u="/admin/billing";var v="/customize/slackbot";var h="https://files.slack.com/x";var d="https://dev1739.slack.com/";var n="/notadmin/x"');
  assert.deepEqual([...x['design-tokens']], ['--dt_color-content-pry']);
  assert.deepEqual([...x.paths].sort(), ['/admin/billing', '/customize/slackbot']);
  assert.deepEqual([...x.hosts], ['files.slack.com']);
});

test('experiments: newer selector module shape (inline exports calling getGroupForUserImpl)', () => {
  const selectors = 'pR6y(H,q,G){"use strict";let getAssignmentByName=(H,q)=>H?.experiments?.[q],getGroupForUserImpl=(H,q,{shouldLogExposure:G=!0}={})=>{let e=getAssignmentByName(H,q);return e?e.group:null};G.d(q,{},{KK:getAssignmentByName,_Z:(H,q,G=!0)=>getGroupForUserImpl(H,q,{shouldLogExposure:G}),ze:(H,q)=>getGroupForUserImpl(H,q,{shouldLogExposure:!1})})}';
  const user = 'T(e,t,n){"use strict";var c=n("pR6y");let u="on"===(0,c._Z)(e,"new_thing");return["a","b"].includes((0,c.ze)(e,"other_thing"))}';
  const r = finishExperiments([scanExperiments(selectors), scanExperiments(user)]);
  assert.equal(r.selectorModules, 1);
  assert.deepEqual(r.experiments.new_thing, ['on']);
  assert.deepEqual(r.experiments.other_thing, ['a', 'b']);
});

test('block registry: registered types, component fields and gated prototype candidates', () => {
  const js = 'let Tag=({blockId:e,text:t,tagStyle:n="x",renderBlocks:r})=>null;let o=(0,a("KPrg").R)()({type:"tag_block",component:()=>Tag,processProps:e=>(0,n.W)(e)});'
    + 'let L=(0,a("x").R)()({type:"lazy",component:()=>i.A});'
    + 'PrototypeImpl=({renderBlocks:e,...c})=>{let m=(0,o.d4)(e=>"on"===(0,N._Z)(e,"bk_next"));switch(c.candidateType){case"chart":if(!m)return null;return 1;case"form_card":return 2}}';
  const out = [...extractExtras(js)['block-registry']].sort();
  assert.deepEqual(out, ['fields: tag_block: text, tag_style', 'prototype: chart (experiment bk_next)', 'prototype: form_card', 'registered: lazy', 'registered: tag_block']);
});

test('block registry: lazy blocks and prototype candidates get fields from a component in another chunk', () => {
  const reg = 'let o=r.lazy(async()=>({default:(await n.e("page-block").then(n.bind(n,"zKAH"))).PageBlock})),PageBlockLazy=e=>null,c=(0,n("9WPe").R)()({type:"page",component:()=>PageBlockLazy});'
    + 'tE=a.lazy(()=>Promise.all([n.e("chart")]).then(e=>({default:e.ChartBlock})));'
    + 'PrototypeImpl=({renderBlocks:e,...c})=>{let h=(0,o.d4)(e=>"on"===(0,N._Z)(e,"bk_next"));switch(c.candidateType){case"chart":if(!h)return null;return(0,s.jsx)(a.Suspense,{fallback:null,children:(0,s.jsx)(tE,{...c})});'
    + 'case"checklist":{if(!h)return null;let{blockId:n,title:a,showProgress:d}=c;return 1}default:return null}}';
  const lazy = ';function PageBlock({fileId:e,appId:t}){return null};let ChartBlock=({chartType:e,title:t})=>null;';
  const x = extractExtras(reg); extractExtras(lazy, x);
  assert.deepEqual(finishBlockRegistry([...x['block-registry']]).sort(), [
    'fields: page: file_id, app_id', 'fields: prototype/chart: chart_type, title', 'fields: prototype/checklist: title, show_progress',
    'prototype: chart (experiment bk_next)', 'prototype: checklist (experiment bk_next)', 'registered: page']);
});
