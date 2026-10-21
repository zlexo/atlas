#!/usr/bin/env node
// Screenshots of the app on the made-up garden vault, taken in headless
// Chrome over the DevTools protocol (Node's own WebSocket; nothing to
// download). Everything runs on a throwaway copy of the fixtures.
//
//   node scripts/screenshots.mjs [--chrome <path>] [--out docs/screenshots]
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { addFolder, loadConfig } from '../src/config.js';
import { createApp } from '../src/serve.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const CHROME = arg('--chrome', process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const OUT = resolve(arg('--out', join(ROOT, 'docs', 'screenshots')));
if (!existsSync(CHROME)) { console.error(`screenshots: no Chrome at ${CHROME} (pass --chrome)`); process.exit(2); }

// Under /tmp, not the per-user temp folder: its path shows in the stale banner.
const tmp = mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'atlas-shots-'));
const vault = join(tmp, 'garden'), catalog = join(tmp, 'seed-catalog'), data = join(tmp, 'data');
cpSync(join(ROOT, 'fixtures', 'garden'), vault, { recursive: true });
cpSync(join(ROOT, 'fixtures', 'seed-catalog'), catalog, { recursive: true });
addFolder(data, catalog);
const server = createApp({ config: loadConfig({ dataDir: data, vault }) });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = join(tmp, 'chrome');
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--use-mock-keychain', '--password-store=basic', '--no-first-run', '--hide-scrollbars', 'about:blank'],
  { detached: true, stdio: 'ignore' });
const wait = ms => new Promise(r => setTimeout(r, ms));

try {
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await wait(100); }
  }
  if (!port) throw new Error('Chrome did not open its DevTools port');
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map(), events = [];
  ws.onmessage = m => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else events.push(msg.method);
  };
  const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

  async function shot(name, hash) {
    events.length = 0;
    await send('Page.navigate', { url: `${base}/?shot=${name}${hash}` });
    for (let i = 0; i < 100 && !events.includes('Page.loadEventFired'); i++) await wait(50);
    await wait(500); // the app fetches status and bundle after load
    const r = await send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    console.log(`screenshots: ${name}.png`);
  }
  await shot('notes', '#/');
  await shot('note', `#/note/${encodeURIComponent('vault:Projects/Raised Beds.md')}`);
  await shot('search', '#/search/compost');
  await shot('maps', '#/maps');
  await shot('duplicates', '#/duplicates');
  rmSync(join(catalog, 'docs'), { recursive: true }); // a folder that lost its files: the banner
  rmSync(join(catalog, 'README.md'));
  await shot('stale', '#/');
  ws.close();
} finally {
  try { process.kill(-chrome.pid, 'SIGTERM'); } catch {}
  server.close();
  await wait(300);
  rmSync(tmp, { recursive: true, force: true });
}
