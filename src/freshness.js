// Freshness. "Is this current?" has one honest answer: compare what the
// bundle recorded with its inputs as they are on disk right now. The witness
// is a fingerprint of the files' contents, not a commit (notes are edited all
// day before anyone commits them) and not an mtime (a checkout that changes
// nothing must not read as a change).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sourceFiles, relPath } from './corpus.js';
import { bundleFile } from './config.js';

/** Fingerprint of every file the sources name: per source and overall. */
export function inputFingerprint(config) {
  const bySource = {};
  const all = createHash('sha256');
  for (const src of config.sources) {
    const h = createHash('sha256');
    for (const file of sourceFiles(src)) {
      const line = `${relPath(src.dir, file)}:${createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)}\n`;
      h.update(line);
      all.update(`${src.id}/${line}`);
    }
    bySource[src.id] = h.digest('hex').slice(0, 16);
  }
  return { all: all.digest('hex').slice(0, 16), bySource };
}

export const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

export function bundleStatus(config, now = inputFingerprint(config)) {
  const bundle = readJson(bundleFile(config));
  const base = { id: 'bundle', label: 'Index' };
  if (!bundle) return { ...base, fresh: false, reason: 'not built yet' };
  const recorded = bundle.inputs?.fingerprint ?? null;
  const fresh = recorded === now.all;
  const known = Object.keys(bundle.inputs?.bySource ?? {});
  const changed = Object.keys(now.bySource).filter(k => bundle.inputs?.bySource?.[k] !== now.bySource[k]);
  const dropped = known.filter(k => !(k in now.bySource));
  return {
    ...base, fresh, builtAt: bundle.builtAt ?? null,
    entries: bundle.entries?.length ?? 0,
    reason: fresh ? `${bundle.entries?.length ?? 0} notes, inputs unchanged`
      : recorded == null ? 'built without a fingerprint'
      : `changed since the last build: ${[...changed, ...dropped].join(', ') || 'the source list'}`,
  };
}

/** Every artifact against its input. `errors` holds the last failed rebuild per artifact id. */
export function status(config, { errors = {} } = {}) {
  const artifacts = [bundleStatus(config)]
    .map(a => errors[a.id] ? { ...a, fresh: false, lastError: errors[a.id] } : a);
  return { at: new Date().toISOString(), ok: artifacts.every(a => a.fresh), artifacts };
}
