// SPDX-License-Identifier: AGPL-3.0-only
// Everything the miner collects besides API methods and params: experiments (+ groups), enums, error codes, scopes, slash commands,
// analytics events, workflow names, notification types, trace spans, icons, shortcuts, dev commands and UI strings.
// Pure functions over one chunk's text, so they run per chunk and merge by set union.

const S = String.raw;
const str = S`"((?:[^"\\\n]|\\.)*)"`;

// ---- experiments -------------------------------------------------------------------------------------------------------------
// Same idea as taut's Experiments plugin (plugins/Experiments.tsx scanCode), done statically:
//   1. find the selector module (the one whose selectors carry .meta = {name: "getGroupForUser"}) and its minified export keys,
//   2. find every module that imports it and calls `(0,alias.key)(state, "experiment_name")`,
//   3. read the group strings that call is compared to: `"on"===call`, `call==="on"`, `["a","b"].includes(call)`, or `let x=call` then `x==="on"`.
// Module ids are global across chunks, so (1) and (2) are collected separately and joined in finishExperiments().
const MODULE_HEAD = /(?:^|[,{;])\s*("[^"\\]+"|[\w$-]+)\(\w(?:,\w){1,2}\)\{"use strict";/g;
const GROUP_SELECTORS = new Set(['getGroupForUser', 'getGroupForUserWithoutExposure', 'getGroupForUserImpl', 'getAssignmentByName']);
const CALL_RE = /\(0,([\w$]+)\.([\w$]+)\)\(([^,()]{1,40}),"([a-z][\w.-]{2,120})"[^()]{0,24}\)/g;
const IMPORT_RE = /[\s,;]([\w$]+)=\w\("([^"\\]+)"\)/g;

function modules(js) {
  const heads = [...js.matchAll(MODULE_HEAD)];
  return heads.map((m, i) => ({ id: m[1].replace(/^"|"$/g, ''), src: js.slice(m.index, heads[i + 1]?.index ?? js.length) }));
}

const groupsAround = (src, at, len, groups) => {
  const before = src.slice(Math.max(0, at - 90), at), after = src.slice(at + len, at + len + 60);
  const b = before.match(/(?:"([^"\\]{1,80})"\s*[!=]==?\s*|\[((?:"[^"\\]{1,80}",?){1,8})\]\.includes\()$/);
  if (b?.[1]) groups.add(b[1]);
  for (const g of b?.[2]?.matchAll(/"([^"]+)"/g) ?? []) groups.add(g[1]);
  const a = after.match(/^\s*[!=]==?\s*"([^"\\]{1,80})"/);
  if (a) groups.add(a[1]);
  // `let t=call; ... "on"===t`
  const v = before.match(/(?:let|var|const|,)\s*([\w$]+)\s*=\s*(?:!!)?$/)?.[1];
  if (v) {
    const tail = src.slice(at + len, at + len + 700), e = v.replace(/\$/g, '\\$');
    for (const m of tail.matchAll(new RegExp(S`(?<![\w$.])${e}\s*[!=]==?\s*"([^"\\]{1,80})"|"([^"\\]{1,80})"\s*[!=]==?\s*${e}(?![\w$])`, 'g'))) groups.add(m[1] ?? m[2]);
    for (const m of tail.matchAll(new RegExp(S`\[((?:"[^"\\]{1,80}",?){1,8})\]\.includes\(${e}\)`, 'g'))) for (const g of m[1].matchAll(/"([^"]+)"/g)) groups.add(g[1]);
  }
};

export function scanExperiments(js) {
  const defs = [], uses = [];
  for (const { id, src } of modules(js)) {
    if (src.includes('name:"getGroupForUser"')) {
      const names = new Map([...src.matchAll(/([\w$]+)\.meta=\{name:"(\w+)"/g)].map((m) => [m[1], m[2]]));
      const exp = src.match(/\w\.d\(\w,\{\},\{([^}]*)\}\)/)?.[1] ?? '';
      const keys = {};
      for (const m of exp.matchAll(/([\w$]+):([\w$]+)/g)) if (names.has(m[2])) keys[m[1]] = names.get(m[2]);
      if (Object.keys(keys).length) defs.push({ id, keys });
    }
    if (!src.includes(',"')) continue;
    const alias = new Map([...src.matchAll(IMPORT_RE)].map((m) => [m[1], m[2]]));
    for (const m of src.matchAll(CALL_RE)) {
      const mod = alias.get(m[1]);
      if (!mod) continue;
      const groups = new Set();
      groupsAround(src, m.index, m[0].length, groups);
      uses.push({ mod, key: m[2], name: m[4], groups: [...groups] });
    }
  }
  return { defs, uses };
}

