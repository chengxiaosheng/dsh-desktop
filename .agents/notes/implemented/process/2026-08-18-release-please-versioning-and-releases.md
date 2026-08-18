# Agent Note: release-please versioning and GitHub Release artifacts

Status: implemented

English | [中文](2026-08-18-release-please-versioning-and-releases.zh.md)

## Problem

Versions were bumped by hand, and the packaging workflow uploaded installers only as expiring workflow artifacts, so users had no durable place to download the app for a given version. There was no automatic release: no version bump, no changelog, no tag, and no GitHub Release carrying the built installers.

## Decision

Version lifecycle and distribution are automated with release-please plus the existing packaging workflow. `.github/workflows/release-please.yml` runs on every push to master using `googleapis/release-please-action@v5` (the maintained successor of the deprecated `google-github-actions/release-please-action`) in manifest mode: `release-please-config.json` (`release-type: node`, `package-name: dsh-desktop`, `bump-minor-pre-major: true`) declares the component and `extra-files`, and `.release-please-manifest.json` records the root component's current version (`".": "0.1.0"`). The action infers the next version from Conventional Commits, bumps the root `package.json` and both workspace `package.json` files (via `extra-files`), updates `CHANGELOG.md`, and opens a release PR. Merging that PR creates the `vX.Y.Z` tag and the GitHub Release. `.github/workflows/build.yml` already triggers on `v*` tag pushes; the `package` job now gains `contents: write` and, on tag pushes only, generates a `SHA256SUMS` file over its platform's installers and attaches them to the Release with `softprops/action-gh-release@v2` (`tag_name` from `github.ref_name`). Users download the app from the repository's Releases page. Code signing stays off, so distributed installers are unsigned.

## Alternatives considered

**Manual tag + build.yml only.** Keeps version bumps, changelog, and tagging as manual steps; fine for one person but the user asked for automatic versioning.

**A `workflow_dispatch` release workflow that bumps and tags itself.** Predictable but semi-manual; release-please also produces the changelog and standard release PR.

**electron-builder's GitHub `publish` provider.** Publishes from within electron-builder and enables `electron-updater` auto-update, but auto-update on macOS is impractical without signing, and the release asset flow here already satisfies "users download from Releases".

## Consequences

Each merged release PR produces a tagged GitHub Release whose installers (plus `SHA256SUMS`) appear automatically on the Releases page; users download the app per platform without expiring workflow artifacts. Costs: commits must follow Conventional Commits or the inferred version is wrong; release-please drives a release-PR workflow that may take some getting used to; the first run proposes the next version from all commits since `0.1.0` (there is no prior tag), so the initial release number may need confirmation; release assets land on a live Release as they finish building (~10 min across platforms), so the Release briefly appears with no assets; and the released installers remain unsigned (signing is a separate, later step).
