// The server rebuilds on read. A request for /bundle.json compares the bundle
// with the files on disk now and rebuilds when they differ; a status read also
// sweeps the generated maps when the notes behind them moved. Nothing runs on
// a schedule, and a tab left open for a week shows what is true when it is
// refreshed. When a rebuild fails, the OLD bundle is served and the status
// carries the error: a stale page with a red banner is honest, a blank one is not.
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle, buildMaps } from './artifacts.js';
import { bundleStatus, mapsStatus, status } from './freshness.js';
import { bundleFile } from './config.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

/** Fingerprint of the server's own code: after an update, the status says a restart is due. */
export function codeFingerprint(dir) {
  const h = createHash('sha256');
  try { for (const f of readdirSync(dir).filter(f => f.endsWith('.js')).sort()) h.update(f + '\0').update(readFileSync(join(dir, f))); }
  catch { return null; }
  return h.digest('hex').slice(0, 16);
}

/** The one line Deck's Vault page shows beside the app. */
export function statusLine(s) {
  const bad = s.artifacts.filter(a => !a.fresh);
  if (bad.length) return `stale: ${bad.map(a => `${a.label.toLowerCase()} ${a.lastError ?? a.reason}`).join('; ')}`;
  const n = s.artifacts.find(a => a.id === 'bundle')?.entries ?? 0;
  const maps = s.artifacts.find(a => a.id === 'maps');
  return `index current, ${n} ${n === 1 ? 'note' : 'notes'}` +
    (maps ? `, ${maps.pairs} duplicate ${maps.pairs === 1 ? 'pair' : 'pairs'}` : '');
}

export function createApp({ config, root = resolve(HERE, '..', 'app'), srcDir = HERE,
                            sweepMaps = true, sweepMs = 60_000, log = () => {} }) {
  const errors = {};
  const startedAt = new Date().toISOString();
  const codeAtStart = codeFingerprint(srcDir);

  function ensureBundle() {
    const s = bundleStatus(config);
    if (s.fresh) { delete errors.bundle; return; }
    try { const b = buildBundle(config); delete errors.bundle; log(`rebuilt the index: ${b.entries.length} notes (${s.reason})`); }
    catch (e) { errors.bundle = e.message; log(`index rebuild FAILED: ${e.message}`); }
  }

  // The maps are the one rebuild that writes into the VAULT, so it has limits
  // the bundle does not: at most one sweep per `sweepMs`, so a polled page
  // cannot write at the rate someone saves a note, with the cooldown taken
  // BEFORE the attempt so a failing sweep waits its turn too.
  let lastSweep = 0;
  function ensureMaps() {
    if (!config.vault || !sweepMaps) return;
    if (mapsStatus(config).fresh) { delete errors.maps; return; }
    if (lastSweep && Date.now() - lastSweep < sweepMs) return;
    lastSweep = Date.now();
    try {
      const r = buildMaps(config);
      if (r.errors.length) errors.maps = `${r.errors.length} file(s) not written: ${r.errors.map(e => `${e.file} (${e.error})`).join('; ')}`;
      else delete errors.maps;
      log(`swept the maps: ${r.written.length} written${r.errors.length ? `, ${errors.maps}` : ''}`);
    }
    catch (e) { errors.maps = e.message; log(`map sweep FAILED: ${e.message}`); }
  }

  function fullStatus() {
    ensureBundle(); ensureMaps();
    const s = status(config, { errors });
    const now = codeFingerprint(srcDir);
    const fresh = codeAtStart != null && now === codeAtStart;
    s.artifacts.push({ id: 'server', label: 'Server', fresh,
      reason: fresh ? `running the code on disk since ${startedAt.slice(11, 16)} UTC` : 'its code changed since it started: restart it' });
    s.ok = s.artifacts.every(a => a.fresh);
    return s;
  }

  const send = (res, code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'GET only');
    if (url.pathname === '/status.json') return send(res, 200, TYPES['.json'], JSON.stringify(fullStatus(), null, 2));
    if (url.pathname === '/status-line') return send(res, 200, TYPES['.json'], JSON.stringify({ status: statusLine(fullStatus()) }));
    if (url.pathname === '/bundle.json') {
      ensureBundle();
      const f = bundleFile(config);
      return existsSync(f) ? send(res, 200, TYPES['.json'], readFileSync(f)) : send(res, 404, 'text/plain', errors.bundle ?? 'not built');
    }
    let rel;
    try { rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch { return send(res, 400, 'text/plain', 'bad path'); }
    const f = resolve(root, '.' + rel);
    if (!f.startsWith(root + sep) || !existsSync(f)) return send(res, 404, 'text/plain', 'not found');
    send(res, 200, TYPES[extname(f)] ?? 'text/plain', readFileSync(f));
  });
}

/** Loopback only: the vault never leaves this machine through Atlas. */
export function serve({ port, host = '127.0.0.1', ...rest }) {
  const server = createApp({ log: m => console.log(`atlas: ${m}`), ...rest });
  server.listen(port, host, () => console.log(`atlas: http://${host}:${server.address().port}/`));
  return server;
}
