# Agent Note: Profile-anchored loader resolution keeps installed plugins loadable under Electron

Status: implemented

English | [中文](2026-08-17-profile-anchored-loader-resolution.zh.md)

## Problem

Installing a plugin in the market (e.g. `@liustack/modlens`) wrote it into the profile's `node_modules` and reconciled it into `dsh.profile.bundles` — the next boot failed with `Cannot find package '@liustack/modlens' imported from …/cordis-plugin-loader/lib/index.js`. The Cordis loader resolves bare (non-relative) entry specifiers through its "internal" module loader when present (`node-addon-require-builtin` exposing Node's ESM loader), otherwise through `import.meta.resolve` from the loader's OWN module location. Under plain Node the native internal loader exists and anchors resolution to the profile (the `bareModuleBaseUrl`); under **Electron** the native addon cannot load the internal loader, so bare names resolve from the workspace/packaged tree — where a profile-installed plugin never lives.

## Decision

`bootDesktop`'s prepare hook installs a profile-anchored `ctx.loader.internal` (`createProfileLoaderInternal`, in `electron/loader-internal.ts`): when a native internal exists it delegates to it unchanged (behavior-neutral on plain Node, where it already anchors to the profile); when absent it resolves bare specifiers with `createRequire(profile package.json).resolve(...)` and imports the resulting file URL — plain ESM `import`, no Node internals — so profile-installed plugins resolve at boot under Electron. The resolver also honors ESM-only `exports` maps: a package declaring only `import`/`types` conditions (no `require`) fails CJS `require.resolve` with `ERR_PACKAGE_PATH_NOT_EXPORTED` (dsh-remote, @huanlin/dsh-plugin-mineru), so the hook then resolves the package directory through its own `package.json` and picks the `import`/`default` entry. Relative, absolute, `file:`/`data:`/`http(s):`, and `node:` specifiers import directly (relative against the passed base URL).

## Alternatives considered

**`--expose-internals`.** Requires the flag at process launch; cannot be applied retroactively from the boot hook.

**Symlinking profile plugins into the healed `$DSH_HOME/profiles/node_modules` fallback.** Wrong direction — the healed fallback mirrors the desktop's dependencies, not profile installs, and would need updating on every market install.

**`import.meta.resolve(specifier, parentURL)`.** The parent argument was not honored by the running Node build (resolution stayed anchored to the caller), so `createRequire(profile)` was used instead.

## Consequences

The app boots after installing any plugin through the market (verified: the real profile with `@liustack/modlens` and ESM-only `dsh-remote`/`@huanlin/dsh-plugin-mineru` boots; the packaged host still boots). Costs: the desktop owns a loader-resolution hook that must track how the loader resolves bare names; the fallback uses CJS `createRequire.resolve` first and re-implements only the `exports["."]`/`main` entry pick for ESM-only packages — exports patterns and conditional subpaths beyond that remain covered by the native internal loader on plain-Node hosts.
