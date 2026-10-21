import { resolve } from 'node:path';
import { synchronize } from '../lib/sync.js';

try {
  const { changed, manifest } = await synchronize({ path: resolve('releases.json'), token: process.env.GITHUB_TOKEN,
    onSkip: version => console.warn(`Skipped the updater entry of ${version}: its signature file is unreadable or invalid.`) });
  console.log(`${changed ? 'Updated' : 'Unchanged'} manifest: ${manifest.releases.length} published releases.`);
} catch {
  // Network errors can contain signed CDN URLs. Keep credentials and request details out of logs.
  console.error('Release synchronization failed. The previous manifest was preserved. Check API availability and release asset metadata, then retry.');
  process.exitCode = 1;
}
