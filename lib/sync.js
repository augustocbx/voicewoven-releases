import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assetName, assetUrl, compareVersions, EMPTY_MANIFEST, MAX_MANIFEST_BYTES, parseVersion, REPOSITORY, validateManifest, validateReleaseRecord } from './manifest.js';

const API = `https://api.github.com/repos/${REPOSITORY}`;
const API_BYTES = 8 * 1024 * 1024;
function ensure(condition, message) { if (!condition) throw new TypeError(message); }
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }

async function readLimited(response, maximum) {
  const length = response.headers.get('content-length');
  if (length !== null) ensure(/^\d+$/.test(length) && Number(length) <= maximum, 'Response exceeds the permitted size.');
  ensure(response.body, 'Empty response body.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      ensure(total <= maximum, 'Response exceeds the permitted size.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, total);
}
function utf8(bytes) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }

async function listPages(path, { fetchImpl, token }) {
  const results = [];
  for (let page = 1; page <= 11; page++) {
    // Never follow pagination URLs or redirects supplied by an API response.
    const url = `${API}${path}?per_page=100&page=${page}`;
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    ensure(response.status === 200, `GitHub API request failed with status ${response.status}.`);
    const values = JSON.parse(utf8(await readLimited(response, API_BYTES)));
    ensure(Array.isArray(values) && values.length <= 100, 'Invalid paginated GitHub response.');
    results.push(...values);
    ensure(results.length <= 1000, 'Pagination limit reached; refusing to publish a truncated manifest.');
    if (values.length < 100) return results;
  }
  throw new TypeError('Pagination limit reached; refusing to publish a truncated manifest.');
}

async function readAsset(asset, maximum, fetchImpl) {
  let url = asset.browser_download_url;
  const seen = new Set();
  for (let redirect = 0; redirect <= 3; redirect++) {
    ensure(!seen.has(url), 'Asset redirect loop.');
    seen.add(url);
    // These are public assets. Do not send the GitHub API token to CDN hosts.
    const response = await fetchImpl(url, { headers: { Accept: 'application/octet-stream' },
      redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(30_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      ensure(!!location, 'Missing asset redirect location.');
      const target = new URL(location);
      ensure(target.protocol === 'https:' && !target.username && !target.password && !target.port && !target.hash
        && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname), 'Untrusted asset redirect.');
      url = target.href;
      continue;
    }
    ensure(response.status === 200, `Public asset request failed with status ${response.status}.`);
    const bytes = await readLimited(response, maximum);
    ensure(bytes.length === asset.size, 'Asset response size does not match GitHub metadata.');
    return utf8(bytes);
  }
  throw new TypeError('Too many asset redirects.');
}

function validateAsset(asset, tag) {
  ensure(asset && typeof asset === 'object' && !Array.isArray(asset), 'Invalid release asset.');
  ensure(positiveInteger(asset.id), 'Invalid asset ID.');
  ensure(typeof asset.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(asset.name), 'Invalid asset filename.');
  ensure(asset.state === 'uploaded' && positiveInteger(asset.size), 'Incomplete or invalid asset.');
  ensure(asset.browser_download_url === assetUrl(tag, asset.name), 'Invalid asset download URL.');
  ensure(asset.digest === null || asset.digest === undefined || /^sha256:[a-f0-9]{64}$/.test(asset.digest), 'Invalid asset digest.');
  return asset;
}

async function eligibleDownload(release, options) {
  const assets = await listPages(`/releases/${release.id}/assets`, options);
  const names = new Set(), ids = new Set();
  for (const raw of assets) {
    const asset = validateAsset(raw, release.tag_name);
    ensure(!names.has(asset.name) && !ids.has(asset.id), 'Duplicate release asset.');
    names.add(asset.name); ids.add(asset.id);
  }
  const version = release.tag_name.slice(1), fileName = assetName(version);
  const installer = assets.find(a => a.name === fileName);
  const checksum = assets.find(a => a.name === `${fileName}.sha256`);
  const metadata = assets.find(a => a.name === `Voicewoven-${version}-release.json`);
  if (!installer || !checksum || !metadata) return null;
  ensure(checksum.size <= 512 && metadata.size <= 16_384, 'Release metadata asset exceeds its size limit.');
  const checksumText = await readAsset(checksum, 512, options.fetchImpl);
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)\n?$/.exec(checksumText);
  ensure(match && match[2] === fileName, 'Invalid SHA-256 file or installer filename.');
  const record = validateReleaseRecord(JSON.parse(await readAsset(metadata, 16_384, options.fetchImpl)), version);
  ensure(record.size === installer.size && record.sha256 === match[1], 'Installer size or checksum does not match its release record.');
  ensure(!installer.digest || installer.digest === `sha256:${record.sha256}`, 'GitHub installer digest does not match its release record.');
  if (!release.prerelease && (!record.notarized || record.signing !== 'developer-id')) return null;
  return { fileName, url: installer.browser_download_url, size: record.size, sha256: record.sha256,
    architecture: record.architecture, minimumMacOS: record.minimumMacOS, build: record.build,
    notarized: record.notarized, signing: record.signing };
}

export async function generateManifest({ fetchImpl = fetch, token } = {}) {
  const options = { fetchImpl, token };
  const rows = await listPages('/releases', options);
  const releases = [], ids = new Set(), tags = new Set();
  for (const row of rows) {
    ensure(row && typeof row === 'object' && !Array.isArray(row) && typeof row.draft === 'boolean', 'Invalid GitHub release.');
    ensure(positiveInteger(row.id) && !ids.has(row.id), 'Invalid or duplicate release ID.');
    ids.add(row.id);
    if (row.draft) continue;
    ensure(typeof row.tag_name === 'string' && row.tag_name.startsWith('v'), 'Release tag must begin with v.');
    const version = row.tag_name.slice(1);
    parseVersion(version);
    ensure(!tags.has(row.tag_name), 'Duplicate release tag.'); tags.add(row.tag_name);
    const release = { version, tag: row.tag_name, publishedAt: row.published_at, name: row.name ?? row.tag_name,
      notes: row.body ?? '', prerelease: row.prerelease, htmlUrl: row.html_url, download: null };
    // Validate the release before following any asset references.
    validateManifest({ ...EMPTY_MANIFEST, releases: [release] });
    if (!release.name.startsWith('[WITHDRAWN]')) release.download = await eligibleDownload(row, options);
    releases.push(release);
  }
  releases.sort((a, b) => compareVersions(b.version, a.version));
  return validateManifest({ schemaVersion: 1, repository: REPOSITORY,
    latest: releases.find(r => !r.prerelease && r.download) ?? null,
    latestPreview: releases.find(r => r.prerelease && r.download) ?? null, releases });
}

export async function synchronize({ path, fetchImpl = fetch, token } = {}) {
  // Complete every fetch and validation before touching the previous manifest.
  const manifest = await generateManifest({ fetchImpl, token });
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  ensure(Buffer.byteLength(bytes) <= MAX_MANIFEST_BYTES, 'Serialized manifest exceeds 2 MiB.');
  try {
    const info = await lstat(path);
    ensure(info.isFile() && !info.isSymbolicLink(), 'Manifest output must be a regular file.');
    if (await readFile(path, 'utf8') === bytes) return { changed: false, manifest };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o644);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return { changed: true, manifest };
}
