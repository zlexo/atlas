// A throwaway copy of the made-up garden vault and seed-catalog folder, so a
// test can edit notes without touching the repo.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, addFolder } from '../src/config.js';

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;

export function fixture({ folder = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-test-'));
  const vault = join(dir, 'garden'), catalog = join(dir, 'seed-catalog'), data = join(dir, 'data');
  cpSync(join(FIXTURES, 'garden'), vault, { recursive: true });
  cpSync(join(FIXTURES, 'seed-catalog'), catalog, { recursive: true });
  if (folder) addFolder(data, catalog);
  return {
    dir, vault, catalog, data,
    config: () => loadConfig({ dataDir: data, vault }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
