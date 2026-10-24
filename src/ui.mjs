// SPDX-License-Identifier: AGPL-3.0-only
// Pieces shared by the pages this repo generates for https://sdmp.izie.top (feed index, icons gallery).
// They rely on the site's /style.css variables (--bg, --fg, --focus), so both themes work; links use the site's pill `nav a` style.

export const SEARCH_CSS = `
.search { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: .75rem; margin: 0 0 1.25rem; padding: .6rem 0; background: var(--bg); }
.search-field { position: relative; flex: 1 1 auto; max-width: 34rem; }
.search-field svg { position: absolute; left: .9rem; top: 50%; width: 1.05rem; height: 1.05rem; transform: translateY(-50%); fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; opacity: .65; pointer-events: none; }
.search input { box-sizing: border-box; width: 100%; padding: .55rem 1rem .55rem 2.6rem; border: 2px solid var(--fg); border-radius: 999px; background: var(--bg); color: var(--fg); font: inherit; font-size: 1rem; -webkit-appearance: none; appearance: none; transition: box-shadow 150ms ease, border-color 150ms ease; }
.search input::placeholder { color: var(--fg); opacity: .5; }
.search input:focus { outline: none; border-color: var(--focus); box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 30%, transparent); }
.search input::-webkit-search-cancel-button { cursor: pointer; }
#count { white-space: nowrap; opacity: .75; font-size: .95rem; }
@media (prefers-reduced-motion: reduce) { .search input { transition: none; } }
`;

export const searchHtml = (placeholder, label) => `<div class="search"><div class="search-field"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="q" type="search" placeholder="${placeholder}" aria-label="${label}" autocomplete="off" spellcheck="false"></div><span id="count" aria-live="polite"></span></div>`;

// one line per link; items whose file does not exist are left out by the caller
export const pills = (links) => `<nav aria-label="Links"><ul>${links.map(([href, text]) => `<li><a href="${href}">${text}</a></li>`).join('')}</ul></nav>`;
