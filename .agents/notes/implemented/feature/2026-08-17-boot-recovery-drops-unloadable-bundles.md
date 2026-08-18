# Agent Note: Boot recovery drops unloadable profile bundles

Status: implemented

English | [中文](2026-08-17-boot-recovery-drops-unloadable-bundles.zh.md)

## Problem

A single broken install hard-failed the whole tree at boot and the app never opened. `dsh-web-search-pro`'s bundle patch inserts a `browser (@anweat/dsh-browser)` row, but that package is not published to npm and not in the bundle's manifest dependencies — the loader cannot resolve it, and the boot aborts. The user's only recovery was manual profile surgery, and the desktop has no CLI to uninstall from.

## Decision

`bootDesktop` self-heals before mounting. Phase 1 (`recoverMissingBundlePackages`, before `loadProfile`) drops bundles whose own package is not resolvable from the profile — `loadProfile` fails loud on a listed bundle without a loadable package, so the boot would otherwise abort before recovery. Phase 2 (`recoverMissingBundleRows`, after `loadProfile`) drops bundle layers whose patch inserts a row referencing an unresolvable package. Both persist the removal in `dsh.profile.bundles` (via `writeProfileManifest`) and warn. The package stays in `dependencies`/`node_modules`: the app boots, the market can uninstall it properly once running, and re-adding the bundle works once the package is available. Resolvability uses the same ESM-aware check the loader's profile-anchored resolution uses (`canResolveBare`), so a package that resolves but lacks its entry artifact is also dropped.

## Alternatives considered

**Stub the missing entry** (`{ name, apply() {} }`, the market's shim pattern). Rejected — the sibling rows of the same bundle keep mounting and the broken plugin stays half-live on every boot; the user asked for removal.

**Removing from `dependencies` too.** Rejected — needs pnpm at boot; keeping the install lets the market own the uninstall and keeps the state recoverable.

**Removing only the missing package.** Rejected — the package is not there to remove; the owning bundle is what must go.

## Consequences

The app opens despite a broken install, logs a warning naming the bundle and the missing specifiers, and prunes the offending bundle idempotently (the manifest no longer lists it, so the next boot is clean). Costs: the boot owns a profile-manifest mutation (removal only, gated on genuine unresolvability through the same resolution the loader uses); a bundle that is temporarily unresolvable (a mid-install pnpm state) would be dropped and need re-adding.
