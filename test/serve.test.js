// The server promises that what you fetch is current. These tests plant a
// stale bundle and prove a GET rebuilds it, prove a fresh one is NOT rebuilt,
// and prove a refused rebuild serves the old bundle with the refusal visible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { createApp, serve } from '../src/serve.js';
import { buildBundle, buildMaps } from '../src/artifacts.js';
import { bundleFile } from '../src/config.js';
import { MARKER } from '../src/moc.js';
import { fixture } from './fixture.js';

async function withApp(f, fn, extra = {}) {
  const server = createApp({ config: f.config(), ...extra });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async p => { const r = await fetch(base + p); const text = await r.text(); return { status: r.status, text, json: () => JSON.parse(text) }; };
  try { await fn(get, server); } finally { server.close(); }
}
const row = async (get, id) => (await get('/status.json')).json().artifacts.find(a => a.id === id);
const gen = f => join(f.vault, 'Maps', 'Generated');
const sentinel = f => { mkdirSync(gen(f), { recursive: true }); writeFileSync(join(gen(f), 'Sentinel Map.md'), `${MARKER}\nno tag\n`); };
const sentinelGone = f => !existsSync(join(gen(f), 'Sentinel Map.md'));

test('a planted stale bundle is rebuilt on the first GET', async () => {
  const f = fixture();
  mkdirSync(f.data, { recursive: true });
  writeFileSync(bundleFile(f.config()), JSON.stringify({ builtAt: '2000-01-01T00:00:00Z', inputs: { fingerprint: 'planted' }, entries: [] }));
  await withApp(f, async get => {
    const b = (await get('/bundle.json')).json();
    assert.notEqual(b.inputs.fingerprint, 'planted', 'the planted bundle was served as it was');
    assert.equal(b.entries.length, 15);
  });
  f.cleanup();
});

test('control: a fresh bundle is served untouched', async () => {
  const f = fixture();
  const built = buildBundle(f.config());
  await withApp(f, async get => {
    assert.equal((await get('/bundle.json')).json().builtAt, built.builtAt, 'a fresh bundle must not be rebuilt on read');
    assert.equal((await row(get, 'bundle')).fresh, true);
  });
  f.cleanup();
});

test('a refused rebuild serves the old bundle, says why, and clears once the folder is back', async () => {
  const f = fixture();
  const built = buildBundle(f.config());
  const docs = join(f.catalog, 'docs'), readme = join(f.catalog, 'README.md');
  const keep = [readFileSync(join(docs, 'sowing.md')), readFileSync(join(docs, 'germination.md')), readFileSync(readme)];
  rmSync(docs, { recursive: true }); rmSync(readme);
  await withApp(f, async get => {
    const r = await get('/bundle.json');
    assert.equal(r.status, 200, 'never a blank page');
    assert.equal(r.json().builtAt, built.builtAt, 'the previous bundle is served');
    const s = (await get('/status.json')).json();
    assert.equal(s.ok, false);
    assert.match(s.artifacts.find(a => a.id === 'bundle').lastError, /empty source.*seed-catalog/);
    const line = (await get('/status-line')).json().status;
    assert.match(line, /^stale: index empty source/);
    assert.doesNotMatch(line, /\n/, 'Deck shows one line');
    mkdirSync(docs);
    writeFileSync(join(docs, 'sowing.md'), keep[0]); writeFileSync(join(docs, 'germination.md'), keep[1]); writeFileSync(readme, keep[2]);
    const b = await row(get, 'bundle');
    assert.equal(b.fresh, true, 'the folder is back as it was');
    assert.equal(b.lastError, undefined, 'and the old error is gone');
  });
  f.cleanup();
});

