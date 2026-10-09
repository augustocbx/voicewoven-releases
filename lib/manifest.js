/** Public, browser-safe release contract. Keep the website's vendored copy identical. */
export const REPOSITORY = 'augustocbx/voicewoven-releases';
export const CANONICAL_MANIFEST_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main/releases.json`;
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const EMPTY_MANIFEST = Object.freeze({ schemaVersion: 1, repository: REPOSITORY, latest: null, latestPreview: null, releases: Object.freeze([]) });

function requireValue(condition, message) {
  if (!condition) throw new TypeError(message);
}
function object(value, keys, label) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}.`);
  const actual = Object.keys(value).sort();
  requireValue(actual.length === keys.length && actual.every((key, i) => key === [...keys].sort()[i]), `Unexpected ${label} fields.`);
}
function text(value, limit, label, allowEmpty = false) {
  requireValue(typeof value === 'string' && value.length <= limit && (allowEmpty || value.trim().length > 0), `Invalid ${label}.`);
  requireValue(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), `Invalid ${label} control characters.`);
  return value;
}
export function parseVersion(version) {
  text(version, 80, 'version');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  requireValue(!!match, 'Version must be SemVer without build metadata.');
  const prerelease = match[4]?.split('.') ?? [];
  requireValue(prerelease.every(part => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0')), 'Numeric prerelease identifiers cannot have leading zeros.');
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  if (!x.prerelease.length || !y.prerelease.length) return Number(!x.prerelease.length) - Number(!y.prerelease.length);
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i], q = y.prerelease[i];
    if (p === q) continue;
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return BigInt(p) > BigInt(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}
function date(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value), 'Invalid UTC publication date.');
  const parsed = new Date(value);
  requireValue(Number.isFinite(parsed.getTime()) && parsed.toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z')), 'Invalid calendar date.');
  return value;
}
function build(value) {
  requireValue(typeof value === 'string' && /^\d{8}\.\d{6}$/.test(value), 'Invalid build ID.');
  date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`);
  return value;
}
export function assetName(version) { parseVersion(version); return `Voicewoven-${version}-arm64.dmg`; }
export function assetUrl(tag, name) { return `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`; }
function downloadFields(value, version) {
  requireValue(value.fileName === assetName(version), 'Installer filename does not match the release.');
  requireValue(Number.isSafeInteger(value.size) && value.size > 0, 'Invalid installer size.');
  requireValue(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), 'Invalid SHA-256 digest.');
  requireValue(value.architecture === 'arm64' && value.minimumMacOS === '14.0', 'Unsupported installer platform.');
  requireValue(['ad-hoc', 'developer-id'].includes(value.signing) && typeof value.notarized === 'boolean', 'Invalid signing metadata.');
  requireValue(!value.notarized || value.signing === 'developer-id', 'An ad hoc installer cannot be notarized.');
  return { fileName: value.fileName, size: value.size, sha256: value.sha256, architecture: value.architecture,
    minimumMacOS: value.minimumMacOS, build: build(value.build), notarized: value.notarized, signing: value.signing };
}
const DOWNLOAD_FIELDS = ['fileName', 'size', 'sha256', 'architecture', 'minimumMacOS', 'build', 'notarized', 'signing'];
export function validateReleaseRecord(value, version) {
  parseVersion(version);
  object(value, ['schemaVersion', 'version', ...DOWNLOAD_FIELDS], 'release record');
  requireValue(value.schemaVersion === 1 && value.version === version, 'Release record version mismatch.');
  return { schemaVersion: 1, version, ...downloadFields(value, version) };
}
function validateRelease(value) {
  object(value, ['version', 'tag', 'publishedAt', 'name', 'notes', 'prerelease', 'htmlUrl', 'download'], 'release');
  const { prerelease } = parseVersion(value.version);
  requireValue(value.tag === `v${value.version}`, 'Tag does not match version.');
  requireValue(typeof value.prerelease === 'boolean' && value.prerelease === (prerelease.length > 0), 'Release channel does not match SemVer.');
  requireValue(value.htmlUrl === `https://github.com/${REPOSITORY}/releases/tag/${value.tag}`, 'Invalid release URL.');
  let download = null;
  if (value.download !== null) {
    requireValue(typeof value.name === 'string' && !value.name.startsWith('[WITHDRAWN]'), 'Withdrawn releases cannot have eligible downloads.');
    object(value.download, ['url', ...DOWNLOAD_FIELDS], 'download');
    const fields = downloadFields(value.download, value.version);
    requireValue(value.download.url === assetUrl(value.tag, fields.fileName), 'Invalid installer URL.');
    requireValue(value.prerelease || (fields.signing === 'developer-id' && fields.notarized), 'Stable downloads require notarized Developer ID signing.');
    download = { fileName: fields.fileName, url: value.download.url, size: fields.size, sha256: fields.sha256,
      architecture: fields.architecture, minimumMacOS: fields.minimumMacOS, build: fields.build,
      notarized: fields.notarized, signing: fields.signing };
  }
  return { version: value.version, tag: value.tag, publishedAt: date(value.publishedAt), name: text(value.name, 200, 'release name'),
    notes: text(value.notes, 20_000, 'release notes', true), prerelease: value.prerelease, htmlUrl: value.htmlUrl, download };
}
export function validateManifest(value) {
  object(value, ['schemaVersion', 'repository', 'latest', 'latestPreview', 'releases'], 'manifest');
  requireValue(value.schemaVersion === 1 && value.repository === REPOSITORY, 'Unsupported manifest schema or repository.');
  requireValue(new TextEncoder().encode(JSON.stringify(value)).length <= MAX_MANIFEST_BYTES, 'Manifest exceeds 2 MiB.');
  requireValue(Array.isArray(value.releases) && value.releases.length <= 1000, 'Invalid release history.');
  const releases = value.releases.map(validateRelease);
  const tags = new Set();
  for (const [index, release] of releases.entries()) {
    requireValue(!tags.has(release.tag), 'Duplicate release tag.');
    tags.add(release.tag);
    if (index) requireValue(compareVersions(releases[index - 1].version, release.version) > 0, 'Release history must be sorted by descending SemVer.');
  }
  const latest = releases.find(r => !r.prerelease && r.download) ?? null;
  const latestPreview = releases.find(r => r.prerelease && r.download) ?? null;
  for (const [key, expected] of [['latest', latest], ['latestPreview', latestPreview]]) {
    const actual = value[key] === null ? null : validateRelease(value[key]);
    requireValue(JSON.stringify(actual) === JSON.stringify(expected), `Invalid ${key} release pointer.`);
  }
  return { schemaVersion: 1, repository: REPOSITORY, latest, latestPreview, releases };
}
