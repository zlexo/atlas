#!/usr/bin/env node
// The scrub: this repo's history may be published as it is, so nothing in
// it may name the machine or the person it was built on. Two scans, over the
// working tree and over every commit on every ref (messages, file names,
// added and removed lines):
//
//  - generic tells, committed here: home-folder paths, e-mail addresses,
//    attribution trailers, em dashes, and generated bundles by file name;
//  - private strings, from a list that never reaches the repo:
//    private-strings.local.txt at the root (git-ignored), or the file
//    ATLAS_PRIVATE_STRINGS names. One string per line, matched without
//    regard to case; `#` starts a comment. A line `allow <text>` names an
//    exact text that may contain a private string (a license line, say);
//    it is cut out of a line before the private strings are matched.
//
// Without the list the private scan is skipped and the output says so.
//
//   node scripts/scrub.mjs [--repo <dir>] [--tree] [--history]
//
// Exit 0 clean, 1 hits, 2 could not run.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRAILER = new RegExp(['co', 'authored', 'by'].join('-') + ':|' + ['generated', 'with'].join(' ') + ' \\[', 'i');
export const TELLS = [
  [/\/(Users|home)\/[^/\s'"`]/, 'a home folder path'],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/, 'an e-mail address'],
  [TRAILER, 'an attribution trailer'],
  [/\u2014/, 'an em dash'],
];
const BUNDLE_NAMES = /(^|\/)(corpus|api|checks|eval|bundle)\.json$/;

export function loadList(file) {
  if (!file || !existsSync(file)) return null;
  const strings = [], allow = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    if (s.startsWith('allow ')) allow.push(s.slice(6));
    else strings.push(s.toLowerCase());
  }
  return { strings, allow };
}

/** Hits in one line. A private string is reported by its number in the list, never quoted. */
export function scanLine(where, text, list) {
  const hits = [];
  for (const [re, what] of TELLS) if (re.test(text)) hits.push(`${where}: ${what}`);
  if (list) {
    let t = text;
    for (const a of list.allow) t = t.split(a).join(' ');
    t = t.toLowerCase();
    list.strings.forEach((s, i) => { if (t.includes(s)) hits.push(`${where}: private string #${i + 1}`); });
  }
  return hits;
}

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });

export function scanTree(repo, list) {
  const files = git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const hits = [], binary = [];
  for (const f of files) {
    hits.push(...scanLine(`${f} (its name)`, f, list));
    if (BUNDLE_NAMES.test(f)) hits.push(`${f}: a generated bundle`);
    let buf;
    try { buf = readFileSync(join(repo, f)); } catch { continue; } // deleted, not yet staged
    if (buf.subarray(0, 8000).includes(0)) { binary.push(f); continue; }
    buf.toString('utf8').split('\n').forEach((line, i) => hits.push(...scanLine(`${f}:${i + 1}`, line, list)));
  }
  return { hits, files: files.length, binary };
}

export function scanHistory(repo, list) {
  const hits = [];
  for (const ref of git(repo, ['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean))
    hits.push(...scanLine(`ref ${ref}`, ref, list));
  let out = '';
  try { out = git(repo, ['log', '--all', '-p', '--no-color', '--format=%x1e%H%n%B']); }
  catch { return { hits, commits: 0 }; } // no commits yet
  let sha = '?', n = 0, commits = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('\x1e')) { sha = line.slice(1, 8); n = 0; commits++; continue; }
    n++;
    const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (m && BUNDLE_NAMES.test(m[2])) hits.push(`commit ${sha}: ${m[2]}: a generated bundle`);
    hits.push(...scanLine(`commit ${sha} line ${n}`, line, list));
  }
  return { hits, commits };
}

export function scrub(repo, { list, tree = true, history = true } = {}) {
  const t = tree ? scanTree(repo, list) : null;
  const h = history ? scanHistory(repo, list) : null;
  return { hits: [...(t?.hits ?? []), ...(h?.hits ?? [])], tree: t, history: h };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--repo');
  const repo = resolve(at >= 0 ? argv[at + 1] : join(fileURLToPath(import.meta.url), '..', '..'));
  const only = ['--tree', '--history'].filter(f => argv.includes(f));
  const listFile = process.env.ATLAS_PRIVATE_STRINGS || join(repo, 'private-strings.local.txt');
  const list = loadList(listFile);
  let r;
  try { r = scrub(repo, { list, tree: !only.length || only.includes('--tree'), history: !only.length || only.includes('--history') }); }
  catch (e) { console.error(`scrub: could not run: ${e.message}`); process.exit(2); }
  console.log(list ? `scrub: ${list.strings.length} private strings, ${list.allow.length} allowed texts`
    : 'scrub: no private-strings.local.txt: the private scan is SKIPPED, generic tells only');
  if (r.tree) console.log(`scrub: tree, ${r.tree.files} files${r.tree.binary.length ? ` (${r.tree.binary.length} binary, names only: ${r.tree.binary.join(', ')})` : ''}`);
  if (r.history) console.log(`scrub: history, ${r.history.commits} commits on every ref`);
  for (const h of r.hits) console.log(`  ${h}`);
  console.log(r.hits.length ? `scrub: ${r.hits.length} hit(s)` : 'scrub: clean');
  process.exit(r.hits.length ? 1 : 0);
}
