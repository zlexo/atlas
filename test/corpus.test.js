import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseFrontmatter, headings, wikilinks, fileLinks, contentHash, shingles, jaccard,
  findDuplicates, walk, buildCorpus } from '../src/corpus.js';
import { fixture } from './fixture.js';

test('frontmatter: flat scalars and inline lists; none leaves the text as it is', () => {
  const { data, body } = parseFrontmatter('---\ntags: [a, b]\nstatus: active\n---\n# Title\ntext\n');
  assert.deepEqual(data.tags, ['a', 'b']);
  assert.equal(data.status, 'active');
  assert.ok(body.startsWith('# Title'));
  assert.deepEqual(parseFrontmatter('# Just a title\n'), { data: {}, body: '# Just a title\n' });
});

test('links: wikilink aliases and anchors resolve to the target; file links lose their anchor', () => {
  assert.deepEqual(wikilinks('[[Target]] [[Other|alias]] [[Third#part]] [[Target]]'), ['Target', 'Other', 'Third']);
  assert.deepEqual(fileLinks('[a](../A.md#x) [b](docs/B.md) [c](https://example.org)'), ['../A.md', 'docs/B.md']);
});

test('headings carry depth and skip fenced code', () => {
  assert.deepEqual(headings('# One\n```sh\n# not a heading\n```\n### Three\n'),
    [{ depth: 1, text: 'One' }, { depth: 3, text: 'Three' }]);
});

test('contentHash ignores code and punctuation, not words', () => {
  assert.equal(contentHash('Hello there.\n```\nx = 1\n```\n'), contentHash('hello   there!\n```\ny = 2\n```\n'));
  assert.notEqual(contentHash('Hello there.'), contentHash('Hello elsewhere.'));
});

test('near-duplicate scoring separates an edited copy from unrelated text', () => {
  const base = Array.from({ length: 400 }, (_, i) => `word${i % 130}`).join(' ');
  const s = t => shingles(t).set;
  assert.ok(jaccard(s(base), s(base + ' one extra sentence appended')) > 0.9);
  assert.ok(jaccard(s(base), s(base.replaceAll('word', 'other'))) < 0.1);
});

test('findDuplicates: exact copies once, never also as near; stubs are exempt', () => {
  const body = Array.from({ length: 300 }, (_, i) => `w${i % 90}`).join(' ');
  const e = (id, b) => ({ id, body: b, contentHash: contentHash(b) });
  const r = findDuplicates([e('a', body), e('b', body), e('c', 'something else')]);
  assert.deepEqual(r.exact.map(g => g.sort()), [['a', 'b']]);
  assert.equal(r.near.length, 0);
  const stub = 'short stub note with only a handful of words in it';
  assert.equal(findDuplicates([e('x', stub), e('y', stub + ' and more')]).near.length, 0);
});

test('walk: each glob shape names exactly its files', () => {
  const root = mkdtempSync(join(tmpdir(), 'atlas-walk-'));
  const put = p => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), '# x\n'); };
  ['A.md', 'notes.txt', 'docs/B.md', 'docs/sub/C.md', 'pkg/m1/README.md', 'pkg/m1/OTHER.md', 'pkg/README.md'].forEach(put);
  const rel = g => walk(root, g).map(f => relative(root, f).split(sep).join('/'));
  try {
    assert.deepEqual(rel('*.md'), ['A.md']);
    assert.deepEqual(rel('docs/*.md'), ['docs/B.md']);
    assert.deepEqual(rel('docs/**/*.md'), ['docs/B.md', 'docs/sub/C.md']);
    assert.deepEqual(rel('pkg/*/README.md'), ['pkg/m1/README.md']);
    assert.deepEqual(rel('gone/**/*.md'), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('corpus: projects and knowledge from the vault, README and docs from a folder; no dailies', () => {
  const f = fixture();
  try {
    const { entries } = buildCorpus(f.config());
    const ids = entries.map(e => e.id);
    assert.equal(entries.filter(e => e.source === 'vault').length, 12);
    assert.ok(ids.includes('vault:Projects/Raised Beds.md'));
    assert.ok(ids.includes('seed-catalog:README.md') && ids.includes('seed-catalog:docs/sowing.md'));
    assert.ok(!ids.some(i => i.includes('Daily/')), 'dailies are not indexed');
    const beds = entries.find(e => e.id === 'vault:Projects/Raised Beds.md');
    assert.deepEqual(beds.tags, ['garden', 'project', 'vegetables', 'soil']);
    assert.deepEqual(beds.provenance, { dir: f.vault, path: 'Projects/Raised Beds.md', commit: null });
  } finally { f.cleanup(); }
});

test('corpus: provenance carries the commit of a vault under git', () => {
  const f = fixture();
  try {
    const g = (...a) => execFileSync('git', ['-C', f.vault, ...a], { stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't' } });
    g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'notes');
    const head = g('rev-parse', '--short', 'HEAD').toString().trim();
    const e = buildCorpus(f.config()).entries.find(x => x.source === 'vault');
    assert.equal(e.provenance.commit, head);
  } finally { f.cleanup(); }
});
