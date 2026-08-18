# Agent Note: GitHub Actions CI and release packaging

Status: implemented

English | [中文](2026-08-18-github-actions-ci.zh.md)

## Problem

The repository had no CI: nothing ran tests, type-checks, or produced installable artifacts after a commit, so regressions in the workspace composition or the packaging pipeline surfaced only on a developer's machine.

## Decision

Two GitHub Actions workflows live in `.github/workflows/`. `ci.yml` runs on every push to master and every pull request: it installs the workspace the same way a local checkout does (resolving `@deepseek-ai/*` fresh from the dist-tags recorded in `upstream.json`, because `pnpm-lock.yaml` is not committed), runs `pnpm check` (per-package strict type-check, compile, and tests, including the `verify:upstream` pinned-copy gate), then runs `package:dir` to prove the full electron-builder pipeline (build → materialize → electron-builder → headless boot of the packaged `resources/host`) on the Linux runner. `build.yml` packages installable artifacts on native runners (mac DMG on macOS, win x64 NSIS on Windows, linux AppImage+deb+rpm on Linux) and uploads them as workflow artifacts; it triggers on a `v*` tag, manual `workflow_dispatch`, and pushes to master that change packaging-relevant files (detected by `dorny/paths-filter`, so ordinary commits do not burn three native runners). Both workflows cache the pnpm store and the Electron/electron-builder download caches, keyed on the manifests because the lockfile is absent. `dist.mts` spawns `pnpm` with `shell: true` on Windows so its internal `spawnSync('pnpm', …)` calls resolve the `pnpm.cmd` shim. Code signing stays off (`CSC_IDENTITY_AUTO_DISCOVERY=false`) and no artifact is published (electron-builder `publish: null`) — producing an artifact is a build step, publishing it remains a separate release decision.

## Alternatives considered

**One combined workflow file.** Simpler to read, but couples the fast per-commit test gate to the slow cross-platform packaging matrix; the path-filtered master trigger and the tag/manual dispatch read cleanly as their own file.

**Run the full packaging matrix on every commit.** Maximum feedback, but three native runners run the whole electron-builder pipeline (Electron downloads and ~230MB artifacts) on every push; the `package:dir` step in `ci.yml` already exercises the pipeline headlessly on every commit.

**Commit `pnpm-lock.yaml` for reproducible installs.** Rejected by the existing dist-tag-floating decision; CI installs float with the tags exactly as local installs do, and `verify:upstream` gates the pinned `ConnectionController` copy against the installed family.

## Consequences

Every commit is gated by type-check, build, tests, and a headless packaging proof; `v*` tags and master pushes produce unsigned, uploadable installers for all three platforms. Costs: the pnpm store cache is best-effort because installs float (the key hashes the manifests, not a lockfile); a fresh upstream release can fail the build via `verify:upstream` until the pinned copy is reapplied; the mac artifact is built on the arm64 `macos-latest` runner (electron-builder's native arch), so other mac arches require passing `--x64`/`--arm64` to `dist:mac`; the package jobs depend on the Electron/electron-builder download caches to avoid re-downloading binaries on every run.
