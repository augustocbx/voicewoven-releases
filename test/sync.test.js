import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, generateManifest, synchronize } from '../lib/sync.js';
import { apiRelease, assets, record, repository, sha256, signature, updater, updaterAssets } from './fixtures.js';

const api = `https://api.github.com/repos/${repository}`;
function network(releases = [apiRelease()], transform = () => {}) {
  const routes = new Map();
  const calls = [];
  routes.set(`${api}/releases?per_page=100&page=1`, new Response(JSON.stringify(releases)));
  for (const r of releases) {
    const items = assets(r.tag_name.slice(1), r.id * 100);
    routes.set(`${api}/releases/${r.id}/assets?per_page=100&page=1`, new Response(JSON.stringify(items.map(({ value, ...asset }) => asset))));
    for (const item of items) if (item.value !== null) routes.set(item.browser_download_url, new Response(item.value));
  }
  transform(routes);
  return { calls, routes, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (!routes.has(url)) throw new Error(`Unexpected URL: ${url}`);
    const response = routes.get(url);
    if (response instanceof Error) throw response;
    return response;
  } };
}
async function withFile(run) {
  const directory = await mkdtemp(join(tmpdir(), 'voicewoven-manifest-'));
  try { await run(join(directory, 'releases.json'), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('generates exact download data from three matching published assets', async () => {
  const remote = network();
  const result = await generateManifest({ fetchImpl: remote.fetchImpl, token: 'fixture-secret' });
  assert.equal(result.latest.download.sha256, sha256);
  assert.equal(result.latest.download.size, 123456);
  assert.equal(result.latest.download.build, '20261009.120000');
  assert.equal(result.latest.download.url, `https://github.com/${repository}/releases/download/v1.0.0/Voicewoven-1.0.0-arm64.dmg`);
  assert.equal(result.latestPreview, null);
  assert.equal(remote.calls.filter(c => !c.url.startsWith('https://api.github.com')).length, 2);
  for (const call of remote.calls.filter(c => !c.url.startsWith('https://api.github.com'))) {
    assert.equal(call.options.headers.Authorization, undefined);
    assert.equal(call.options.redirect, 'manual');
  }
});

test('selects latest by semantic version, not publication time or API order', async () => {
  const remote = network([apiRelease('1.9.0', 1), apiRelease('2.0.0-preview.10', 2), apiRelease('1.10.0', 3), apiRelease('2.0.0-preview.2', 4)]);
  const result = await generateManifest({ fetchImpl: remote.fetchImpl });
  assert.equal(result.latest.version, '1.10.0');
  assert.equal(result.latestPreview.version, '2.0.0-preview.10');
  assert.deepEqual(result.releases.map(r => r.version), ['2.0.0-preview.10', '2.0.0-preview.2', '1.10.0', '1.9.0']);
});

test('withdrawn releases retain history but cannot remain current downloads', async () => {
  const remote = network([apiRelease('2.0.0', 1, { name: '[WITHDRAWN] Voicewoven 2.0.0' }), apiRelease('1.0.0', 2)]);
  const result = await generateManifest({ fetchImpl: remote.fetchImpl });
  assert.equal(result.releases[0].download, null);
  assert.equal(result.latest.version, '1.0.0');
  assert.equal(remote.calls.some(c => c.url.includes('/releases/1/assets')), false);
});

test('paginates releases using only fixed GitHub URLs even with an injected Link header', async () => {
  const first = Array.from({ length: 100 }, (_, n) => apiRelease(`1.0.${n}`, n + 1, { draft: true }));
  const remote = network([apiRelease('1.1.0', 101)], routes => {
    routes.set(`${api}/releases?per_page=100&page=1`, new Response(JSON.stringify(first), { headers: { Link: '<https://evil.test/leak>; rel="next"' } }));
    routes.set(`${api}/releases?per_page=100&page=2`, new Response(JSON.stringify([apiRelease('1.1.0', 101)])));
  });
  const result = await generateManifest({ fetchImpl: remote.fetchImpl });
  assert.equal(result.latest.version, '1.1.0');
  assert.equal(result.releases.length, 1);
  assert.equal(remote.calls.some(c => c.url.includes('evil.test')), false);
});

test('paginates release assets rather than trusting embedded or truncated asset data', async () => {
  const remote = network();
  const fillers = Array.from({ length: 100 }, (_, i) => ({ id: 2000 + i, name: `extra-${i}.txt`, state: 'uploaded', size: 1, digest: null,
    browser_download_url: `https://github.com/${repository}/releases/download/v1.0.0/extra-${i}.txt` }));
  const original = remote.routes.get(`${api}/releases/10/assets?per_page=100&page=1`);
  remote.routes.set(`${api}/releases/10/assets?per_page=100&page=1`, new Response(JSON.stringify(fillers)));
  remote.routes.set(`${api}/releases/10/assets?per_page=100&page=2`, original);
  assert.equal((await generateManifest({ fetchImpl: remote.fetchImpl })).latest.version, '1.0.0');
});

test('excludes drafts and retains incomplete releases as unavailable history', async () => {
  const remote = network([apiRelease('9.0.0', 1, { draft: true }), apiRelease('2.0.0', 2), apiRelease('1.0.0', 3)]);
  remote.routes.set(`${api}/releases/2/assets?per_page=100&page=1`, new Response('[]'));
  const result = await generateManifest({ fetchImpl: remote.fetchImpl });
  assert.deepEqual(result.releases.map(r => r.version), ['2.0.0', '1.0.0']);
  assert.equal(result.releases[0].download, null);
  assert.equal(result.latest.version, '1.0.0');
  assert.equal(remote.calls.some(c => c.url.includes('/releases/1/assets')), false);
});

test('an ad hoc stable release stays unavailable while a matching preview is downloadable', async () => {
  const remote = network([apiRelease('1.0.0', 10), apiRelease('1.1.0-preview.1', 11)]);
  const items = assets();
  items[2].value = JSON.stringify(record('1.0.0', { notarized: false, signing: 'ad-hoc' }));
  items[2].size = Buffer.byteLength(items[2].value);
  remote.routes.set(`${api}/releases/10/assets?per_page=100&page=1`, new Response(JSON.stringify(items.map(({ value, ...a }) => a))));
  remote.routes.set(items[2].browser_download_url, new Response(items[2].value));
  const result = await generateManifest({ fetchImpl: remote.fetchImpl });
  assert.equal(result.latest, null);
  assert.equal(result.latestPreview.version, '1.1.0-preview.1');
});

test('validates redirects before downloading public metadata and never forwards the token', async () => {
  const remote = network();
  const item = assets()[2];
  remote.routes.set(item.browser_download_url, new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/github-production-release-asset/1/record?signature=example' } }));
  remote.routes.set('https://release-assets.githubusercontent.com/github-production-release-asset/1/record?signature=example', new Response(item.value));
  assert.equal((await generateManifest({ fetchImpl: remote.fetchImpl, token: 'fixture-secret' })).latest.version, '1.0.0');
  assert.equal(remote.calls.at(-1).options.headers.Authorization, undefined);
});

const invalidCases = [
 ['network failure', r => r.routes.set(`${api}/releases?per_page=100&page=1`, new Error('Network unavailable'))],
 ['rate limited API', r => r.routes.set(`${api}/releases?per_page=100&page=1`, new Response('{}', { status: 403 }))],
 ['API redirect', r => r.routes.set(`${api}/releases?per_page=100&page=1`, new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }))],
 ['invalid JSON', r => r.routes.set(`${api}/releases?per_page=100&page=1`, new Response('{'))],
 ['non-array JSON', r => r.routes.set(`${api}/releases?per_page=100&page=1`, new Response('{}'))],
 ['duplicate release', r => r.routes.set(`${api}/releases?per_page=100&page=1`, new Response(JSON.stringify([apiRelease(), apiRelease()])))],
 ['channel mismatch', r => r.routes.set(`${api}/releases?per_page=100&page=1`, new Response(JSON.stringify([apiRelease('1.0.0', 10, { prerelease: true })])))],
 ['checksum mismatch', r => r.routes.set(assets()[1].browser_download_url, new Response(`${'b'.repeat(64)}  Voicewoven-1.0.0-arm64.dmg\n`))],
 ['checksum wrong filename', r => r.routes.set(assets()[1].browser_download_url, new Response(`${sha256}  Voicewoven-9.0.0-arm64.dmg\n`))],
 ['checksum extra lines', r => r.routes.set(assets()[1].browser_download_url, new Response(`${assets()[1].value}${assets()[1].value}`))],
 ['metadata oversize', r => r.routes.set(assets()[2].browser_download_url, new Response('x'.repeat(20_000)))],
 ['untrusted asset redirect', r => r.routes.set(assets()[2].browser_download_url, new Response(null, { status: 302, headers: { Location: 'https://evil.test/metadata' } }))],
 ['redirect credentials', r => r.routes.set(assets()[2].browser_download_url, new Response(null, { status: 302, headers: { Location: 'https://user@release-assets.githubusercontent.com/a' } }))],
 ['redirect loop', r => r.routes.set(assets()[2].browser_download_url, new Response(null, { status: 302, headers: { Location: assets()[2].browser_download_url } }))],
];
for (const [name, transform] of invalidCases) test(`${name} preserves the last valid manifest byte-for-byte`, async () => {
 await withFile(async (path, directory) => {
   const good = network();
   await synchronize({ path, fetchImpl: good.fetchImpl });
   const before = await readFile(path);
   const modified = (await stat(path)).mtimeMs;
   const broken = network(); transform(broken);
   await assert.rejects(synchronize({ path, fetchImpl: broken.fetchImpl }));
   assert.deepEqual(await readFile(path), before);
   assert.equal((await stat(path)).mtimeMs, modified);
   assert.deepEqual(await readdir(directory), ['releases.json']);
   assert.equal(broken.calls.some(c => c.url.includes('evil.test')), false);
 });
});

for (const [name, mutate] of [
 ['duplicate asset', a => a.push(structuredClone(a[0]))],
 ['asset URL path mismatch', a => { a[0].browser_download_url += '?token=bad'; }],
 ['asset digest mismatch', a => { a[0].digest = `sha256:${'b'.repeat(64)}`; }],
 ['asset size mismatch', a => { a[0].size += 1; }],
 ['asset size invalid', a => { a[0].size = -1; }],
 ['metadata version mismatch', a => { a[2].value = JSON.stringify(record('2.0.0')); a[2].size = Buffer.byteLength(a[2].value); }],
]) test(`rejects ${name}`, async () => {
 const remote = network();
 const items = assets(); mutate(items);
 remote.routes.set(`${api}/releases/10/assets?per_page=100&page=1`, new Response(JSON.stringify(items.map(({ value, ...a }) => a))));
 for (const item of items) if (item.value !== null) remote.routes.set(item.browser_download_url, new Response(item.value));
 await assert.rejects(generateManifest({ fetchImpl: remote.fetchImpl }));
});

test('unchanged data avoids writes; edited notes update; successful empty response removes deleted releases', async () => {
 await withFile(async path => {
   const first = await synchronize({ path, fetchImpl: network().fetchImpl });
   assert.equal(first.changed, true);
   const modified = (await stat(path)).mtimeMs;
   assert.equal((await synchronize({ path, fetchImpl: network().fetchImpl })).changed, false);
   assert.equal((await stat(path)).mtimeMs, modified);
   const edited = network([apiRelease('1.0.0', 10, { body: 'Edited release notes.' })]);
   assert.equal((await synchronize({ path, fetchImpl: edited.fetchImpl })).changed, true);
   assert.equal(JSON.parse(await readFile(path)).latest.notes, 'Edited release notes.');
   assert.equal((await synchronize({ path, fetchImpl: network([]).fetchImpl })).changed, true);
   assert.deepEqual(JSON.parse(await readFile(path)), { schemaVersion: 1, repository, latest: null, latestPreview: null, releases: [] });
 });
});

test('refuses serialized manifests above the website size limit and preserves the previous file', async () => {
  await withFile(async path => {
    await synchronize({ path, fetchImpl: network().fetchImpl });
    const before = await readFile(path);
    const rows = Array.from({ length: 100 }, (_, i) => apiRelease(`1.0.${100 - i}`, i + 1, { name: 'n'.repeat(100), body: 'n'.repeat(20_000) }));
    const remote = network(rows);
    remote.routes.set(`${api}/releases?per_page=100&page=2`, new Response('[]'));
    await assert.rejects(synchronize({ path, fetchImpl: remote.fetchImpl }), /2 MiB/);
    assert.deepEqual(await readFile(path), before);
  });
});

test('a failed later page cannot erase the previous complete history', async () => {
  await withFile(async path => {
    await synchronize({ path, fetchImpl: network().fetchImpl });
    const before = await readFile(path);
    const rows = Array.from({ length: 100 }, (_, i) => apiRelease(`1.0.${i}`, i + 1, { draft: true }));
    const remote = network(rows);
    remote.routes.set(`${api}/releases?per_page=100&page=2`, new Response('{}', { status: 502 }));
    await assert.rejects(synchronize({ path, fetchImpl: remote.fetchImpl }));
    assert.deepEqual(await readFile(path), before);
  });
});

test('the full documented 1000-item page limit permits a terminal empty page', async () => {
  const routes = new Map();
  for (let page = 1; page <= 10; page++) {
    routes.set(`${api}/releases?per_page=100&page=${page}`, new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => apiRelease(`1.${page}.${i}`, (page - 1) * 100 + i + 1, { draft: true })))));
  }
  routes.set(`${api}/releases?per_page=100&page=11`, new Response('[]'));
  const result = await generateManifest({ fetchImpl: async url => {
    assert.ok(routes.has(url));
    return routes.get(url);
  } });
  assert.deepEqual(result.releases, []);
});

