// The scrub is the check that keeps this repo publishable, so every way it
// can find a hit is planted in a throwaway repo and seen to go red, and the
// way it can be told a hit is fine (an allowed text) is seen to work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { scrub, loadList } from '../scripts/scrub.mjs';

const REPO = new URL('..', import.meta.url).pathname;
const SECRET = 'plantedsecret';
const ident = ['t', 'example.test'].join('@');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: ident, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: ident };

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-scrub-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { env, stdio: 'pipe' });
  const commit = (file, text, msg = 'a change') => { writeFileSync(join(dir, file), text); git('add', '-A'); git('commit', '-q', '-m', msg); };
  git('init', '-q');
  writeFileSync(join(dir, 'list.txt'), `# test list\n${SECRET}\nallow Owned by PlantedSecret Ltd.\n`);
  writeFileSync(join(dir, '.gitignore'), 'list.txt\n');
  commit('README.md', 'clean\n');
  return { dir, git, commit, list: loadList(join(dir, 'list.txt')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('control: a clean repo is clean, and the ignored list itself is never scanned', () => {
  const r = repo();
  try { assert.deepEqual(scrub(r.dir, { list: r.list }).hits, []); } finally { r.cleanup(); }
});

test('a private string in the tree is found, matched without regard to case, never quoted', () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, 'notes.md'), `fine\nsee the ${SECRET.toUpperCase()} here\n`);
    const { hits } = scrub(r.dir, { list: r.list, history: false });
    assert.deepEqual(hits, ['notes.md:2: private string #1']);
  } finally { r.cleanup(); }
});

test('a private string only in history (added, then removed) is found', () => {
  const r = repo();
  try {
    r.commit('a.md', `${SECRET}\n`);
    unlinkSync(join(r.dir, 'a.md')); r.git('add', '-A'); r.git('commit', '-q', '-m', 'remove it');
    assert.deepEqual(scrub(r.dir, { list: r.list, history: false }).hits, [], 'the tree is clean now');
    assert.ok(scrub(r.dir, { list: r.list, tree: false }).hits.length >= 2, 'its add and its removal are both in history');
  } finally { r.cleanup(); }
});

test('commit messages, file names and branch names are scanned', () => {
  const r = repo();
  try {
    r.commit('b.md', 'fine\n', `mentions ${SECRET}`);
    r.commit(`${SECRET}.md`, 'fine\n');
    r.git('branch', `topic-${SECRET}`);
    const hits = scrub(r.dir, { list: r.list }).hits.join('\n');
    assert.match(hits, /commit \w+ line 1: private string/);
    assert.match(hits, /plantedsecret\.md \(its name\)/i);
    assert.match(hits, /ref refs\/heads\/topic-/);
  } finally { r.cleanup(); }
});

test('generic tells are found without any list', () => {
  const r = repo();
  const home = ['', 'Users', 'someone', 'x'].join('/');
  try {
    writeFileSync(join(r.dir, 'c.md'), `${home}\nwrite to ${ident}\nan em dash \u2014 here\n`);
    writeFileSync(join(r.dir, 'bundle.json'), '{}\n');
    r.commit('d.md', 'fine\n', `subject\n\n${['Co', 'Authored', 'By'].join('-')}: someone`);
    const hits = scrub(r.dir, { list: null }).hits.join('\n');
    for (const what of ['a home folder path', 'an e-mail address', 'an em dash', 'a generated bundle', 'an attribution trailer'])
      assert.ok(hits.includes(what), `${what} not found in:\n${hits}`);
  } finally { r.cleanup(); }
});

test('an allowed text hides its private string, and only inside that exact text', () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, 'LICENSE'), 'Owned by PlantedSecret Ltd.\n');
    assert.deepEqual(scrub(r.dir, { list: r.list, history: false }).hits, []);
    writeFileSync(join(r.dir, 'LICENSE'), 'Owned by PlantedSecret Ltd. and plantedsecret again\n');
    assert.equal(scrub(r.dir, { list: r.list, history: false }).hits.length, 1);
  } finally { r.cleanup(); }
});

test('the command exits 1 on a hit and 0 when clean, and says when the list is missing', () => {
  const r = repo();
  const cli = extra => spawnSync(process.execPath, [join(REPO, 'scripts/scrub.mjs'), '--repo', r.dir],
    { encoding: 'utf8', env: { ...process.env, ATLAS_PRIVATE_STRINGS: join(r.dir, 'list.txt'), ...extra } });
  try {
    assert.equal(cli().status, 0);
    writeFileSync(join(r.dir, 'e.md'), `${SECRET}\n`);
    assert.equal(cli().status, 1);
    const none = cli({ ATLAS_PRIVATE_STRINGS: join(r.dir, 'missing.txt') });
    assert.equal(none.status, 0);
    assert.match(none.stdout, /SKIPPED/);
  } finally { r.cleanup(); }
});

test('this repo: tree and full history are clean, the scrub included', t => {
  const list = loadList(process.env.ATLAS_PRIVATE_STRINGS || join(REPO, 'private-strings.local.txt'));
  if (!list) t.diagnostic('no private-strings.local.txt: generic tells only');
  const r = scrub(REPO, { list });
  assert.deepEqual(r.hits, []);
});
