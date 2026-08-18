# Agent Note: System pnpm only — bundled standalone dropped

Status: implemented

English | [中文](2026-08-18-system-pnpm-only.zh.md)

## Problem

The packaged app shipped `@pnpm/exe`, whose standalone binary embeds its own Node.js runtime plus the whole pnpm CLI — ~140MB plus a 19MB JS dist, the single largest item in the 465MB dependency closure. It inflated every installer by roughly a third (win NSIS 436MB, mac DMG 331MB, linux AppImage 259MB) to support installing plugins without a system pnpm. Electron already bundles a Node runtime, so the standalone's embedded Node was redundant in principle; and the plugin-market `dsh plugin` CLI (a published upstream package) hard-spawns `pnpm` from PATH, so npm cannot substitute.

A desktop GUI launch does not source the user's shell profile (macOS Finder/Dock, Windows Explorer, a Linux desktop menu all inherit a sparse PATH), so a user pnpm installed through nvm, `pnpm setup`, Homebrew, or `npm -g` is invisible to the spawned `dsh` CLI even though a terminal finds it — plugin installs failed with the upstream "pnpm not found on PATH" message on machines where pnpm plainly exists.

## Decision

`@pnpm/exe` is no longer part of the product: it is removed from `dsh-plugin-desktop`'s `dependencies` and from `pnpm-workspace.yaml`'s `allowBuilds`, and `materialize.mts` excludes it (with the `@pnpm/<platform>` install-time-only packages) from the materialized closure via `PNPM_BUNDLED_PKG`. `desktopPnpm` resolves `pnpm` from the system PATH — `desktop-services.ts` drops the bundled-pnpm branch, and its `childEnv` appends the well-known user bin dirs (`electron/path-bootstrap.ts`: homebrew, `~/.local/bin`, `~/.local/share/pnpm`, `~/.npm-global/bin`, `~/.volta/bin`, and every nvm node bin holding `node`/`pnpm`) to every package-manager child's PATH, so a GUI launch still resolves a user pnpm. The `dsh` CLI still runs under Electron's plain-Node mode, so only `pnpm` must exist in a discoverable location for plugin installs; the upstream CLI prints "pnpm not found on PATH — install pnpm to manage profile plugins" when it is absent.

The market's one-click pnpm setup is stubbed in Desktop mode (upstream dshmarket's `createDesktopPluginRuntime` returns `probePnpm`/`provisionPnpm` success without installing), so the desktop-side compensation is the PATH bootstrap above, not the button.

## Alternatives considered

**Keep the bundled standalone.** Preserves "install plugins with zero system dependencies" at the cost of ~159MB in every installer — rejected for size.

**Run the pnpm JS distribution on Electron's Node** (`spawn(process.execPath, [pnpm-cli.js, ...])`). Removes the standalone's embedded Node, but the upstream `dsh plugin` CLI's internal `spawnSync("pnpm")` still needs a PATH-visible `pnpm`, which would require a shim that locates the Electron binary — deferred as higher-complexity work.

**Fall back to npm.** The upstream `dsh plugin` CLI is a pnpm-specific forwarder (`spawnSync("pnpm")` plus pnpm-only `dsh.profile.bundles` reconciliation), so npm cannot substitute without modifying a published package.

**Self-heal: install pnpm at runtime when missing.** Writes to disk and downloads on first use, with permission/network failure modes; rejected as out of scope — the bootstrap covers an installed pnpm and the clear upstream message remains when it is absent.

**PATH bootstrap by discovery rather than well-known dirs.** Probing every candidate (`pnpm --version`) adds a child spawn per operation and caches state; the static well-known dir list (matching the dshmarket web runtime's approach) is deterministic and headless-testable — chosen.

## Consequences

Installers shrink by roughly one third (win ~436→~330MB, mac ~331→~250MB, linux AppImage ~259→~200MB). Plugin installs now require system pnpm on the machine; the "install plugins without a system Node or pnpm" feature is dropped, and the READMEs document the pnpm requirement. Re-adding the bundled pnpm later is a one-line exclusion change if offline installs ever matter. GUI launches (the common desktop case) now resolve a user pnpm in any well-known location; the market's setup button remains a stub on Desktop (upstream), which the READMEs document as a known limitation.
