// Every freshness check is proven both ways: fresh when nothing changed AND
// stale when something did. A check that cannot fail is not a check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildBundle, buildMaps, EmptySource } from '../src/artifacts.js';
import { bundleStatus, status } from '../src/freshness.js';
import { locate, loadConfig, addFolder, bundleFile, configFile } from '../src/config.js';
import { fixture } from './fixture.js';

const REPO = new URL('..', import.meta.url).pathname;
const CLI = join(REPO, 'src/cli.js');

test('locate: flags win over what Deck passes; either may be missing', () => {
  const env = { DECK_APP_DATA: '/tmp/a', DECK_VAULT: '/tmp/v' };
  assert.deepEqual(locate({}, env), { dataDir: '/tmp/a', vault: '/tmp/v' });
  assert.deepEqual(locate({ data: '/tmp/b', vault: '/tmp/w' }, env), { dataDir: '/tmp/b', vault: '/tmp/w' });
  assert.deepEqual(locate({}, {}), { dataDir: null, vault: null });
  assert.throws(() => loadConfig({ dataDir: null, vault: '/tmp/v' }), /no data folder/);
});

test('addFolder: the config goes into the data folder, ids stay unique, a folder is added once', () => {
  const f = fixture({ folder: false });
  try {
    assert.equal(addFolder(f.data, f.catalog), 'seed-catalog');
    assert.ok(existsSync(configFile(f.data)));
    assert.throws(() => addFolder(f.data, f.catalog), /already added/);
    mkdirSync(join(f.dir, 'other', 'seed-catalog'), { recursive: true });
    assert.equal(addFolder(f.data, join(f.dir, 'other', 'seed-catalog')), 'seed-catalog-2');
    assert.throws(() => addFolder(f.data, join(f.dir, 'nope')), /no such folder/);
  } finally { f.cleanup(); }
});

test('build: fresh after a build, stale after an edit, fresh again after a same-content rewrite', () => {
  const f = fixture();
  try {
    const config = f.config();
    buildBundle(config);
    assert.equal(bundleStatus(config).fresh, true, 'just built must be fresh');
    const note = join(f.vault, 'Knowledge/Basil.md');
    const original = readFileSync(note, 'utf8');
    writeFileSync(note, original + '\nAn edit.\n');
    const s = bundleStatus(config);
    assert.equal(s.fresh, false, 'an edited note must read as stale');
    assert.match(s.reason, /vault/);
    assert.doesNotMatch(s.reason, /seed-catalog/, 'only the source that changed is named');
    writeFileSync(note, original); // same content, new mtime: not a change
    assert.equal(bundleStatus(config).fresh, true, 'content, not mtime, is the witness');
  } finally { f.cleanup(); }
});

test('build: the bundle lands in the data folder, and only there', () => {
  const f = fixture();
  try {
    const before = readdirSync(f.vault, { recursive: true }).sort();
    const b = buildBundle(f.config());
    assert.ok(existsSync(bundleFile(f.config())));
    assert.deepEqual(readdirSync(f.data).sort(), ['atlas.config.json', 'bundle.json']);
    assert.deepEqual(readdirSync(f.vault, { recursive: true }).sort(), before, 'the vault is not written');
    assert.deepEqual(b.sources.map(s => s.id), ['vault', 'seed-catalog']);
    assert.equal(b.entries.length, 15);
  } finally { f.cleanup(); }
});

test('status: a bundle without a fingerprint, a missing bundle and a new folder all read stale', () => {
  const f = fixture({ folder: false });
  try {
    assert.match(bundleStatus(f.config()).reason, /not built yet/);
    mkdirSync(f.data, { recursive: true });
    writeFileSync(bundleFile(f.config()), JSON.stringify({ version: 1, entries: [] }));
    assert.match(bundleStatus(f.config()).reason, /without a fingerprint/);
    buildBundle(f.config());
    buildMaps(f.config());
    assert.equal(status(f.config()).ok, true);
    addFolder(f.data, f.catalog);
    const s = status(f.config());
    assert.equal(s.ok, false, 'a folder added since the build is not in the index yet');
    assert.match(s.artifacts[0].reason, /seed-catalog/);
  } finally { f.cleanup(); }
});

test('build: a source that matches nothing is refused by name, and the old bundle stays', () => {
  const f = fixture();
  try {
    const first = buildBundle(f.config()); // control: the fixture as it is builds
    rmSync(join(f.catalog, 'docs'), { recursive: true });
    rmSync(join(f.catalog, 'README.md'));
    assert.throws(() => buildBundle(f.config()), e => e instanceof EmptySource && /seed-catalog/.test(e.message));
    assert.equal(JSON.parse(readFileSync(bundleFile(f.config()), 'utf8')).builtAt, first.builtAt);
  } finally { f.cleanup(); }
});

test('build: a new vault with empty Projects and Knowledge builds; a vault that is gone does not', () => {
  const f = fixture({ folder: false });
  try {
    for (const d of ['Projects', 'Knowledge']) { rmSync(join(f.vault, d), { recursive: true }); mkdirSync(join(f.vault, d)); }
    assert.equal(buildBundle(f.config()).entries.length, 0);
    rmSync(f.vault, { recursive: true });
    assert.throws(() => buildBundle(f.config()), EmptySource);
    assert.throws(() => buildBundle(loadConfig({ dataDir: f.data, vault: null })), /nothing to index/);
  } finally { f.cleanup(); }
});

test('cli: build then status exits 0; an edit makes status exit 1; no data folder exits 2', () => {
  const f = fixture();
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a, '--data', f.data, '--vault', f.vault],
    { encoding: 'utf8', env: { ...process.env, DECK_APP_DATA: '', DECK_VAULT: '' } });
  try {
    const b = run('build');
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /15 notes/);
    assert.equal(run('status').status, 1, 'no maps yet');
    assert.equal(run('moc').status, 0);
    assert.equal(run('status').status, 0);
    writeFileSync(join(f.vault, 'Knowledge/Mulch.md'), 'changed\n');
    const s = run('status');
    assert.equal(s.status, 1);
    assert.match(s.stdout, /STALE/);
    const none = spawnSync(process.execPath, [CLI, 'status'], { encoding: 'utf8', env: { ...process.env, DECK_APP_DATA: '' } });
    assert.equal(none.status, 2);
    assert.match(none.stderr, /no data folder/);
  } finally { f.cleanup(); }
});

test('the app folder holds no config and no bundle', () => {
  const tracked = execFileSync('git', ['-C', REPO, 'ls-files'], { encoding: 'utf8' }).split('\n');
  assert.ok(!tracked.some(t => /(^|\/)(atlas\.config|bundle)\.json$/.test(t)), tracked.join(', '));
});
