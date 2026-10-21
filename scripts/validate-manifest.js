import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MAX_MANIFEST_BYTES, validateManifest } from '../lib/manifest.js';
import { validateUpdater } from '../lib/updater.js';

async function load(path, optional = false) {
  try {
    if ((await stat(path)).size > MAX_MANIFEST_BYTES) throw new Error('File exceeds 2 MiB.');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}

try {
  const path = resolve(process.argv[2] ?? 'releases.json');
  const manifest = validateManifest(await load(path));
  let files = 0;
  for (const channel of ['stable', 'preview']) {
    const value = await load(join(dirname(path), 'updater', `${channel}.json`), true);
    if (value !== null) { validateUpdater(value, manifest, channel); files++; }
  }
  console.log(`Validated ${manifest.releases.length} published releases and ${files} updater files.`);
} catch (error) {
  console.error(`Invalid release manifest: ${error.message}`);
  process.exitCode = 1;
}
