import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest } from './fixtures.js';

const script = fileURLToPath(new URL('../scripts/validate-manifest.js', import.meta.url));
test('validation CLI accepts a valid file and rejects malformed data with a nonzero status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voicewoven-validate-'));
  try {
    const path = join(directory, 'releases.json');
    await writeFile(path, JSON.stringify(manifest()));
    assert.equal(spawnSync(process.execPath, [script, path], { encoding: 'utf8' }).status, 0);
    await writeFile(path, JSON.stringify({ ...manifest(), repository: 'other/repo' }));
    const invalid = spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Invalid release manifest/);
    await writeFile(path, 'x'.repeat(2 * 1024 * 1024 + 1));
    assert.equal(spawnSync(process.execPath, [script, path]).status, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
