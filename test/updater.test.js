import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUpdater } from '../lib/updater.js';
import { manifest, release, updater } from './fixtures.js';

const listed = manifest([release('1.0.0'), release('1.1.0-preview.1', { download: { ...release('1.1.0-preview.1').download, signing: 'developer-id' } })]);

test('accepts the generated shape for each channel', () => {
  assert.deepEqual(validateUpdater(updater('1.0.0'), listed, 'stable'), updater('1.0.0'));
  assert.deepEqual(validateUpdater(updater('1.1.0-preview.1'), listed, 'preview'), updater('1.1.0-preview.1'));
});

for (const [name, mutate, channel = 'stable'] of [
  ['unknown field', u => { u.extra = 1; }],
  ['missing field', u => { delete u.notes; }],
  ['unknown version', u => { u.version = '9.9.9'; }],
  ['notes that differ from the release', u => { u.notes = 'Other.'; }],
  ['publication date that differs from the release', u => { u.pub_date = '2026-10-10T12:00:00Z'; }],
  ['extra platform', u => { u.platforms['darwin-x86_64'] = u.platforms['darwin-aarch64']; }],
  ['wrong platform', u => { u.platforms = { 'darwin-x86_64': u.platforms['darwin-aarch64'] }; }],
  ['extra platform field', u => { u.platforms['darwin-aarch64'].size = 1; }],
  ['foreign host', u => { u.platforms['darwin-aarch64'].url = u.platforms['darwin-aarch64'].url.replace('github.com', 'github.com.evil.test'); }],
  ['foreign repository', u => { u.platforms['darwin-aarch64'].url = u.platforms['darwin-aarch64'].url.replace('augustocbx', 'attacker'); }],
  ['URL credentials', u => { u.platforms['darwin-aarch64'].url = u.platforms['darwin-aarch64'].url.replace('https://', 'https://user@'); }],
  ['URL query', u => { u.platforms['darwin-aarch64'].url += '?x=1'; }],
  ['another tag in the URL', u => { u.platforms['darwin-aarch64'].url = u.platforms['darwin-aarch64'].url.replace('/v1.0.0/', '/v0.9.0/'); }],
  ['the installer instead of the archive', u => { u.platforms['darwin-aarch64'].url = u.platforms['darwin-aarch64'].url.replace('.app.tar.gz', '.dmg'); }],
  ['signature that is not base64', u => { u.platforms['darwin-aarch64'].signature = '<html>'; }],
  ['oversized signature', u => { u.platforms['darwin-aarch64'].signature = 'A'.repeat(4100); }],
  ['signature that is not text', u => { u.platforms['darwin-aarch64'].signature = null; }],
]) test(`rejects ${name}`, () => {
  const value = updater('1.0.0');
  mutate(value);
  assert.throws(() => validateUpdater(value, listed, channel), TypeError);
});

test('rejects a preview in the stable file, data that is not an object, a release without a download and an ad hoc release', () => {
  assert.throws(() => validateUpdater(updater('1.1.0-preview.1'), listed, 'stable'), /stable/);
  for (const value of [null, [], 'text']) assert.throws(() => validateUpdater(value, listed, 'stable'), TypeError);
  const adHoc = manifest([release('1.1.0-preview.1')]);
  assert.throws(() => validateUpdater(updater('1.1.0-preview.1'), adHoc, 'preview'), /Developer ID/);
  const withdrawn = manifest([release('1.0.0', { name: '[WITHDRAWN] Voicewoven 1.0.0', download: null })]);
  assert.throws(() => validateUpdater(updater('1.0.0'), withdrawn, 'stable'), /Developer ID/);
});
