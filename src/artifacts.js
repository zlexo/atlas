// One implementation of every build, shared by the CLI and the server, so the
// two can never drift apart.
import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { buildCorpus, findDuplicates } from './corpus.js';
import { inputFingerprint } from './freshness.js';
import { bundleFile } from './config.js';

// A source that matched nothing is refused, not skipped. A folder that moved
// away would otherwise leave the index without a word, and everything read
// from the index would go on believing it had those notes.
export class EmptySource extends Error {
  constructor(sources) {
    super('empty source, refused to rebuild: ' +
      sources.map(s => `${s.id} matched nothing in ${s.dir} (${s.globs.join(', ')})`).join('; '));
    this.sources = sources;
  }
}

/** Build the bundle into the data folder. Throws EmptySource; writes nothing then. */
export function buildBundle(config) {
  if (!config.sources.length) throw new Error('nothing to index: no vault (DECK_VAULT or --vault) and no folders added');
  const inputs = inputFingerprint(config);
  const corpus = buildCorpus(config);
  if (corpus.empty.length) throw new EmptySource(corpus.empty);
  const bundle = {
    version: 1,
    builtAt: new Date().toISOString(),
    builtFrom: corpus.builtFrom,
    inputs: { fingerprint: inputs.all, bySource: inputs.bySource },
    sources: config.sources.map(({ id, label, dir, globs }) => ({ id, label, dir, globs })),
    duplicates: findDuplicates(corpus.entries, config.nearDuplicate),
    entries: corpus.entries,
  };
  // Written beside and renamed, so a reader never sees half a bundle.
  mkdirSync(config.dataDir, { recursive: true });
  const out = bundleFile(config);
  writeFileSync(out + '.tmp', JSON.stringify(bundle));
  renameSync(out + '.tmp', out);
  return bundle;
}
