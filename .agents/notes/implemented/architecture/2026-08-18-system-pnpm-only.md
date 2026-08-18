# Agent Note: System pnpm only — bundled standalone dropped

Status: implemented

English | [中文](2026-08-18-system-pnpm-only.zh.md)

## Problem

The packaged app shipped `@pnpm/exe`, whose standalone binary embeds its own Node.js runtime plus the whole pnpm CLI — ~140MB plus a 19MB JS dist, the single largest item in the 465MB dependency closure. It inflated every installer by roughly a third (win NSIS 436MB, mac DMG 331MB, linux AppImage 259MB) to support installing plugins without a system pnpm. Electron already bundles a Node runtime, so the standalone's embedded Node was redundant in principle; and the plugin-market `dsh plugin` CLI (a published upstream package) hard-spawns `pnpm` from PATH, so npm cannot substitute.

## Decision

`@pnpm/exe` is no longer part of the product: it is removed from `dsh-plugin-desktop`'s `dependencies` and from `pnpm-workspace.yaml`'s `allowBuilds`, and `materialize.mts` excludes it (with the `@pnpm/<platform>` install-time-only packages) from the materialized closure via `PNPM_BUNDLED_PKG`. `desktopPnpm` resolves `pnpm` from the system PATH (`desktop-services.ts` drops the bundled-pnpm branch). The `dsh` CLI still runs under Electron's plain-Node mode, so only `pnpm` must exist on PATH for plugin installs; the upstream CLI prints "pnpm not found on PATH — install pnpm to manage profile plugins" when it is absent.

## Alternatives considered

**Keep the bundled standalone.** Preserves "install plugins with zero system dependencies" at the cost of ~159MB in every installer — rejected for size.

**Run the pnpm JS distribution on Electron's Node** (`spawn(process.execPath, [pnpm-cli.js, ...])`). Removes the standalone's embedded Node, but the upstream `dsh plugin` CLI's internal `spawnSync("pnpm")` still needs a PATH-visible `pnpm`, which would require a shim that locates the Electron binary — deferred as higher-complexity work.

**Fall back to npm.** The upstream `dsh plugin` CLI is a pnpm-specific forwarder (`spawnSync("pnpm")` plus pnpm-only `dsh.profile.bundles` reconciliation), so npm cannot substitute without modifying a published package.

## Consequences

Installers shrink by roughly one third (win ~436→~330MB, mac ~331→~250MB, linux AppImage ~259→~200MB). Plugin installs now require system pnpm on the machine; the "install plugins without a system Node or pnpm" feature is dropped, and the READMEs document the pnpm requirement. Re-adding the bundled pnpm later is a one-line exclusion change if offline installs ever matter.