test('refuses to publish a truncated response above the page limit', async () => {
  let calls = 0;
  await assert.rejects(generateManifest({ fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => apiRelease(`1.${calls}.${i}`, calls * 100 + i, { draft: true }))));
  } }), /Pagination limit/);
  assert.ok(calls <= 11);
});

// Gives a fixture release the two updater assets (and a Developer ID record, which previews lack by default).
function withUpdater(remote, version, id, { text = signature, omit = [], signing = 'developer-id' } = {}) {
  const items = assets(version, id * 100);
  items[2].value = JSON.stringify(record(version, { signing }));
  items[2].size = Buffer.byteLength(items[2].value);
  items.push(...updaterAssets(version, id * 100 + 3, text).filter(a => !omit.some(suffix => a.name.endsWith(suffix))));
  remote.routes.set(`${api}/releases/${id}/assets?per_page=100&page=1`, new Response(JSON.stringify(items.map(({ value, ...a }) => a))));
  for (const item of items) if (item.value !== null) remote.routes.set(item.browser_download_url, new Response(item.value));
  return remote;
}
const versions = result => [result.updaters.stable?.version, result.updaters.preview?.version];

test('a Developer ID release with both updater assets produces the Tauri updater data and never downloads the archive', async () => {
  const remote = withUpdater(network(), '1.0.0', 10);
  const result = await generate({ fetchImpl: remote.fetchImpl });
  assert.deepEqual(result.updaters, { stable: updater('1.0.0'), preview: updater('1.0.0') });
  assert.equal(remote.calls.some(c => c.url.endsWith('.app.tar.gz')), false);
});

