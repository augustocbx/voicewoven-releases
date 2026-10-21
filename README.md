# Voicewoven releases

Public installers and release metadata for [Voicewoven](https://voicewoven.app), the macOS meeting application. This repository contains distribution automation and release assets. It does not contain the private application source, recording data, models, credentials, or application Git history.

The website uses [`releases.json`](releases.json) for its download links and release history. A stable installer appears only after its metadata confirms Developer ID signing and notarization. Preview installers are listed separately and are never substituted for a stable download.

## Download channels

- **Stable:** a tag such as `v1.0.0`, GitHub's prerelease flag off, Developer ID signing, and successful notarization.
- **Preview:** a prerelease tag such as `v1.0.0-preview.1` and GitHub's prerelease flag on. Previews may use ad hoc signing and lack notarization; their metadata states this explicitly.
- **Unavailable:** published release notes can remain in history without an eligible installer. Missing assets or a stable release that has not passed its signing requirements do not create a download button.

An empty manifest means that no published release is currently listed. `latest: null` means no eligible stable installer exists, even if previews are available. The initial manifest intentionally contains no downloads.

## Publishing contract

The private release process builds and validates the installer before uploading exactly these three assets:

```text
Voicewoven-<version>-arm64.dmg
Voicewoven-<version>-arm64.dmg.sha256
Voicewoven-<version>-release.json
```

The version follows SemVer without a leading `v` or `+build` metadata in filenames. Tags add the `v` prefix. Versions and asset names must match exactly.

The checksum file contains one line with the lowercase SHA-256 digest, two spaces, and the exact installer filename. For example:

```text
<64 lowercase hexadecimal characters>  Voicewoven-1.0.0-arm64.dmg
```

The release record has exactly these fields:

```json
{
  "schemaVersion": 1,
  "version": "1.0.0-preview.1",
  "build": "20261009.120000",
  "architecture": "arm64",
  "minimumMacOS": "14.0",
  "fileName": "Voicewoven-1.0.0-preview.1-arm64.dmg",
  "size": 123456,
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "signing": "ad-hoc",
  "notarized": false
}
```

This is a schema example, not a downloadable artifact. Build IDs use a valid UTC calendar date and time in `YYYYMMDD.HHMMSS` format. Only Apple Silicon and macOS 14.0 or later are currently supported.

The generator binds the record to GitHub's installer size, the checksum file, and GitHub's SHA-256 asset digest when that digest is available. It does not download or execute the installer. Independent remote-byte verification, nested code signing, notarization, and mounted-bundle validation belong to the private publishing process; declaring metadata alone is not a substitute for those checks.

## Manifest contract

```text
{
  schemaVersion: 1,
  repository: "augustocbx/voicewoven-releases",
  latest: Release | null,
  latestPreview: Release | null,
  releases: Release[]
}

Release = {
  version, tag, publishedAt, name, notes, prerelease, htmlUrl,
  download: Download | null
}

Download = {
  fileName, url, size, sha256,
  architecture: "arm64", minimumMacOS: "14.0",
  build, notarized, signing: "ad-hoc" | "developer-id"
}
```

History is sorted by descending SemVer. The latest pointers are the highest eligible version in each channel, irrespective of the order or publication dates returned by GitHub. Draft releases are excluded.

To withdraw an unsafe release, prefix its title with `[WITHDRAWN]` and explain the reason in its notes. Its history entry remains, but its download is ineligible and the latest pointer falls back to another eligible version. Deleted releases disappear after a complete successful reconciliation.

`lib/manifest.js` is a dependency-free browser-compatible validator. The website vendors an identical copy for its browser renderer and build-time mirror. Keep those copies synchronized when changing the contract. The validator recomputes the expected latest pointers and rejects mismatches. Release notes remain untrusted plain text, including any Markdown or HTML they contain: consumers must use text nodes or equivalent escaping, never execute or inject their HTML.

## Automatic synchronization

The `sync-releases.yml` workflow runs on published, edited, deleted, unpublished, and channel-change release events, through manual dispatch, and daily at 07:23 UTC. It:

1. Checks out the trusted `main` branch and runs the tests.
2. Reads all release and asset pages from fixed GitHub API endpoints.
3. Fetches only the small checksum, JSON metadata and updater `.sig` assets, with bounded reads and a restricted GitHub CDN redirect allowlist. The API token is never sent to asset/CDN requests.
4. Validates the complete result before atomically replacing the manifest.
5. Commits only `releases.json` and the `updater/` files, and only if their bytes changed, in one commit.

Network failures, malformed responses, invalid assets, and exceeded limits fail the workflow and preserve the previous manifest. A successful empty API response clears the list, so deleting every release does not leave stale download links. A failed later page never produces a truncated history. No generation timestamp is included, which makes unchanged runs deterministic.

Bounds are explicit: at most 1,000 releases and 1,000 assets per release, API pages of 100, 8 MiB per API response, 16 KiB per release record, 512 bytes per checksum, 20,000 characters per release note, and **2 MiB for the serialized manifest**. Fetches time out after 30 seconds. Exceeding a limit requires a deliberate contract update; old entries are not silently dropped.

## Updater files

A Developer ID release may also carry the in-place update archive and its Tauri signature:

```text
Voicewoven-<version>-arm64.app.tar.gz
Voicewoven-<version>-arm64.app.tar.gz.sig
```

The same synchronization run writes `updater/stable.json` and `updater/preview.json` in Tauri's static updater format, in the same commit as `releases.json`:

```json
{
  "version": "1.0.0",
  "notes": "Release notes.",
  "pub_date": "2026-10-09T12:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "<contents of the .sig file>", "url": "https://github.com/augustocbx/voicewoven-releases/releases/download/v1.0.0/Voicewoven-1.0.0-arm64.app.tar.gz" }
  }
}
```

- **Eligibility:** a release that is not withdrawn, has an eligible installer, is signed with Developer ID and notarized, and has both files. The `.sig` must be at most 4 KB of base64 text (one trailing newline is allowed). A release that fails any of these, or whose `.sig` cannot be read as valid text, is skipped without failing the synchronization (the run prints the skipped version); a network failure while reading the `.sig` still fails the run. Ad hoc builds are never offered in place. The archive itself is never downloaded here.
- **`stable.json`:** the newest eligible stable release. **`preview.json`:** the newest eligible release of either channel, so a stable newer than every preview serves both files.
- **No eligible release:** the file does not exist. A withdrawn release drops out, so the files fall back to the previous eligible release (or disappear).
- **Contract:** `npm run validate` also checks both files against `releases.json`: exact fields, the release date, and a URL on this repository's GitHub release downloads for the matching tag. Releases published without these assets produce no updater file and are unaffected.

The canonical static manifest is:

```text
https://raw.githubusercontent.com/augustocbx/voicewoven-releases/main/releases.json
```

The website reads this static file, not the GitHub Releases API. Its own daily/manual workflow mirrors the validated file into `site/releases.json`; a changed mirror commit triggers its existing Cloudflare Git deployment. Client rendering prefers a successful canonical response over the mirror, including a successfully empty response. GitHub CDN caching and the mirror schedule can introduce propagation delay; the mirror is eventually consistent, not an independent release source.

After publishing, the local publisher should reconcile both repositories immediately:

```sh
gh workflow run sync-releases.yml --repo augustocbx/voicewoven-releases --ref main
# Wait for successful manifest generation before requesting the website mirror.
gh workflow run releases.yml --repo augustocbx/voicewoven-website --ref main
```

Daily runs provide recovery when an event or dispatch is missed. A `GITHUB_TOKEN` cannot dispatch workflows in another repository; this public workflow intentionally has no cross-repository secret or website write permission.

## Development

Node.js 22 or later is required. There are no package dependencies to install.

```sh
npm test
npm run validate
npm run sync
```

`npm run sync` reads the public API anonymously by default. Set `GITHUB_TOKEN` only in the process environment when a higher rate limit or draft visibility is needed. Do not save tokens in files, release records, notes, or command arguments. GitHub Actions supplies its repository-scoped token automatically.

Tests cover channel eligibility, updater file selection and validation, strict URLs and dates, checksum/record/asset consistency, pagination, hostile redirects and notes, edits and deletions, empty state, atomic preservation on failure, size limits, deterministic updates, and CLI exit behavior. The test workflow runs on Linux with Node.js 22 and 24. No macOS build runs in this public repository.

## Repository setup and operational requirements

Before automatic updates can run, the repository must exist publicly with `main` as its default branch, and these workflow files must be committed there. GitHub Actions must be enabled with permission for this workflow's `GITHUB_TOKEN` to write repository contents. Branch protection must permit this narrowly scoped bot update; otherwise the push fails and the scheduled/manual run can be retried after the policy is configured. The workflow never force-pushes.

The website repository and its Cloudflare Git integration must separately have their mirror workflow deployed. Initial repository creation, commits, permission configuration, actual release publication, anonymous download verification, and Cloudflare deployment are account-level delivery steps; local test success does not prove they have happened.

A stable release additionally requires an Apple Developer identity and a successful notarization/stapling process. Without those, only an explicitly authorized, clearly labeled preview can be published.
