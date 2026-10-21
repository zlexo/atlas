#!/usr/bin/env node
// The proof that Atlas works as a Deck App, through a throwaway Deck: its own
// HOME, data and config folders, no background jobs. It creates a vault, fills
// it with the fixture notes, installs this repo's committed HEAD with Deck's
// own installer (a local clone in place of `gh repo clone`), starts Atlas
// through Deck, and asks Deck's Vault page route for the apps that use the
// vault and their status lines.
//
//   node scripts/check-deck.mjs --deck <a Deck checkout> [--plant no-vault|no-status]
//
//   --plant no-vault    planted control: the installed manifest loses
//                       `vault: true`, so Deck must not list Atlas (red)
//   --plant no-status   planted control: the manifest loses its status route,
//                       so the list carries no status line (red)
//
// Exit 0 passed, 1 failed, 2 not run.
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const say = s => console.log(`check-deck: ${s}`);
const notRun = s => { console.error(`check-deck: ${s}`); process.exit(2); };
const argv = process.argv.slice(2);
const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const DECK = arg('--deck') ?? process.env.DECK_ROOT;
const PLANT = arg('--plant') ?? null;
if (!DECK || !existsSync(join(DECK, 'server.js'))) notRun('pass --deck <a Deck checkout> (or DECK_ROOT)');
if (PLANT && !['no-vault', 'no-status'].includes(PLANT)) notRun(`--plant takes no-vault or no-status, not ${PLANT}`);
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HEAD = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

// ---------------------------------------------------------------- throwaway Deck
const ROOT = mkdtempSync(join(tmpdir(), 'atlas-check-deck-'));
const HOME = join(ROOT, 'home'), DATA = join(ROOT, 'data'), CONFIG = join(ROOT, 'config');
for (const d of [HOME, DATA, CONFIG]) mkdirSync(d, { recursive: true });
writeFileSync(join(CONFIG, 'state.json'), '{"scanRoots":[]}'); // installed apps only, no discovery
process.env.DECK_DATA = DATA; // read by Deck's installer below
say(`throwaway Deck in ${ROOT}`);
say(`installing atlas at ${HEAD.slice(0, 7)}`);

const freePort = () => new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = ms => new Promise(r => setTimeout(r, ms));
class Fail extends Error {}
const fail = s => { throw new Fail(s); };
let gw = null, port = 0, atlasStarted = false, logs = '';

const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const b = await r.json().catch(() => null);
  if (r.status !== 200) fail(`${method} ${p} answered ${r.status}: ${JSON.stringify(b).slice(0, 300)}`);
  return b;
};

async function cleanup() {
  if (atlasStarted) try { await api('POST', '/api/tools/atlas/stop'); } catch {}
  if (gw && gw.exitCode === null && gw.signalCode === null) {
    const gone = new Promise(r => gw.once('exit', r));
    gw.kill('SIGTERM');
    if (!await Promise.race([gone.then(() => true), wait(5000).then(() => false)])) { gw.kill('SIGKILL'); await gone; }
  }
  rmSync(ROOT, { recursive: true, force: true });
}