test('releases without updater assets keep their manifest and produce no updater data or file', async () => {
  await withFile(async (path, directory) => {
    const result = await generate({ fetchImpl: network([apiRelease('1.0.0', 10), apiRelease('1.1.0-preview.1', 11)]).fetchImpl });
    assert.deepEqual(result.updaters, { stable: null, preview: null });
    assert.equal(result.manifest.latest.version, '1.0.0');
    await synchronize({ path, fetchImpl: network().fetchImpl });
    assert.deepEqual(await readdir(directory), ['releases.json']);
  });
});

test('a withdrawn release is skipped and the updater files point at the previous good release', async () => {
  const remote = network([apiRelease('2.0.0', 1, { name: '[WITHDRAWN] Voicewoven 2.0.0' }), apiRelease('1.0.0', 2)]);
  withUpdater(withUpdater(remote, '2.0.0', 1), '1.0.0', 2);
  const result = await generate({ fetchImpl: remote.fetchImpl });
  assert.deepEqual(versions(result), ['1.0.0', '1.0.0']);
  assert.equal(remote.calls.some(c => c.url.includes('/releases/1/assets') || c.url.includes('v2.0.0')), false);
});

test('the preview file takes the newer of the newest preview and the newest stable', async () => {
  const newerPreview = network([apiRelease('1.0.0', 1), apiRelease('1.1.0-preview.1', 2), apiRelease('0.9.0-preview.1', 3)]);
  for (const [version, id] of [['1.0.0', 1], ['1.1.0-preview.1', 2], ['0.9.0-preview.1', 3]]) withUpdater(newerPreview, version, id);
  assert.deepEqual(versions(await generate({ fetchImpl: newerPreview.fetchImpl })), ['1.0.0', '1.1.0-preview.1']);
  const newerStable = network([apiRelease('1.0.0', 1), apiRelease('0.9.0-preview.1', 3)]);
  for (const [version, id] of [['1.0.0', 1], ['0.9.0-preview.1', 3]]) withUpdater(newerStable, version, id);
  assert.deepEqual(versions(await generate({ fetchImpl: newerStable.fetchImpl })), ['1.0.0', '1.0.0']);
});

