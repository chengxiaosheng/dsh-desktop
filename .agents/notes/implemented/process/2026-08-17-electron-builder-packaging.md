# Agent Note: Cross-platform packaging with electron-builder

Status: implemented

English | [中文](2026-08-17-electron-builder-packaging.zh.md)

## Problem

The desktop shipped no installable artifacts: only `pnpm start` (dev launch) existed, so mac/win/linux delivery meant running from a checkout with Electron and the workspace installed. The README listed installers as deferred.

## Decision

`dsh-plugin-desktop` packages through electron-builder 26.15.3 (the version used by both the `deepseek-harness-desktop` and `deepseek-harness/apps/desktop` references) with the materialize layout: `scripts/materialize.mts` stages `dist-pack/` — a thin asar app whose bootstrap main imports the real runtime from `resources/host` and imports no `@deepseek-ai` package — and `dist-host/`, shipped as per-entry `extraResources` → `resources/host`, holding the compiled electron runtime (`lib/electron`), the compiled row sources (`lib/src`), `cordis.patch.yml`, a flat dependency closure (`node_modules/`, real files walked the same way `healProfilesModuleFallback` walks it), and a host manifest naming the whole closure. The packaged boot anchors on `resources/host/package.json`, so every plugin row — `dsh-plugin-desktop` itself, `dsh-plugin-desktop-connection`, and the `@deepseek-ai/*` bundles — resolves by name from real directories. This exists because a whole-app-asar layout cannot resolve bare row specifiers: Node's ESM loader neither walks asar-internal node_modules nor applies the app's self-reference from a nested loader location, so the loader aborts with `Cannot find package 'dsh-plugin-desktop'` (and electron-builder's node-module collector prunes the closure). All owned sources are compiled before materializing (desktop `tsc` → `lib/`, connection node-half `tsc` → `dist/` and client bundle → `lib/client.js`). `verify:packaged` boots the packaged `resources/host` headlessly and asserts the socketless host, connection mount, and composed file:// manifest. Targets: mac DMG, win x64 NSIS, linux AppImage + deb; installer targets guard on their native host; code signing is off by default (`CSC_IDENTITY_AUTO_DISCOVERY=false`), and hardened runtime stays off (`hardenedRuntime: false`) so unsigned or ad-hoc builds carry no library-validation rejection. Two workspace pins make the toolchain work under pnpm: `app-builder-lib>@electron/get: ^3.1.0` (app-builder-lib 26.15.3 needs `ElectronDownloadCacheMode`) and `electron-winstaller: false` (its Squirrel.Windows build script is unneeded).

## Alternatives considered

**Whole-app asar with asarUnpack.** The initial approach; the loader's bare imports and the app's self-reference both break from an asar-internal node_modules, and electron-builder's dependency walk prunes the peer-only closure, so the packaged app cannot boot.

**electron-forge.** A valid alternative but departs from the reference projects' toolchains.

**Defer packaging further.** Leaves no way to deliver the app on the three platforms.

## Consequences

The product ships mac DMG / win NSIS / linux AppImage+deb from the root (`pnpm dist:*`), each verified by a headless boot of the packaged `resources/host`. Costs: artifacts are large (AppImage ~230MB) because the whole dependency closure ships as real files in `resources/host`; materialize must be re-run on every packaging change (it is part of `package:dir`/`dist:*`); installer targets require their native host; signed/notarized releases are deferred; the `@electron/get` override and the disabled `electron-winstaller` build are pnpm-specific pins that must survive dependency bumps.
