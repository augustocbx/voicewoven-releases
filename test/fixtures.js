export const repository = 'augustocbx/voicewoven-releases';
export const sha256 = 'a'.repeat(64);
export function release(version = '1.0.0', extra = {}) {
  const prerelease = version.includes('-');
  return {
    version, tag: `v${version}`, publishedAt: '2026-10-09T12:00:00Z', name: `Voicewoven ${version}`,
    notes: 'Release notes.', prerelease,
    htmlUrl: `https://github.com/${repository}/releases/tag/v${version}`,
    download: {
      fileName: `Voicewoven-${version}-arm64.dmg`,
      url: `https://github.com/${repository}/releases/download/v${version}/Voicewoven-${version}-arm64.dmg`,
      size: 123456, sha256, architecture: 'arm64', minimumMacOS: '14.0', build: '20261009.120000',
      notarized: !prerelease, signing: prerelease ? 'ad-hoc' : 'developer-id',
    }, ...extra,
  };
}
export function manifest(releases = [release()]) {
  return { schemaVersion: 1, repository, latest: releases.find(r => !r.prerelease && r.download) ?? null,
    latestPreview: releases.find(r => r.prerelease && r.download) ?? null, releases };
}
export function record(version = '1.0.0', extra = {}) {
  const { url, ...download } = release(version).download;
  return { schemaVersion: 1, version, ...download, ...extra };
}
export function apiRelease(version = '1.0.0', id = 10, extra = {}) {
  const r = release(version);
  return { id, tag_name: r.tag, name: r.name, published_at: r.publishedAt, body: r.notes,
    html_url: r.htmlUrl, draft: false, prerelease: r.prerelease, ...extra };
}
export function assets(version = '1.0.0', firstId = 100) {
  const names = [`Voicewoven-${version}-arm64.dmg`, `Voicewoven-${version}-arm64.dmg.sha256`, `Voicewoven-${version}-release.json`];
  const values = [null, `${sha256}  ${names[0]}\n`, JSON.stringify(record(version))];
  return names.map((name, index) => ({
    id: firstId + index, name, state: 'uploaded', size: index ? Buffer.byteLength(values[index]) : 123456,
    browser_download_url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
    digest: index ? null : `sha256:${sha256}`, value: values[index],
  }));
}
