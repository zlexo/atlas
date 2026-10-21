// Atlas reads the BUNDLE, never the files: it shows exactly what the index
// holds. When the index is stale the page is stale too, and says so in red.
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const enc = encodeURIComponent;
const SLOT = String.fromCharCode(1);
let B = null, S = null;

/* ---------------------------------------------------------------- markdown */
const byName = name => B.entries.find(e => e.title.toLowerCase() === name.toLowerCase() ||
  e.provenance.path.replace(/^.*\//, '').replace(/\.md$/, '').toLowerCase() === name.toLowerCase());

function inline(t) {
  const spans = []; // code spans first: `**` inside backticks is literal
  return esc(t).replace(/`([^`]+)`/g, (_, c) => `${SLOT}${spans.push(c) - 1}${SLOT}`)
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, tgt, lbl) => {
      const hit = byName(tgt.trim());
      return hit ? `<a href="#/note/${enc(hit.id)}">${lbl || tgt}</a>` : `<span class="dangling" title="not in the index">${lbl || tgt}</span>`;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, href) =>
      /^https?:/.test(href) ? `<a href="${href}" target="_blank" rel="noreferrer">${txt}</a>` : `<span class="dangling">${txt}</span>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(new RegExp(`${SLOT}(\\d+)${SLOT}`, 'g'), (_, n) => `<code>${spans[n]}</code>`);
}

function markdown(src) {
  const out = [], lines = src.split('\n');
  let i = 0, list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const ln = lines[i];
    if (/^\s*(```|~~~)/.test(ln)) {
      close();
      const body = [];
      for (i++; i < lines.length && !/^\s*(```|~~~)/.test(lines[i]); i++) body.push(lines[i]);
      i++; out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`); continue;
    }
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { close(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(ln) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      close();
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(ln), rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
        rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table>');
      continue;
    }
    const li = ln.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const want = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (list !== want) { close(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline(li[2])}</li>`); i++; continue;
    }
    if (/^\s*>/.test(ln)) {
      close();
      const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdown(q.join('\n'))}</blockquote>`); continue;
    }
    if (!ln.trim()) { close(); i++; continue; }
    close();
    const para = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|~~~|[-*+]\s|\d+\.\s|>|\|)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  close();
  return out.join('\n');
}

/* ------------------------------------------------------------------ search */
const plain = md => md.replace(/```[\s\S]*?```/g, ' ').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, l) => l || t)
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#>*`_|]/g, ' ').replace(/\s+/g, ' ');