export function finishExperiments(parts) {
  const sel = new Map();
  for (const p of parts) for (const d of p.defs) sel.set(d.id, { ...sel.get(d.id), ...d.keys });
  const out = new Map();
  for (const p of parts) for (const u of p.uses) {
    if (!GROUP_SELECTORS.has(sel.get(u.mod)?.[u.key])) continue;
    const e = out.get(u.name) ?? new Set();
    out.set(u.name, e);
    u.groups.forEach((g) => e.add(g));
  }
  return { selectorModules: sel.size, experiments: Object.fromEntries([...out].sort(([a], [b]) => a.localeCompare(b)).map(([n, g]) => [n, [...g].sort()])) };
}

// ---- everything else ---------------------------------------------------------------------------------------------------------
const ZOD = new Set(['invalid_type', 'invalid_format', 'too_small', 'too_big', 'invalid_value', 'invalid_union', 'invalid_key', 'invalid_element', 'unrecognized_keys', 'not_multiple_of', 'custom']);
const ERR_SUFFIX = /(_not_found|_denied|_failed|_invalid|_required|_restricted|_error|_exceeded|_limit|_disabled|_archived|_expired|_missing|_forbidden|_not_allowed|_unavailable|_too_long|_too_short|_taken|_blocked)$|^(invalid_|no_|not_|cant_|cannot_|user_is_|team_|channel_|ratelimited|internal_error|fatal_error|missing_|access_)/;
const SCOPE_RE = /"([a-z_]+(?:\.[a-z_]+)?:(?:read|write|history|manage|execute|create|delete|invite|bookmark|view|edit)(?:\.[a-z_]+)?)"/g;
const BLOCK_TYPE = /^(section|actions|context|context_actions|divider|header|image|input|rich_text(?:_[a-z_]+)?|table|card|carousel|alert|video|file|markdown|plan|task_card|call|[a-z_]+_(?:select|input|picker|menu|button)s?|button|checkboxes|radio_buttons|overflow|static_select|datepicker|timepicker|datetimepicker|plain_text|mrkdwn|feedback_buttons|icon_button|url_source|workflow_button|image_url)$/;
const ENUM_RE = /(?<![\w$])[A-Za-z_$]{1,3}\.([A-Z][A-Z0-9_]{2,})="([^"\\]{1,100})"/g;
const SHORTCUT = /^(?:(?:mod|ctrl|cmd|command|shift|alt|opt|option|meta)\+)+[^"\s]+$|^(?:shift\+)?(?:tab|enter|esc|escape|space|pageup|pagedown|up|down|left|right)$/i;

const CATEGORIES = [
  'errors', 'scopes', 'slash-commands', 'dev-commands', 'analytics-events', 'workflow', 'notification-types', 'trace-spans', 'icons',
  'shortcuts', 'feature-flags', 'ui-strings', 'enums', 'ai-enums', 'mcp-enums', 'blockkit-enums', 'design-tokens', 'paths', 'hosts',
];
export const emptyExtras = () => Object.fromEntries(CATEGORIES.map((c) => [c, new Set()]));

export function extractExtras(js, into = emptyExtras()) {
  const add = (c, v) => { if (v && v.length < 400) into[c].add(v); };
  // error codes
  for (const m of js.matchAll(/\b(?:error|err|code|reason|error_code|errorCode)\s*(?:[!=]==?|:)\s*"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"/g)) if (!ZOD.has(m[1])) add('errors', m[1]);
  for (const m of js.matchAll(/case"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)":/g)) if (!ZOD.has(m[1]) && ERR_SUFFIX.test(m[1])) add('errors', m[1]);
  for (const m of js.matchAll(SCOPE_RE)) add('scopes', m[1]);
  // slash commands; the /slack* ones are the hidden dev/debug commands
  for (const m of js.matchAll(/(?:name|command|canonicalName)\s*:\s*(?:\(\)\s*=>\s*)?"(\/[a-z][a-z0-9_-]*)"/g)) add(/^\/(slack|dev)[a-z]/.test(m[1]) ? 'dev-commands' : 'slash-commands', m[1]);
  for (const m of js.matchAll(/\b(?:track|logEvent|trackEvent|clogEvent|logUserEvent|logClogEvent)\("([^"\\]{2,80})"/g)) add('analytics-events', m[1]);
  for (const m of js.matchAll(/"([a-z][a-z0-9]*(?:_[a-z0-9]+)*)"/g)) {
    const v = m[1];
    if (/workflow|(^|_)function_|(^|_)wfb(_|$)/.test(v)) add('workflow', v);
    if (/notif/.test(v)) add('notification-types', v);
    if (v.startsWith('feature_') && !/^feature_(request|view|not_enabled|disabled)/.test(v)) add('feature-flags', v);
  }
  for (const m of js.matchAll(/\b(?:features?|featureFlags?)(?:\.|\[")([a-z][a-z0-9_]{2,})/g)) add('feature-flags', m[1]);
  for (const m of js.matchAll(/\b(?:isFeatureEnabled|getFeatureFlag|hasFeature)\("([a-z][a-z0-9_]+)"/g)) add('feature-flags', m[1]);
  for (const m of js.matchAll(/\b(?:startSpan|startActiveSpan|startInactiveSpan|withSpan|traceSpan)\(\s*"([^"\\]{2,100})"/g)) add('trace-spans', m[1]);
  for (const m of js.matchAll(/\b(?:icon|iconName|leadingIcon|trailingIcon)\s*[:=]\s*"([a-z][a-z0-9_-]{1,50})"/g)) add('icons', m[1]);
  for (const m of js.matchAll(/\bname:"([a-z][a-z0-9-]+)",size/g)) add('icons', m[1]);
  for (const m of js.matchAll(/\bkeys?\s*:\s*\[((?:"[^"\\]+",?)+)\]/g)) for (const k of m[1].matchAll(/"([^"]+)"/g)) if (SHORTCUT.test(k[1])) add('shortcuts', k[1]);
  for (const m of js.matchAll(/"((?:(?:mod|ctrl|cmd|shift|alt|opt)\+)+[^"\s]+)"/g)) add('shortcuts', m[1]);
  // UI strings: i18n calls `x.t("...")`
  for (const m of js.matchAll(/\.t\("((?:[^"\\\n]|\\.){2,300})"/g)) add('ui-strings', m[1]);
  // enums (TS enums compile to `a.NAME="value"`) and their AI / MCP / Block Kit slices
  for (const m of js.matchAll(ENUM_RE)) {
    const [, name, val] = m, line = `${name}=${val}`;
    add('enums', line);
    if (/^(AI|ASSISTANT|SLACKBOT|SLACK_AI|AGENT|LLM|CLAUDE)(_|$)/.test(name) || /^(ai|assistant|agent|slackbot)_/.test(val)) add('ai-enums', line);
    if (/mcp/i.test(name) || /mcp/i.test(val)) add('mcp-enums', line);
    if (/^(BLOCK|ELEMENT|RICH_TEXT)/.test(name) || BLOCK_TYPE.test(val) && /BLOCK|ELEMENT|TYPE/.test(name)) add('blockkit-enums', line);
  }
  for (const m of js.matchAll(/\btype:"([a-z_]+)"/g)) if (BLOCK_TYPE.test(m[1]) && m[1].length > 3) add('blockkit-enums', `type=${m[1]}`);
  // design-system CSS variables (--dt_color-..., --dt_static_space-...); a trailing '-' is a prefix used to build names, not a token
  for (const m of js.matchAll(/(--dt_[a-z0-9]+(?:[_-][a-z0-9]+)*)(?![\w-])/g)) add('design-tokens', m[1]);
  // quoted internal page/endpoint paths ("/admin/billing", "/customize/slackbot") and the slack-owned hosts the client talks to
  for (const m of js.matchAll(/["'`](\/(?:admin|customize|account|ssb|enterprise|services|archives|apps|help|signin|workspace|beacon)(?:\/[A-Za-z0-9_.$-]+)*)["'`]/g)) add('paths', m[1]);
  for (const m of js.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:slack|slack-edge|slack-files|slack-msgs|slack-imgs|slack-redir|slackb|slack-core|slack-gov)\.com)(?![\w.-])/g)) if (!/^dev\d+\./.test(m[1])) add('hosts', m[1]);
  return into;
}

export const mergeExtras = (a, b) => { for (const c of CATEGORIES) b[c].forEach((v) => a[c].add(v)); return a; };
