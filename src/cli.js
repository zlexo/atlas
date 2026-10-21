#!/usr/bin/env node
import { locate, loadConfig, addFolder, bundleFile } from './config.js';
import { buildBundle, buildMaps, EmptySource } from './artifacts.js';
import { status } from './freshness.js';

const args = process.argv.slice(2);
const cmd = args[0];
/** The value after `--name`, or undefined. Never the subcommand by accident. */
const opt = n => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};

const PORT = 4317;

const USAGE = `usage: atlas <command> [--data <dir>] [--vault <dir>]

  build             index the vault and the added folders into the data folder
  status            the index against its inputs; exit 1 when anything is stale
  moc [--dry-run]   maps by tag and the duplicates report, into <vault>/Maps/Generated
  add <folder>      index a folder too (its README.md and docs/)
  serve [--port ${PORT}] [--no-map-sweep]
                    the app on this machine only; rebuilds on read

The data folder holds the config and the index: DECK_APP_DATA, or --data.
The vault is DECK_VAULT, or --vault.`;

const fail = (msg, code = 1) => { console.error(`atlas: ${msg}`); process.exit(code); };

let config;
try {
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); process.exit(cmd ? 0 : 2); }
  const where = locate({ data: opt('--data'), vault: opt('--vault') });
  if (cmd === 'add') {
    const dir = args[1];
    if (!dir || dir.startsWith('--')) fail('add needs a folder', 2);
    if (!where.dataDir) fail('no data folder: pass --data <dir>', 2);
    console.log(`atlas: added ${addFolder(where.dataDir, dir)}; run build to index it`);
    process.exit(0);
  }
  config = loadConfig(where);
} catch (e) { fail(e.message, 2); }

if (cmd === 'build') {
  try {
    const b = buildBundle(config);
    const by = {};
    for (const e of b.entries) by[e.source] = (by[e.source] ?? 0) + 1;
    console.log(`atlas: ${b.entries.length} notes`);
    for (const s of b.sources) console.log(`  ${String(by[s.id] ?? 0).padStart(4)}  ${s.id}  ${s.dir}${b.builtFrom[s.id] ? ` @ ${b.builtFrom[s.id]}` : ''}`);
    const d = b.duplicates;
    if (d.exact.length || d.near.length) console.log(`  ${d.exact.length} identical group(s), ${d.near.length} near-duplicate pair(s)`);
    console.log(`atlas: wrote ${bundleFile(config)}`);
  } catch (e) {
    if (e instanceof EmptySource) {
      console.error('atlas: EMPTY SOURCE, refusing to build an index that silently lost a source.');
      for (const s of e.sources) console.error(`  ${s.id}: nothing in ${s.dir} matches ${s.globs.join(', ')}`);
      process.exit(1);
    }
    fail(e.message);
  }
} else if (cmd === 'moc') {
  const dryRun = args.includes('--dry-run');
  try {
    const r = buildMaps(config, { dryRun });
    console.log(`atlas: ${r.maps.length} map(s), ${r.pairs} duplicate pair(s)${dryRun ? ' (dry run, nothing written)' : ''}`);
    for (const m of r.maps) console.log(`  #${m.tag}  ${m.count}`);
    if (r.removed.length) console.log(`  removed ${r.removed.join(', ')}`);
    if (r.kept.length) console.log(`  kept, not ours (no marker, a link or a folder): ${r.kept.join(', ')}`);
    for (const e of r.errors) console.error(`  NOT WRITTEN ${e.file}: ${e.error}`);
    console.log(`atlas: ${dryRun ? 'would write' : 'wrote'} ${r.written.length} file(s) in ${r.dir}`);
    if (r.errors.length) process.exit(1);
  } catch (e) { fail(e.message); }
} else if (cmd === 'status') {
  const s = status(config);
  for (const a of s.artifacts) console.log(`  ${a.fresh ? 'fresh' : 'STALE'}  ${a.label.padEnd(10)} ${a.reason}`);
  console.log(s.ok ? 'atlas: everything is current' : 'atlas: something is stale');
  process.exit(s.ok ? 0 : 1);
} else if (cmd === 'serve') {
  const { serve } = await import('./serve.js');
  const port = opt('--port') === undefined ? PORT : Number(opt('--port'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`not a port: ${opt('--port')}`, 2);
  serve({ port, config, sweepMaps: !args.includes('--no-map-sweep') });
} else fail(`unknown command ${cmd}\n${USAGE}`, 2);
