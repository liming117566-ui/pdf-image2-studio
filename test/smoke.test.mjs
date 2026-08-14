import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function read(relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), 'utf8');
}

test('repository includes the documented project surfaces', async () => {
  for (const relativePath of [
    'README.md',
    'CHANGELOG.md',
    'SECURITY.md',
    'public/index.html',
    'public/app.js',
    'public/styles.css',
    'src/server.mjs',
    'docs/screenshots/workspace.png',
  ]) {
    await fs.access(path.join(repoRoot, relativePath));
  }
});

test('source uses generic API configuration and keeps the public tree sanitized', async () => {
  const server = await read('src/server.mjs');
  const readme = await read('README.md');

  assert.match(server, /API_BASE_URL/);
  assert.match(server, /API_KEY/);
  for (const forbidden of [
    Buffer.from('U1VCMkFQSQ==', 'base64').toString(),
    Buffer.from('YXVy b3JhcQ=='.replace(' ', ''), 'base64').toString(),
    Buffer.from('MzguMjQ2LjI0NS4xNTQ=', 'base64').toString(),
  ]) {
    assert.equal(server.includes(forbidden), false);
  }
  assert.match(server, /GENERATION_CONCURRENCY/);
  assert.match(server, /three-four/);
  assert.match(readme, /SECURITY\.md/);
  assert.match(readme, /CHANGELOG\.md/);
});