try {
  // 1. Install the committed HEAD the way Deck installs an app: its installer,
  // with a local clone instead of `gh repo clone`.
  const { install } = await import(pathToFileURL(join(DECK, 'lib', 'apps', 'install.mjs')).href);
  const manifest = JSON.parse(readFileSync(join(REPO, 'deck.json'), 'utf8'));
  const clone = (_repo, dest) => new Promise(r => {
    const c = spawn('git', ['clone', '--quiet', REPO, dest], { stdio: 'ignore' });
    c.on('exit', code => r({ code }));
  });
  await install({ repo: 'local/atlas', manifest, latest: { sha: HEAD } }, { clone });
  const APP = join(DATA, 'apps', 'atlas');
  if (!existsSync(join(APP, 'deck.json'))) fail(`the installer left no deck.json in ${APP}`);
  if (PLANT) {
    const m = JSON.parse(readFileSync(join(APP, 'deck.json'), 'utf8'));
    if (PLANT === 'no-vault') delete m.vault; else delete m.status;
    writeFileSync(join(APP, 'deck.json'), JSON.stringify(m, null, 2));
    say(`PLANTED: the installed manifest has no ${PLANT === 'no-vault' ? '`vault: true`' : 'status route'}`);
  }
  say(`installed into the apps folder: ${readdirSync(APP).filter(f => !f.startsWith('.')).sort().join(', ')}`);

  // 2. The gateway, on a spare port, with the throwaway folders.
  port = await freePort();
  const { DECK_VAULT: _v, DECK_APP_DATA: _d, ...inherited } = process.env;
  gw = spawn(process.execPath, [join(DECK, 'server.js')], { cwd: DECK, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...inherited, HOME, PORT: String(port), DECK_ROOT: DECK, DECK_DATA: DATA, DECK_CONFIG: CONFIG,
           DECK_NO_BACKGROUND: '1', DECK_CLI: 'off', DECK_HOST: '' } });
  gw.stdout.on('data', d => logs += d); gw.stderr.on('data', d => logs += d);
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/api/version`)).ok; } catch { await wait(100); } }
  if (!up) fail(`the gateway never answered on :${port}. Its output:\n${logs}`);
  say(`gateway pid ${gw.pid} on :${port}`);

  // 3. A vault, filled with the fixture notes.
  const vault = (await api('POST', '/api/vault/create', {})).path;
  for (const d of ['Projects', 'Knowledge', 'Daily'])
    cpSync(join(REPO, 'fixtures', 'garden', d), join(vault, d), { recursive: true });
  say(`vault created by Deck at ${vault}, filled with the garden fixture`);

  // 4. Deck lists the app; start it on a spare port through Deck.
  const tools = (await api('GET', '/api/tools')).tools;
  const listed = (Array.isArray(tools) ? tools : Object.values(tools)).find(t => t.id === 'atlas');
  if (!listed) fail('GET /api/tools does not list atlas');
  const atlasPort = await freePort();
  await api('PUT', '/api/tools/atlas/config', { values: { port: atlasPort } });
  const started = await api('POST', '/api/tools/atlas/start');
  atlasStarted = true;
  say(`Deck started atlas: pid ${started.pid} on :${atlasPort}`);
  let ok = false;
  for (let i = 0; i < 100 && !ok; i++) { try { ok = (await fetch(`http://127.0.0.1:${atlasPort}/status-line`)).ok; } catch { await wait(100); } }
  if (!ok) fail(`atlas never answered on :${atlasPort}. Its log:\n${(await api('GET', '/api/tools/atlas/logs')).logs.join('\n')}`);

  // 5. The Vault page's list of apps that use the vault, with the status line.
  const { apps } = await api('GET', '/api/vault/apps');
  say(`GET /api/vault/apps -> ${JSON.stringify(apps)}`);
  const a = apps.find(x => x.id === 'atlas');
  if (!a) fail('GET /api/vault/apps does not list atlas: Deck does not see `vault: true`');
  if (!a.status) fail(`atlas is listed without a status line (${a.statusError ?? 'no status route'})`);
  if (!/^index current, 12 notes, 1 duplicate pair$/.test(a.status)) fail(`unexpected status line: ${a.status}`);

  // 6. Where Atlas wrote: the bundle into its data folder, maps into the vault, nothing into the app.
  const appData = join(DATA, 'app-data', 'atlas');
  if (!existsSync(join(appData, 'bundle.json'))) fail(`no bundle in Deck's data folder for the app (${appData})`);
  const maps = readdirSync(join(vault, 'Maps', 'Generated')).sort();
  if (!maps.includes('Duplicates.md')) fail('no Maps/Generated/Duplicates.md in the vault');
  const tracked = new Set(execFileSync('git', ['-C', APP, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean));
  const extra = execFileSync('git', ['-C', APP, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
  if (extra) fail(`atlas wrote into its app folder:\n${extra}`);
  say(`bundle in app-data/atlas: ${readdirSync(appData).sort().join(', ')}`);
  say(`maps in the vault: ${maps.join(', ')}`);
  say(`the app folder is as installed (${tracked.size} tracked files, nothing changed or added)`);
  say((await api('GET', '/api/tools/atlas/logs')).logs.map(l => `  atlas log: ${l}`).join('\n'));

  await cleanup();
  say('PASS; throwaway Deck stopped and removed');
} catch (e) {
  if (!(e instanceof Fail)) console.error(e);
  console.error(`check-deck: FAIL ${e.message}`);
  await cleanup().catch(err => console.error(`check-deck: cleanup: ${err.message}`));
  process.exit(1);
}