test('a preview never fills the stable file', async () => {
  const remote = withUpdater(network([apiRelease('1.0.0-preview.1', 1)]), '1.0.0-preview.1', 1);
  assert.deepEqual(versions(await generate({ fetchImpl: remote.fetchImpl })), [undefined, '1.0.0-preview.1']);
});

test('the newest release lacking updater assets is passed over for the newest one that has them', async () => {
  const remote = withUpdater(network([apiRelease('2.0.0', 1), apiRelease('1.0.0', 2)]), '1.0.0', 2);
  const result = await generate({ fetchImpl: remote.fetchImpl });
  assert.deepEqual(versions(result), ['1.0.0', '1.0.0']);
  assert.equal(result.manifest.latest.version, '2.0.0');
});

for (const [name, options] of [
  ['a missing archive', { omit: ['.app.tar.gz'] }],
  ['a missing signature file', { omit: ['.sig'] }],
  ['an ad hoc signed preview', { signing: 'ad-hoc' }],
  ['an oversized signature', { text: 'A'.repeat(4100) }],
  ['a signature that is not base64', { text: '<html>Not Found</html>' }],
  ['a signature with padding in the middle', { text: 'AAAA==AAAA==' }],
]) test(`${name} is skipped without failing the synchronization`, async () => {
  const remote = withUpdater(network([apiRelease('1.0.0-preview.1', 1)]), '1.0.0-preview.1', 1, options);
  const result = await generate({ fetchImpl: remote.fetchImpl });
  assert.deepEqual(result.updaters, { stable: null, preview: null });
  assert.equal(result.manifest.latestPreview.version, '1.0.0-preview.1');
});

