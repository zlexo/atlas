// Maps write into the user's vault, so these tests care as much about what is
// NOT written as about what is. The sentinels are files carrying the generated
// marker: one inside Maps/Generated that no tag produces (a run removes it,
// proving the run really swept), and others outside it that must survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMaps } from '../src/artifacts.js';
import { mapsStatus, status } from '../src/freshness.js';
import { MARKER, groupByTag } from '../src/moc.js';
import { buildCorpus } from '../src/corpus.js';
import { fixture } from './fixture.js';

// Spelled out, not imported: the test pins where the maps may go.
const gen = f => join(f.vault, 'Maps', 'Generated');
/** Every file under `dir` with its content, except the generated folder. */
function snapshot(dir, skip) {
  const out = {};
  for (const rel of readdirSync(dir, { recursive: true }).sort()) {
    const full = join(dir, rel);
    if (full.startsWith(skip) || statSync(full).isDirectory()) continue;
    out[rel] = readFileSync(full, 'utf8');
  }
  return out;
}

test('maps: one per tag on 3 or more notes, none for a tag on (nearly) every note', () => {
  const f = fixture();
  try {
    const tags = [...groupByTag(buildCorpus(f.config()).entries).keys()].sort();
    assert.deepEqual(tags, ['herbs', 'project', 'soil', 'vegetables', 'water']);
    const r = buildMaps(f.config());
    assert.ok(readdirSync(gen(f)).includes('Soil Map.md'));
    const soil = readFileSync(join(gen(f), 'Soil Map.md'), 'utf8');
    assert.match(soil, /\[\[Raised Beds\]\] · \*building\*/);
    assert.match(soil, /4 of 12 vault notes carry `#soil`/);
    assert.equal(r.pairs, 1);
  } finally { f.cleanup(); }
});

test('sentinel: nothing is written outside Maps/Generated, and the run really swept inside it', () => {
  const f = fixture();
  try {
    mkdirSync(gen(f), { recursive: true });
    writeFileSync(join(gen(f), 'Sentinel Map.md'), `${MARKER}\nno tag makes this\n`);
    mkdirSync(join(f.vault, 'Maps'), { recursive: true });
    writeFileSync(join(f.vault, 'Maps', 'Garden Map.md'), `${MARKER}\nhand-made, outside the generated folder\n`);
    writeFileSync(join(f.vault, 'Knowledge', 'Old Map.md'), `${MARKER}\nmarker, but not in the generated folder\n`);
    const before = snapshot(f.dir, gen(f));
    buildMaps(f.config());
    assert.ok(!existsSync(join(gen(f), 'Sentinel Map.md')), 'control: the run swept the generated folder');
    assert.deepEqual(snapshot(f.dir, gen(f)), before, 'a file outside Maps/Generated changed');
  } finally { f.cleanup(); }
});

test('a file without the marker in the generated folder is never removed or overwritten', () => {
  const f = fixture();
  try {
    mkdirSync(gen(f), { recursive: true });
    writeFileSync(join(gen(f), 'My Notes.md'), 'mine\n');
    writeFileSync(join(gen(f), 'Herbs Map.md'), 'my own herbs map\n');
    const r = buildMaps(f.config());
    assert.equal(readFileSync(join(gen(f), 'My Notes.md'), 'utf8'), 'mine\n');
    assert.equal(readFileSync(join(gen(f), 'Herbs Map.md'), 'utf8'), 'my own herbs map\n');
    assert.deepEqual(r.kept, ['Herbs Map.md']);
    for (const file of r.written) assert.ok(readFileSync(join(gen(f), file), 'utf8').includes(MARKER), file);
  } finally { f.cleanup(); }
});

test('a generated folder that resolves outside the vault is refused, and nothing is written there', () => {
  const f = fixture();
  try {
    const outside = join(f.dir, 'elsewhere');
    mkdirSync(outside);
    mkdirSync(join(f.vault, 'Maps'), { recursive: true });
    symlinkSync(outside, gen(f));
    assert.throws(() => buildMaps(f.config()), /outside the vault/);
    assert.deepEqual(readdirSync(outside), []);
  } finally { f.cleanup(); }
});

