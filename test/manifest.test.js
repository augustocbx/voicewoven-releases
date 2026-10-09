import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, validateReleaseRecord, compareVersions } from '../lib/manifest.js';
import { release, manifest, record } from './fixtures.js';

test('validates stable and preview downloads without promoting preview to stable', () => {
  const preview = release('2.0.0-preview.1');
  const stable = release('1.9.0');
  const result = validateManifest(manifest([preview, stable]));
  assert.equal(result.latest.version, '1.9.0');
  assert.equal(result.latestPreview.version, '2.0.0-preview.1');
  assert.equal(validateManifest(manifest([])).latest, null);
  assert.equal(validateManifest(manifest([preview])).latest, null);
});

test('preserves untrusted notes as plain strings without interpreting markup', () => {
  const notes = '<script>fetch("https://evil.test")</script>\n[link](javascript:alert(1))';
  assert.equal(validateManifest(manifest([release('1.0.0', { notes })])).releases[0].notes, notes);
  assert.throws(() => validateManifest(manifest([release('1.0.0', { notes: { html: notes } })])));
});

for (const [name, mutate] of [
  ['wrong repository', m => { m.repository = 'attacker/releases'; }],
  ['invalid calendar date', m => { m.releases[0].publishedAt = '2026-02-30T12:00:00Z'; }],
  ['date without UTC', m => { m.releases[0].publishedAt = '2026-10-09'; }],
  ['unsafe release URL', m => { m.releases[0].htmlUrl = 'javascript:alert(1)'; }],
  ['foreign download host', m => { m.releases[0].download.url = m.releases[0].download.url.replace('github.com', 'github.com.evil.test'); }],
  ['foreign download repository', m => { m.releases[0].download.url = m.releases[0].download.url.replace('augustocbx', 'attacker'); }],
  ['URL credentials', m => { m.releases[0].download.url = m.releases[0].download.url.replace('https://', 'https://user@'); }],
  ['URL query', m => { m.releases[0].download.url += '?download=evil'; }],
  ['URL fragment', m => { m.releases[0].download.url += '#other'; }],
  ['filename mismatch', m => { m.releases[0].download.fileName = '../installer.dmg'; }],
  ['digest malformed', m => { m.releases[0].download.sha256 = 'not-a-digest'; }],
  ['size zero', m => { m.releases[0].download.size = 0; }],
  ['size fractional', m => { m.releases[0].download.size = 1.5; }],
  ['size overflow', m => { m.releases[0].download.size = Number.MAX_SAFE_INTEGER + 1; }],
  ['wrong architecture', m => { m.releases[0].download.architecture = 'x86_64'; }],
  ['wrong macOS floor', m => { m.releases[0].download.minimumMacOS = '13.0'; }],
  ['invalid build calendar', m => { m.releases[0].download.build = '20260230.120000'; }],
  ['invalid build time', m => { m.releases[0].download.build = '20261009.250000'; }],
  ['stable ad hoc download', m => { m.releases[0].download.signing = 'ad-hoc'; m.releases[0].download.notarized = false; }],
  ['false notarized ad hoc', m => { m.releases[0].download.signing = 'ad-hoc'; }],
  ['stable not notarized', m => { m.releases[0].download.notarized = false; }],
  ['channel mismatch', m => { m.releases[0].prerelease = true; }],
  ['tag mismatch', m => { m.releases[0].tag = 'v9.0.0'; }],
  ['duplicate tag', m => { m.releases.push(structuredClone(m.releases[0])); }],
  ['forged latest pointer', m => { m.latest = release('2.0.0'); }],
  ['hidden eligible latest', m => { m.latest = null; }],
  ['unknown field', m => { m.releases[0].download.token = 'secret'; }],
]) test(`rejects ${name}`, () => {
  const m = structuredClone(manifest());
  mutate(m);
  assert.throws(() => validateManifest(m), TypeError);
});

for (const version of ['01.0.0', '1.0', '1.0.0+private', '1.0.0-01', '1.0.0-', '../1.0.0', '1.0.0-alpha..1']) {
  test(`rejects malformed or unsupported SemVer ${version}`, () => assert.throws(() => validateManifest(manifest([release(version)]))));
}

test('SemVer precedence is numeric and stable outranks its prerelease', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.10') > 0);
  assert.ok(compareVersions('1.0.0-rc.10', '1.0.0-rc.2') > 0);
  assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  const low = release('1.9.0'), high = release('1.10.0');
  assert.throws(() => validateManifest(manifest([low, high])));
});

test('unavailable releases remain in history but are never latest downloads', () => {
  const m = manifest([release('2.0.0', { download: null }), release('1.0.0')]);
  assert.equal(validateManifest(m).latest.version, '1.0.0');
  assert.equal(validateManifest(m).releases[0].download, null);
});

test('release records bind version, filename, build and signing data exactly', () => {
  assert.equal(validateReleaseRecord(record(), '1.0.0').fileName, 'Voicewoven-1.0.0-arm64.dmg');
  assert.throws(() => validateReleaseRecord(record(), '2.0.0'));
  assert.throws(() => validateReleaseRecord(record('1.0.0', { schemaVersion: 2 }), '1.0.0'));
});
