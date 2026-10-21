// The corpus: every markdown file the sources name, each entry carrying where
// it came from (file, folder, commit), so a wrong answer traces back to a line.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

// A glob walked one path segment at a time: `*` matches within a segment,
// `**` any number of folders (none included), anything else is a literal
// name. Only `.md` files come back. No dependency.
export function walk(root, glob) {
  const parts = glob.split('/');
  const out = [];
  const visit = (d, i) => {
    const part = parts[i];
    if (part === undefined) return;
    const last = i === parts.length - 1;
    if (part === '**') {
      visit(d, i + 1);
      for (const e of listDir(d)) if (e.isDirectory()) visit(join(d, e.name), i);
      return;
    }
    if (!part.includes('*')) {
      const full = join(d, part);
      if (!last) visit(full, i + 1);
      else if (part.endsWith('.md') && isFile(full)) out.push(full);
      return;
    }
    const re = new RegExp('^' + part.split('*').map(escapeRe).join('.*') + '$');
    for (const e of listDir(d)) {
      if (!re.test(e.name)) continue;
      const full = join(d, e.name);
      if (!last) { if (e.isDirectory()) visit(full, i + 1); }
      else if (!e.isDirectory() && e.name.endsWith('.md')) out.push(full);
    }
  };
  visit(root, 0);
  return out.sort();
}

/** Every file a source names, once, in a stable order. */
export const sourceFiles = src => [...new Set(src.globs.flatMap(g => walk(src.dir, g)))].sort();

const listDir = d => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const isFile = f => { try { return statSync(f).isFile(); } catch { return false; } };
export const isDir = d => { try { return statSync(d).isDirectory(); } catch { return false; } };
const escapeRe = s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
export const relPath = (dir, file) => relative(dir, file).split(sep).join('/');

/** Frontmatter without a YAML dependency: flat scalars and inline lists. */
export function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { data: {}, body: text };
  const data = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('[') && v.endsWith(']'))
      v = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else v = v.replace(/^["']|["']$/g, '');
    data[m[1]] = v;
  }
  return { data, body: text.slice(end + 4).replace(/^\n/, '') };
}

/** Headings, skipping fenced code: a `# comment` in a shell block is not structure. */
export function headings(body) {
  const out = [];
  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) out.push({ depth: m[1].length, text: m[2] });
  }
  return out;
}

/**
 * Tags from frontmatter `tags:` only, as strings, without a leading `#`,
 * trimmed, empties dropped, each once. They become file names later, so they
 * are cleaned here once rather than trusted everywhere.
 */
export function normalizeTags(raw) {
  const list = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
  return [...new Set(list.map(t => String(t).trim().replace(/^#+/, '').trim()).filter(Boolean))];
}

/** `[[Target]]`, `[[Target|alias]]` and `[[Target#part]]`, deduped, in order. */
export const wikilinks = body =>
  [...new Set([...body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map(m => m[1].trim()))];

/** Markdown links to another `.md` file, anchors stripped. */
export const fileLinks = body =>
  [...new Set([...body.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)].map(m => m[1]))];

const words = body => body.replace(/```[\s\S]*?```/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .toLowerCase().split(/\s+/).filter(Boolean);

/** Prose only, normalised: two copies that differ in punctuation or code hash the same. */
export const contentHash = body => createHash('sha256').update(words(body).join(' ')).digest('hex').slice(0, 16);

/** Word shingles for near-duplicate scoring. */
export function shingles(body, k = 8) {
  const w = words(body);
  const set = new Set();
  for (let i = 0; i + k <= w.length; i++) set.add(w.slice(i, i + k).join(' '));
  return { set, wordCount: w.length };
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let hits = 0;
  for (const s of small) if (large.has(s)) hits++;
  return hits / (a.size + b.size - hits);
}

/** HEAD of the repo a folder is in, or null when it is not in one. */
export function gitCommit(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

export function buildCorpus(config) {
  const entries = [], commits = {}, empty = [];
  for (const src of config.sources) {
    commits[src.id] = gitCommit(src.dir);
    const files = sourceFiles(src);
    // A required source that matches nothing, or a vault that is gone, is
    // refused by the caller: the alternative is an index that silently lost it.
    if ((!src.optional && !files.length) || !isDir(src.dir)) empty.push({ id: src.id, dir: src.dir, globs: src.globs });
    for (const file of files) {
      const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'));
      const rel = relPath(src.dir, file);
      const hs = headings(body);
      entries.push({
        id: `${src.id}:${rel}`,
        title: data.title ?? hs.find(h => h.depth === 1)?.text ?? rel.split('/').pop().replace(/\.md$/, ''),
        source: src.id,
        sourceLabel: src.label,
        provenance: { dir: src.dir, path: rel, commit: commits[src.id] },
        frontmatter: data,
        tags: normalizeTags(data.tags),
        headings: hs,
        wikilinks: wikilinks(body),
        fileLinks: fileLinks(body),
        words: body.split(/\s+/).filter(Boolean).length,
        contentHash: contentHash(body),
        body,
      });
    }
  }
  return { builtFrom: commits, entries, empty };
}

/**
 * Exact copies by prose hash; near copies by 8-word shingle Jaccard. Notes
 * under `minWords` are left out of the near check: stubs that share a
 * template are noise, not drift.
 */
export function findDuplicates(entries, { threshold = 0.82, minWords = 120 } = {}) {
  const exact = new Map();
  for (const e of entries) {
    if (!exact.has(e.contentHash)) exact.set(e.contentHash, []);
    exact.get(e.contentHash).push(e.id);
  }
  const big = entries.map(e => ({ e, ...shingles(e.body) })).filter(x => x.wordCount >= minWords);
  const near = [];
  for (let i = 0; i < big.length; i++)
    for (let j = i + 1; j < big.length; j++) {
      if (big[i].e.contentHash === big[j].e.contentHash) continue; // already exact
      const score = jaccard(big[i].set, big[j].set);
      if (score >= threshold) near.push({ a: big[i].e.id, b: big[j].e.id, score: Number(score.toFixed(3)) });
    }
  return { exact: [...exact.values()].filter(v => v.length > 1), near };
}