test('status line: one line in the shape Deck reads, current after a read', async () => {
  const f = fixture();
  await withApp(f, async get => {
    const r = await get('/status-line');
    assert.equal(r.status, 200);
    const line = r.json().status;
    assert.equal(typeof line, 'string');
    assert.equal(line, 'index current, 15 notes, 1 duplicate pair');
    writeFileSync(join(f.vault, 'Knowledge', 'Basil.md'), '# Basil\n\nChanged.\n');
    assert.match((await get('/status-line')).json().status, /^stale: maps notes changed/, 'inside the sweep cooldown the maps wait');
  });
  f.cleanup();
});

test('stale maps are swept on a status read, at most once a cooldown', async () => {
  const f = fixture();
  buildMaps(f.config());
  sentinel(f);
  writeFileSync(join(f.vault, 'Knowledge', 'Mulch.md'), '# Mulch\n\nEdited.\n');
  await withApp(f, async get => {
    assert.equal((await row(get, 'maps')).fresh, true, 'the read swept the maps');
    assert.ok(sentinelGone(f), 'the sweep really rewrote the folder');
    sentinel(f);
    writeFileSync(join(f.vault, 'Knowledge', 'Mulch.md'), '# Mulch\n\nEdited again.\n');
    assert.equal((await row(get, 'maps')).fresh, false, 'the row tells the truth while it waits');
    assert.ok(!sentinelGone(f), 'no second write inside the cooldown');
  });
  f.cleanup();
});

test('control: fresh maps are not rewritten; with the sweep off the vault is untouched', async () => {
  const f = fixture();
  buildMaps(f.config());
  sentinel(f);
  const front = join(gen(f), 'Generated Maps.md'), mtime = statSync(front).mtimeMs;
  await withApp(f, async get => {
    for (let i = 0; i < 3; i++) assert.equal((await row(get, 'maps')).fresh, true);
    assert.ok(!sentinelGone(f));
    assert.equal(statSync(front).mtimeMs, mtime);
  });
  writeFileSync(join(f.vault, 'Knowledge', 'Mulch.md'), '# Mulch\n\nEdited.\n');
  await withApp(f, async get => {
    assert.equal((await row(get, 'maps')).fresh, false);
    assert.ok(!sentinelGone(f), 'the sweep was off');
  }, { sweepMaps: false });
  f.cleanup();
});

test('only the app folder and the routes are served', async () => {
  const f = fixture();
  buildBundle(f.config());
  await withApp(f, async (get, server) => {
    const index = await get('/');
    assert.equal(index.status, 200);
    assert.match(index.text, /<script type="module" src="app.js">/);
    // Raw paths: fetch() would normalise the dots away before they reach the server.
    for (const p of ['/..%2fpackage.json', '/..%2f..%2fREADME.md']) {
      const status = await new Promise(r => request({ host: '127.0.0.1', port: server.address().port, path: p }, res => { res.resume(); r(res.statusCode); }).end());
      assert.equal(status, 404, p);
    }
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/bundle.json/../atlas.config.json', '/atlas.config.json', '/src/serve.js'])
      assert.equal((await get(p)).status, 404, p);
  });
  f.cleanup();
});

test('a change to the server\'s own code is reported until restart', async () => {
  const f = fixture();
  const src = join(f.dir, 'fake-src');
  mkdirSync(src);
  writeFileSync(join(src, 'serve.js'), '// v1\n');
  await withApp(f, async get => {
    assert.equal((await row(get, 'server')).fresh, true);
    writeFileSync(join(src, 'serve.js'), '// v2\n');
    assert.match((await row(get, 'server')).reason, /restart/);
    writeFileSync(join(src, 'serve.js'), '// v1\n');
    assert.equal((await row(get, 'server')).fresh, true, 'the same content again is not a change');
  }, { srcDir: src });
  f.cleanup();
});

test('serve binds this machine only', async () => {
  const f = fixture();
  const server = serve({ port: 0, config: f.config(), log: () => {} });
  try {
    await new Promise(r => server.once('listening', r));
    assert.equal(server.address().address, '127.0.0.1');
  } finally { server.close(); f.cleanup(); }
});