function search(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits = [];
  for (const e of B.entries) {
    const hay = `${e.title}\n${e.tags.join(' ')}\n${e.body}`.toLowerCase();
    if (!terms.every(t => hay.includes(t))) continue;
    let score = 0;
    for (const t of terms) {
      if (e.title.toLowerCase().includes(t)) score += 40;
      if (e.headings.some(h => h.text.toLowerCase().includes(t))) score += 12;
      if (e.tags.some(g => g.includes(t))) score += 8;
      score += Math.min(10, e.body.toLowerCase().split(t).length - 1);
    }
    hits.push({ e, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 50);
}

function snippet(e, terms) {
  const body = plain(e.body), low = body.toLowerCase();
  const first = Math.min(...terms.map(t => { const p = low.indexOf(t); return p < 0 ? Infinity : p; }));
  const at = isFinite(first) ? Math.max(0, first - 60) : 0;
  let html = esc((at ? '... ' : '') + body.slice(at, at + 220) + ' ...');
  for (const t of terms) html = html.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>');
  return html;
}

/* ------------------------------------------------------------------- views */
// Folders by their last name; the full path is in the tooltip.
const folder = d => d.split('/').filter(Boolean).pop() ?? d;
const where = e => `${e.sourceLabel} · ${e.provenance.path}${e.provenance.commit ? ` @ ${e.provenance.commit}` : ''}`;
const row = (e, extra = '') => `<a class="result" href="#/note/${enc(e.id)}"><div class="rt">${esc(e.title)}</div>` +
  `<div class="rp">${esc(where(e))}</div>${extra}</a>`;
const tagCounts = () => {
  const t = {};
  for (const e of B.entries) for (const g of e.tags) t[g] = (t[g] || 0) + 1;
  return Object.entries(t).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};
const pairs = () => B.duplicates.exact.length + B.duplicates.near.length;

function viewNotes() {
  return `<p class="eyebrow">Notes</p><h1 class="page">${B.entries.length} notes in the index</h1>` +
    B.sources.map(s => {
      const list = B.entries.filter(e => e.source === s.id).sort((a, b) => a.provenance.path.localeCompare(b.provenance.path));
      return `<h2 class="sect">${esc(s.label)} <span class="n">${list.length}</span></h2>` +
        `<p class="src" title="${esc(s.dir)}">${esc(folder(s.dir))} · ${s.globs.map(esc).join(', ')}</p>${list.map(e => row(e)).join('') || '<p class="empty">Nothing here yet.</p>'}`;
    }).join('');
}

function viewNote(id) {
  const e = B.entries.find(x => x.id === id);
  if (!e) return '<p class="empty">Not in the index.</p>';
  const tags = e.tags.map(t => `<a class="tag" href="#/tag/${enc(t)}">#${esc(t)}</a>`).join('');
  return `<p class="eyebrow">${esc(e.sourceLabel)}</p><div class="prov" title="${esc(e.provenance.dir)}">${esc(folder(e.provenance.dir))}/${esc(e.provenance.path)}` +
    ` · ${e.provenance.commit ? `commit ${esc(e.provenance.commit)}` : 'not in git'} · ${e.words} words</div>` +
    `<div class="tagline">${tags}</div><article class="doc">${markdown(e.body)}</article>`;
}

function viewMaps() {
  return `<p class="eyebrow">Maps</p><h1 class="page">Tags</h1><p class="lede">Every tag in the index. In the vault, ` +
    `<code>atlas moc</code> writes a map for each tag on at least three notes into <code>Maps/Generated</code>.</p>` +
    `<div class="tagline">${tagCounts().map(([t, n]) => `<a class="tag" href="#/tag/${enc(t)}">#${esc(t)} <span class="n">${n}</span></a>`).join('')}</div>`;
}

const viewTag = t => `<p class="eyebrow">Map</p><h1 class="page">#${esc(t)}</h1>` +
  B.entries.filter(e => e.tags.includes(t)).sort((a, b) => a.title.localeCompare(b.title)).map(e => row(e)).join('');

function viewDuplicates() {
  const name = id => { const e = B.entries.find(x => x.id === id); return e ? `<a href="#/note/${enc(id)}">${esc(e.title)}</a>` : esc(id); };
  const d = B.duplicates;
  return `<p class="eyebrow">Duplicates</p><h1 class="page">${pairs() ? `${pairs()} to merge` : 'No duplicates'}</h1>` +
    `<p class="lede">Two copies is how notes start contradicting each other. Merge them, or make one point at the other.</p>` +
    (d.exact.length ? `<h2 class="sect">Identical</h2><ul class="dups">${d.exact.map(g => `<li>${g.map(name).join(' = ')}</li>`).join('')}</ul>` : '') +
    (d.near.length ? `<h2 class="sect">Near</h2><table class="dups"><thead><tr><th>Score</th><th>Note</th><th>Note</th></tr></thead><tbody>` +
      d.near.map(p => `<tr><td class="num">${p.score.toFixed(3)}</td><td>${name(p.a)}</td><td>${name(p.b)}</td></tr>`).join('') + '</tbody></table>' : '');
}

function viewSearch(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean), hits = search(q);
  return `<p class="eyebrow">Search</p><h1 class="page">${hits.length} result${hits.length === 1 ? '' : 's'}</h1>` +
    hits.map(h => row(h.e, `<div class="rs">${snippet(h.e, terms)}</div>`)).join('');
}

/* ------------------------------------------------------------- freshness */
function renderFreshness() {
  const banner = $('#stale');
  if (!S) {
    banner.hidden = false;
    banner.innerHTML = '<b>Freshness unknown.</b> The server did not answer <code>/status.json</code>.';
    $('#fresh').innerHTML = '';
    return;
  }
  $('#fresh').innerHTML = S.artifacts.map(a => `<div class="freshrow ${a.fresh ? '' : 'stale'}" title="${esc(a.lastError ?? a.reason)}">` +
    `<span class="dot"></span><div><span class="fl">${esc(a.label)}</span><div class="fr">${esc(a.lastError ? 'rebuild failed' : a.reason)}</div></div></div>`).join('');
  const bad = S.artifacts.filter(a => !a.fresh);
  banner.hidden = !bad.length;
  banner.innerHTML = bad.length ? `<b>${bad.length === 1 ? 'Something here is stale.' : `${bad.length} things here are stale.`}</b> ` +
    bad.map(a => `${esc(a.label)}: ${esc(a.lastError ?? a.reason)}`).join(' · ') : '';
}

function renderRail(active) {
  const link = (href, label, n) => `<a href="${href}" class="${active === href ? 'on' : ''}"><span>${label}</span>${n != null ? `<span class="n">${n}</span>` : ''}</a>`;
  $('#nav').innerHTML = `<div class="navgroup">${link('#/', 'Notes', B.entries.length)}${link('#/maps', 'Maps', tagCounts().length)}` +
    `${link('#/duplicates', 'Duplicates', pairs())}</div><div class="navgroup"><h4>Tags</h4>` +
    tagCounts().slice(0, 8).map(([t, n]) => link(`#/tag/${enc(t)}`, `#${esc(t)}`, n)).join('') + '</div>';
  $('#built').textContent = `built ${new Date(B.builtAt).toLocaleString()}`;
}

function route() {
  const [, head = '', ...rest] = location.hash.split('/');
  const arg = decodeURIComponent(rest.join('/'));
  const q = $('#q').value.trim();
  const html = head === 'search' ? viewSearch(arg) : head === 'note' ? viewNote(arg) : head === 'maps' ? viewMaps()
    : head === 'tag' ? viewTag(arg) : head === 'duplicates' ? viewDuplicates() : viewNotes();
  if (head !== 'search' && q) $('#q').value = '';
  if (head === 'search' && !q) $('#q').value = arg; // a search opened from a link
  renderRail(head === 'tag' ? location.hash : `#/${head}`);
  $('#view').innerHTML = html;
  window.scrollTo(0, 0);
}

async function boot() {
  try { S = await (await fetch('/status.json')).json(); } catch { S = null; }
  renderFreshness();
  const r = await fetch('/bundle.json');
  if (!r.ok) { $('#view').innerHTML = `<p class="empty">No index yet: ${esc(await r.text())}</p>`; return; }
  B = await r.json();
  $('#q').addEventListener('input', e => { location.hash = e.target.value.trim() ? `#/search/${enc(e.target.value.trim())}` : '#/'; });
  document.addEventListener('keydown', e => { if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); } });
  window.addEventListener('hashchange', route);
  route();
}
boot();