test('an oversized signature is not downloaded', async () => {
  const remote = withUpdater(network([apiRelease('1.0.0', 1)]), '1.0.0', 1, { text: 'A'.repeat(4100) });
  await generate({ fetchImpl: remote.fetchImpl });
  assert.equal(remote.calls.some(c => c.url.endsWith('.sig')), false);
});

test('a signature file may end with one newline and is inlined without it', async () => {
  const remote = withUpdater(network(), '1.0.0', 10, { text: `${signature}\n` });
  assert.equal((await generate({ fetchImpl: remote.fetchImpl })).updaters.stable.platforms['darwin-aarch64'].signature, signature);
});

test('failing to read the signature fails the synchronization instead of dropping the channel', async () => {
  const remote = withUpdater(network(), '1.0.0', 10);
  remote.routes.set(updaterAssets('1.0.0')[1].browser_download_url, new Error('Network unavailable'));
  await assert.rejects(generate({ fetchImpl: remote.fetchImpl }));
});

test('updater files are written with releases.json, left alone when unchanged and removed when nothing qualifies', async () => {
  await withFile(async (path, directory) => {
    const stable = join(directory, 'updater', 'stable.json'), preview = join(directory, 'updater', 'preview.json');
    assert.equal((await synchronize({ path, fetchImpl: withUpdater(network(), '1.0.0', 10).fetchImpl })).changed, true);
    assert.deepEqual(JSON.parse(await readFile(stable)), updater('1.0.0'));
    assert.equal(await readFile(stable, 'utf8'), await readFile(preview, 'utf8'));
    assert.equal((await readFile(stable, 'utf8')).endsWith('}\n'), true);
    const modified = (await stat(stable)).mtimeMs;
    assert.equal((await synchronize({ path, fetchImpl: withUpdater(network(), '1.0.0', 10).fetchImpl })).changed, false);
    assert.equal((await stat(stable)).mtimeMs, modified);
    const withdrawn = withUpdater(network([apiRelease('1.0.0', 10, { name: '[WITHDRAWN] Voicewoven 1.0.0' })]), '1.0.0', 10);
    assert.equal((await synchronize({ path, fetchImpl: withdrawn.fetchImpl })).changed, true);
    assert.deepEqual(await readdir(join(directory, 'updater')), []);
  });
});

test('each updater file follows its own channel and is removed when that channel no longer qualifies', async () => {
  await withFile(async (path, directory) => {
    const files = async () => (await readdir(join(directory, 'updater'))).sort();
    const both = withUpdater(withUpdater(network([apiRelease('1.0.0', 1), apiRelease('1.1.0-preview.1', 2)]), '1.0.0', 1), '1.1.0-preview.1', 2);
    await synchronize({ path, fetchImpl: both.fetchImpl });
    assert.deepEqual(await files(), ['preview.json', 'stable.json']);
    await synchronize({ path, fetchImpl: withUpdater(network([apiRelease('1.1.0-preview.1', 2)]), '1.1.0-preview.1', 2).fetchImpl });
    assert.deepEqual(await files(), ['preview.json']);
    await synchronize({ path, fetchImpl: network([apiRelease('1.1.0-preview.1', 2)]).fetchImpl });
    assert.deepEqual(await files(), []);
  });
});
