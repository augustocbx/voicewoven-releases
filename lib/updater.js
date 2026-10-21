/** Tauri updater files (updater/stable.json, updater/preview.json). Kept apart from manifest.js, whose copy the website vendors. */
import { assetUrl, parseVersion } from './manifest.js';

export const MAX_SIGNATURE_BYTES = 4096;
const PLATFORM = 'darwin-aarch64';
function ensure(condition, message) { if (!condition) throw new TypeError(message); }
function plain(value, keys, label) {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === keys, `Unexpected ${label} fields.`);
}

export function updaterName(version) { parseVersion(version); return `Voicewoven-${version}-arm64.app.tar.gz`; }
// The text of a Tauri .sig file: standard padded base64.
export function validSignature(text) {
  return typeof text === 'string' && text.length <= MAX_SIGNATURE_BYTES && text.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}
export function updaterFile(release, signature) {
  return { version: release.version, pub_date: release.publishedAt,
    platforms: { [PLATFORM]: { signature, url: assetUrl(release.tag, updaterName(release.version)) } } };
}
export function validateUpdater(value, manifest, channel) {
  plain(value, 'platforms,pub_date,version', 'updater');
  const release = manifest.releases.find(r => r.version === value.version);
  ensure(release?.download?.signing === 'developer-id' && release.download.notarized === true, 'Updater release is not an eligible notarized Developer ID release.');
  ensure(channel === 'preview' || !release.prerelease, 'The stable updater file cannot name a preview.');
  plain(value.platforms, PLATFORM, 'updater platforms');
  const { signature, url } = value.platforms[PLATFORM];
  plain(value.platforms[PLATFORM], 'signature,url', 'updater platform');
  ensure(value.pub_date === release.publishedAt, 'Updater date does not match the release.');
  ensure(url === assetUrl(release.tag, updaterName(release.version)), 'Invalid updater URL.');
  ensure(validSignature(signature), 'Invalid updater signature.');
  return value;
}
