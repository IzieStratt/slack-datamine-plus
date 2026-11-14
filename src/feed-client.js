// SPDX-License-Identifier: AGPL-3.0-only
// Inlined into the feed page by feed.mjs. The page holds the first rows of each list; the full lists live in days/<slug>.json
// ({ cats: [{ t: title, s: sign, v: values }] }), fetched when an "…and N more" expander opens and, all at once, on the first search.
// Search runs over those strings, not the DOM, and renders only the matches into #results.
(() => {
  const q = document.getElementById('q'), count = document.getElementById('count'), results = document.getElementById('results');
  const fresh = document.getElementById('fresh') || {};
  const items = [...document.querySelectorAll('main > .item')];
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const days = new Map(); // slug -> Promise<day json>
  const day = (slug) => {
    if (!days.has(slug)) days.set(slug, fetch('days/' + encodeURIComponent(slug) + '.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).catch((e) => { days.delete(slug); throw e; }));
    return days.get(slug);
  };
  const rows = (v, s, re) => v.map((x) => '<li>' + esc(s) + '<code>' + (re ? hl(x, re) : esc(x)) + '</code></li>').join('');
  const hl = (x, re) => x.split(re).map((p, i) => (i % 2 ? '<mark>' + esc(p) + '</mark>' : esc(p))).join('');

  // "…and N more": fill the empty list from the day's JSON the first time it opens
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.classList?.contains('more') || !d.open || d.dataset.done) return;
    const sec = d.closest('.item'), k = +d.parentElement.dataset.k, ul = d.querySelector('ul');
    d.dataset.done = 1; ul.innerHTML = '<li>loading…</li>';
    day(sec.id).then((j) => { const c = j.cats[k]; ul.innerHTML = rows(c.v.slice(CAP), c.s); })
      .catch(() => { delete d.dataset.done; ul.innerHTML = '<li>could not load, close and reopen to retry</li>'; });
  }, true);

  // search index: one lowercased string per row, with its category and day appended so "scope" or "10-28" match whole lists
  let idx = null, loading = null;
  const load = () => loading ??= Promise.all(items.map((el) => day(el.id).then((j) => {
    const h = el.querySelector('h2').textContent;
    return { id: el.id, h, cats: j.cats.map((c) => { const ctx = ' ' + c.t.toLowerCase() + ' ' + h.toLowerCase(); return { ...c, low: c.v.map((x) => (c.s + x).toLowerCase() + ctx) }; }) };
  }))).then((x) => (idx = x)).catch((e) => { loading = null; throw e; });

  const SHOW = 200; // matches rendered per category before a "show all" button
  let last = '', prev = null, timer, gen = 0;
  async function run() {
    let term = q.value.trim().toLowerCase().replace(/\s+/g, ' ');
    const short = term.length > 0 && term.length < 2; // one character matches nearly everything
    if (short) term = '';
    if (term === last && !short) return;
    const my = ++gen;
    if (term && !idx) {
      count.textContent = 'loading…';
      try { await load(); } catch { count.textContent = 'could not load the lists'; return; }
      if (my !== gen) return;
    }
    const narrower = last !== '' && term.startsWith(last) && prev; // appending only removes matches
    last = term;
    history.replaceState(null, '', term ? '?q=' + encodeURIComponent(term) : location.pathname + location.hash);
    for (const el of items) el.hidden = !!term;
    fresh.hidden = !!term;
    if (!term) { results.innerHTML = ''; prev = null; count.textContent = short ? 'type at least 2 characters' : ''; return; }
    const terms = term.split(' ');
    const re = new RegExp('(' + terms.map((t) => t.replace(/[.*+?^$()|{}[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
    let hits = 0, html = '';
    const next = [];
    idx.forEach((it, a) => {
      let part = '';
      it.cats.forEach((c, b) => {
        const was = narrower ? prev[a][b] : null, m = [];
        const test = (i) => { if (terms.every((t) => c.low[i].includes(t))) m.push(i); };
        if (was) was.forEach(test); else for (let i = 0; i < c.low.length; i++) test(i);
        (next[a] ??= [])[b] = m;
        if (!m.length) return;
        hits += m.length;
        part += '<details open><summary><strong>' + esc(c.t) + '</strong> <small>' + m.length + ' match' + (m.length === 1 ? '' : 'es') + '</small></summary><ul>' + rows(m.slice(0, SHOW).map((i) => c.v[i]), c.s, re) + '</ul>'
          + (m.length > SHOW ? '<button type="button" class="all" data-a="' + a + '" data-b="' + b + '">show all ' + m.length + '</button>' : '') + '</details>';
      });
      if (part) html += '<section class="item"><h2><a href="#' + esc(it.id) + '">' + esc(it.h) + '</a></h2>' + part + '</section>';
    });
    prev = next; lastRe = re;
    results.innerHTML = html;
    count.textContent = hits + ' match' + (hits === 1 ? '' : 'es');
  }
  let lastRe = null;
  results.addEventListener('click', (e) => {
    const b = e.target.closest('button.all');
    if (b) { const c = idx[b.dataset.a].cats[b.dataset.b]; b.previousElementSibling.innerHTML = rows(prev[b.dataset.a][b.dataset.b].map((i) => c.v[i]), c.s, lastRe); b.remove(); return; }
    const a = e.target.closest('h2 a'); // a day heading goes back to the full page at that day
    if (a) { e.preventDefault(); q.value = ''; run(); location.hash = a.getAttribute('href'); }
  });
  const setQ = (v) => { q.value = v; clearTimeout(timer); run(); q.focus(); };
  document.getElementById('fresh')?.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setQ(b.dataset.q); });
  addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== q && !e.metaKey && !e.ctrlKey) { e.preventDefault(); q.focus(); q.select(); }
    else if (e.key === 'Escape' && q.value) { q.value = ''; run(); }
  });
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
  // the browser may restore a typed value on back/forward
  const init = new URLSearchParams(location.search).get('q') || q.value;
  if (init) setQ(init);
})();
