// The Deck manifest is a contract with Deck: these fields are what Deck reads
// to start the app, pass it the vault and a data folder, and show its status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/serve.js';
import { fixture } from './fixture.js';

const REPO = new URL('..', import.meta.url).pathname;
const m = JSON.parse(readFileSync(join(REPO, 'deck.json'), 'utf8'));

test('deck.json: id, vault and data, a command that exists, a url on the configured port', () => {
  assert.equal(m.id, 'atlas');
  assert.equal(m.vault, true);
  assert.equal(m.data, true);
  assert.equal(m.cwd, '{app}');
  assert.deepEqual(m.cmd.slice(0, 2), ['node', 'src/cli.js']);
  assert.ok(existsSync(join(REPO, m.cmd[1])));
  assert.equal(m.portKey, 'port');
  assert.equal(m.url, 'http://127.0.0.1:{port}/');
  assert.equal(m.config.port.flag, '--port');
});

test('deck.json: the default port is the CLI\'s, and not 4173', () => {
  const port = m.config.port.default;
  assert.notEqual(port, 4173);
  assert.equal(Number(readFileSync(join(REPO, 'src/cli.js'), 'utf8').match(/const PORT = (\d+);/)[1]), port);
});

test('deck.json: the status route answers one line in the shape Deck reads', async () => {
  const f = fixture();
  const server = createApp({ config: f.config() });
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const r = await fetch(new URL(m.status, `http://127.0.0.1:${server.address().port}/`));
    assert.equal(r.status, 200);
    const { status } = await r.json();
    assert.equal(typeof status, 'string');
    assert.doesNotMatch(status, /\n/);
    assert.ok(status.length <= 200);
  } finally { server.close(); f.cleanup(); }
});