test('duplicates are reported with their score, not refused', () => {
  const f = fixture();
  try {
    buildMaps(f.config());
    const d = readFileSync(join(gen(f), 'Duplicates.md'), 'utf8');
    assert.match(d, /\| 0\.918 \| \[\[Compost Ratios\]\] \| \[\[Compost Bays\]\] \|/);
    assert.match(d, /## Identical \(0\)\n\nNone\./);
    writeFileSync(join(f.catalog, 'docs', 'copy.md'), readFileSync(join(f.catalog, 'docs', 'sowing.md')));
    buildMaps(f.config());
    assert.match(readFileSync(join(gen(f), 'Duplicates.md'), 'utf8'),
      /## Identical \(1\)\n\n- `seed-catalog:docs\/copy\.md` = `seed-catalog:docs\/sowing\.md`/);
  } finally { f.cleanup(); }
});

test('maps status: fresh after a run, stale after an edit; a dry run writes nothing', () => {
  const f = fixture();
  try {
    assert.match(mapsStatus(f.config()).reason, /not generated yet/);
    buildMaps(f.config(), { dryRun: true });
    assert.deepEqual(readdirSync(gen(f)), [], 'a dry run writes nothing');
    buildMaps(f.config());
    const s = mapsStatus(f.config());
    assert.equal(s.fresh, true);
    assert.match(s.reason, /1 duplicate pair/);
    writeFileSync(join(f.vault, 'Knowledge', 'Basil.md'), '---\ntags: [herbs]\n---\n# Basil\n\nChanged.\n');
    assert.equal(mapsStatus(f.config()).fresh, false);
    assert.equal(status(f.config()).ok, false);
  } finally { f.cleanup(); }
});

// ------------------------------------------------------- tags as file names

import { chmodSync, lstatSync, readlinkSync, rmSync } from 'node:fs';
import { mapFile, mapFiles, writeMaps } from '../src/moc.js';
import { normalizeTags, findDuplicates } from '../src/corpus.js';

const sentinelGone = f => !existsSync(join(gen(f), 'Sentinel Map.md'));
const tagged = (f, tags, n = 3) => { for (let i = 0; i < n; i++)
  writeFileSync(join(f.vault, 'Knowledge', `Tagged ${tags.join(' ').replace(/[^a-z0-9]/gi, '')} ${i}.md`),
    `---\ntags: [${tags.join(', ')}]\n---\n# Tagged ${i}\n\nA note.\n`); };

test('tags: strings, no leading #, trimmed, no empties, each once', () => {
  assert.deepEqual(normalizeTags([2026, '#herbs', ' herbs ', '', '  ', 'a:b', '##x']), ['2026', 'herbs', 'a:b', 'x']);
  assert.deepEqual(normalizeTags(7), ['7']);
  assert.deepEqual(normalizeTags(''), []);
  assert.deepEqual(normalizeTags(undefined), []);
});

test('map names are file names, never paths', () => {
  assert.equal(mapFile('project/active'), 'Project - Active Map.md');
  assert.equal(mapFile('../../x'), 'X Map.md');
  assert.equal(mapFile('a:b'), 'A B Map.md');
  assert.equal(mapFile('2026'), '2026 Map.md');
  assert.equal(mapFile('.hidden'), 'Hidden Map.md');
  assert.equal(mapFile('a\\b*?"<>|c' + String.fromCharCode(9) + 'd'), 'A B C D Map.md');
  assert.equal(mapFile('..'), 'Tag Map.md');
  const names = [...mapFiles(['x', '../../x', 'X', 'duplicates']).values()];
  assert.deepEqual(names, ['X Map.md', 'X 2 Map.md', 'X 3 Map.md', 'Duplicates Map.md']);
});

test('numeric, nested, traversal, #-prefixed, empty and colon tags all map, inside the folder only', () => {
  const f = fixture();
  try {
    tagged(f, ['2026']); tagged(f, ['project/active']); tagged(f, ['../../x']);
    tagged(f, ['#herbs'], 1); tagged(f, ['""'], 1); tagged(f, ['a:b']);
    mkdirSync(gen(f), { recursive: true });
    writeFileSync(join(gen(f), 'Sentinel Map.md'), `${MARKER}\nno tag makes this\n`);
    const before = snapshot(f.dir, gen(f));
    const r = buildMaps(f.config());
    assert.deepEqual(snapshot(f.dir, gen(f)), before, 'a file outside Maps/Generated changed');
    assert.deepEqual(r.errors, []);
    for (const name of ['2026 Map.md', 'Project - Active Map.md', 'X Map.md', 'A B Map.md', 'Herbs Map.md', 'Duplicates.md', 'Generated Maps.md'])
      assert.ok(readdirSync(gen(f)).includes(name), `${name} missing from ${readdirSync(gen(f)).join(', ')}`);
    assert.match(readFileSync(join(gen(f), 'Herbs Map.md'), 'utf8'), /4 of 26 vault notes carry `#herbs`/, '#herbs is herbs');
    assert.match(readFileSync(join(gen(f), 'Generated Maps.md'), 'utf8'), /\[\[Project - Active Map\]\]/);
    assert.ok(sentinelGone(f), 'control: the run swept the folder');
  } finally { f.cleanup(); }
});

test('the last guard: a name that is a path is skipped and reported, the rest are written', () => {
  const f = fixture();
  try {
    tagged(f, ['../../escape']);
    const corpus = buildCorpus(f.config());
    const raw = tags => new Map(tags.map(t => [t, `${t}.md`])); // no sanitizing
    const r = writeMaps({ entries: corpus.entries, duplicates: findDuplicates(corpus.entries) }, f.vault,
      { stamp: 's', nearDuplicate: { threshold: 0.82, minWords: 120 }, namer: raw });
    assert.deepEqual(r.errors.map(e => e.file), ['../../escape.md']);
    assert.ok(!existsSync(join(f.vault, 'escape.md')) && !existsSync(join(f.dir, 'escape.md')));
    assert.ok(r.written.includes('soil.md') && r.written.includes('Duplicates.md') && r.written.includes('Generated Maps.md'));
  } finally { f.cleanup(); }
});

test('a file that cannot be written is reported in the result and the status; the others are written', () => {
  const f = fixture();
  const soil = join(gen(f), 'Soil Map.md');
  try {
    buildMaps(f.config());
    chmodSync(soil, 0o444);
    writeFileSync(join(f.vault, 'Knowledge', 'Basil.md'), '---\ntags: [herbs]\n---\n# Basil\n\nChanged.\n');
    const r = buildMaps(f.config());
    assert.deepEqual(r.errors.map(e => e.file), ['Soil Map.md']);
    assert.ok(r.written.includes('Herbs Map.md') && r.written.includes('Duplicates.md') && r.written.includes('Generated Maps.md'));
    const front = readFileSync(join(gen(f), 'Generated Maps.md'), 'utf8');
    assert.match(front, /^incomplete: 1$/m);
    assert.doesNotMatch(front, /built-from/, 'a half-written set is never stamped current');
    const s = mapsStatus(f.config());
    assert.equal(s.fresh, false);
    assert.match(s.reason, /1 file\(s\) could not be written/);
  } finally { try { chmodSync(soil, 0o644); } catch {} f.cleanup(); }
});

test('a Maps folder that links out of the vault: refused before anything is created there', () => {
  const f = fixture();
  try {
    const outside = join(f.dir, 'elsewhere');
    mkdirSync(outside);
    symlinkSync(outside, join(f.vault, 'Maps'));
    assert.throws(() => buildMaps(f.config()), /outside the vault/);
    assert.deepEqual(readdirSync(outside), [], 'Generated was created outside the vault');
    rmSync(join(f.vault, 'Maps'));
    symlinkSync(join(f.dir, 'nowhere'), join(f.vault, 'Maps'));
    assert.throws(() => buildMaps(f.config()), /broken link/);
    assert.ok(!existsSync(join(f.dir, 'nowhere')));
  } finally { f.cleanup(); }
});

test('a symlink at a map\'s name is a person\'s: never written through, never removed', () => {
  const f = fixture();
  try {
    const target = join(f.dir, 'target.md'), old = join(f.dir, 'old.md');
    writeFileSync(target, `${MARKER}\nnot in the vault\n`);
    writeFileSync(old, `${MARKER}\nnot in the vault either\n`);
    mkdirSync(gen(f), { recursive: true });
    symlinkSync(target, join(gen(f), 'Herbs Map.md'));
    symlinkSync(old, join(gen(f), 'Old Map.md'));
    const r = buildMaps(f.config());
    assert.ok(r.kept.includes('Herbs Map.md'));
    assert.equal(readFileSync(target, 'utf8'), `${MARKER}\nnot in the vault\n`, 'written through the link');
    assert.ok(lstatSync(join(gen(f), 'Herbs Map.md')).isSymbolicLink());
    assert.equal(readlinkSync(join(gen(f), 'Old Map.md')), old, 'a link with a stale map name was removed');
  } finally { f.cleanup(); }
});
