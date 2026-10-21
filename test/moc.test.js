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
