// Where Atlas reads and writes. Nothing here lives in the app's own folder:
// the config and the bundle sit in the data folder (DECK_APP_DATA, or --data),
// the notes in the vault (DECK_VAULT, or --vault) and in folders the user adds.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const expand = p => (p === '~' || p.startsWith('~/')) ? join(homedir(), p.slice(1)) : p;

/** Dailies repeat themselves too much to index; projects and knowledge do not. */
export const VAULT_GLOBS = ['Projects/*.md', 'Knowledge/*.md'];
/** What an added folder contributes: a repo's README and its docs. */
export const FOLDER_GLOBS = ['README.md', 'docs/**/*.md'];
export const NEAR_DUPLICATE = { threshold: 0.82, minWords: 120 };

/** Flags first, then what Deck passes. Either may be missing. */
export function locate({ data, vault } = {}, env = process.env) {
  const d = data ?? env.DECK_APP_DATA, v = vault ?? env.DECK_VAULT;
  return { dataDir: d ? resolve(expand(d)) : null, vault: v ? resolve(expand(v)) : null };
}

export const configFile = dataDir => join(dataDir, 'atlas.config.json');
export const bundleFile = config => join(config.dataDir, 'bundle.json');

function readUser(dataDir) {
  try { return JSON.parse(readFileSync(configFile(dataDir), 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`cannot read ${configFile(dataDir)}: ${e.message}`);
  }
}

/**
 * The working config: the vault source (derived, never stored, so moving the
 * vault needs no edit) plus the folders in the data folder's config file.
 * The vault source is optional: a new vault has empty Projects/ and Knowledge/.
 */
export function loadConfig({ dataDir, vault }) {
  if (!dataDir) throw new Error('no data folder: run inside Deck (DECK_APP_DATA) or pass --data <dir>');
  const user = readUser(dataDir);
  const sources = [];
  if (vault) sources.push({ id: 'vault', label: 'Vault', dir: vault, globs: user.vaultGlobs ?? VAULT_GLOBS, optional: true });
  for (const f of user.folders ?? [])
    sources.push({ id: f.id, label: f.label ?? f.id, dir: resolve(expand(f.dir)), globs: f.globs ?? FOLDER_GLOBS });
  return { dataDir, vault, sources, nearDuplicate: { ...NEAR_DUPLICATE, ...user.nearDuplicate } };
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'folder';

/** Add a folder to the config. Its id comes from its name, made unique. */
export function addFolder(dataDir, dir, { label, globs } = {}) {
  const full = resolve(expand(dir));
  if (!existsSync(full)) throw new Error(`no such folder: ${full}`);
  const user = readUser(dataDir);
  user.folders ??= [];
  if (user.folders.some(f => resolve(expand(f.dir)) === full)) throw new Error(`already added: ${full}`);
  const base = slug(basename(full));
  let id = base;
  for (let n = 2; id === 'vault' || user.folders.some(f => f.id === id); n++) id = `${base}-${n}`;
  user.folders.push({ id, label: label ?? basename(full), dir: full, ...(globs ? { globs } : {}) });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configFile(dataDir), JSON.stringify(user, null, 2) + '\n');
  return id;
}
