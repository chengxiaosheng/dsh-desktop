# Agent Note: Upstream releases move the desktop reference set together

Status: implemented

English | [中文](2026-08-18-upstream-release-reference-set.zh.md)

## Problem

The desktop consumes the published DeepSeek Harness family from the npm `next` dist-tag (see the [dist-tag floating note](2026-08-17-upstream-dist-tag-floating.md)) and the dshmarket plugin market as an ordinary dependency. An upstream release does not flow into the repo as one atomic edit: several references point at the released state, and each has its own update shape. Two are this repo's own files (`upstream.json` and the pinned `ConnectionController` copy), one resolves at install time (the `@deepseek-ai/*` family), and two belong to the market dependency (`dshmarket` specifier and the workspace release-age exclude). `verify:upstream` gates only the pinned copy; the complete set and the order to move it had no single home.

## Decision

The desktop's upstream references are:

1. `upstream.json` records the pinned `@deepseek-ai/dsh-client-connection` version and its upstream commit; it is bumped to the released version and commit when the family releases (currently 0.1.0-rc.7, commit `99f6f02`).
2. `packages/dsh-plugin-desktop-connection/src/client/controller.ts` is the pinned `ConnectionController` copy, restored from the `sourcePath` at the recorded commit with the two documented mechanical adaptations. It is re-applied only when the upstream source actually differs; the rc.7 source is byte-identical to rc.6's, so this release needs no reapply. `verify:upstream` (run by the connection package's `build`) compares the installed `@deepseek-ai/dsh-client-connection` against `upstream.json` and fails with reapply instructions on mismatch.
3. The installed `@deepseek-ai/*` family resolves at `pnpm install` from the `next` dist-tag; `package.json` declares the tag, not a version, so no manifest edit accompanies a release.
4. `packages/dsh-plugin-desktop/package.json` carries the `dshmarket` specifier, bumped to the released market (currently `^1.12.1`).
5. `pnpm-workspace.yaml` `minimumReleaseAgeExclude` names the installed `dshmarket` version and the whole `@deepseek-ai/*` scope. pnpm 11's default `minimum-release-age` is 24 hours: a package published within the window is filtered out of dist-tag resolution, so a fresh `next` family release would silently resolve to the previous family and a fresh market release would be refused. The exclude is what lets a same-day upstream release resolve at all.

On a release, the set moves in this order: bump `upstream.json` version/commit and the `dshmarket` specifier plus the release-age exclude; re-apply `controller.ts` from the new `sourcePath` when the upstream source changed; run `pnpm install`; then build, which runs `verify:upstream`, and the package checks.

## Alternatives considered

**Bump `upstream.json` and let the market float.** The caret specifier `^1.11.0` already resolves the newest market, so the manifest never needs an edit. Rejected: the reference should state the version the product actually ships with, and the release-age exclude must name the installed version or pnpm can refuse a fresh release.

**Freeze the family in a committed lockfile.** Rejected in the owning [dist-tag floating note](2026-08-17-upstream-dist-tag-floating.md) — installs resolve the tags fresh.

## Consequences

A release moves through the repo as one reviewable change instead of silently arriving at install time, and the market's desktop contract (`desktopProfiles`/`desktopPnpm`) stayed unchanged across the 1.12.1 bump, so the desktop services required no adaptation. The costs: a release that changes the `ConnectionController` source or the market's desktop contract needs the manual reapply/adaptation step, and the fresh-resolution policy means two installs at different times can resolve different families.
