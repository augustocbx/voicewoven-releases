import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MAX_MANIFEST_BYTES, validateManifest } from '../lib/manifest.js';

try {
  const path = resolve(process.argv[2] ?? 'releases.json');
  if ((await stat(path)).size > MAX_MANIFEST_BYTES) throw new Error('File exceeds 2 MiB.');
  const manifest = validateManifest(JSON.parse(await readFile(path, 'utf8')));
  console.log(`Validated ${manifest.releases.length} published releases.`);
} catch (error) {
  console.error(`Invalid release manifest: ${error.message}`);
  process.exitCode = 1;
}
