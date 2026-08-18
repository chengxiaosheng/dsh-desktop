# Agent Note: Profile-anchored loader resolution keeps installed plugins loadable under Electron

Status: implemented

English | [中文](2026-08-17-profile-anchored-loader-resolution.zh.md)

## Problem

Installing a plugin in the market (e.g. `@liustack/modlens`) writes it into the profile's `node_modules` and reconciles it into `dsh.profile.bundles`; a boot that cannot resolve it fails with `Cannot find package '@liustack/modlens' imported from …/cordis-plugin-loader/lib/index.js`. The Cordis loader resolves bare (non-relative) entry specifiers through its "internal" module loader when present (`node-addon-require-builtin` exposing Node's ESM loader), otherwise through `import.meta.resolve` from the loader's OWN module location. Under plain Node the native internal loader exists and anchors resolution to the profile (the `bareModuleBaseUrl`); under **Electron** the native addon cannot load the internal loader, so bare names resolve from the workspace/packaged tree — where a profile-installed plugin never lives.

A second, more severe failure mode follows from profile-first resolution: a market plugin that depends on `@deepseek-ai/dsh-tools` (e.g. `dsh-office-tools`, `dsh-free-search`) installs a second copy into the profile's `node_modules`. The loader then mounts the in-box `tools` service from that copy while `dsh-agent-loop` keeps the app's copy, and the two copies carry different `unique symbol` identities for `TOOL_RUNTIME_SCHEDULER` (`Symbol(...)`, not `Symbol.for(...)`). The first tool dispatch reads `ctx.tools[TOOL_RUNTIME_SCHEDULER]` with the agent-loop's symbol, finds nothing, and the turn dies with `Cannot read properties of undefined (reading 'prepare')` — every session that calls any tool.

## Decision

`bootDesktop`'s prepare hook installs an installation-first `ctx.loader.internal` (`createProfileLoaderInternal`, in `electron/loader-internal.ts`). Each bare specifier resolves with `createRequire(app install package.json).resolve(...)` first, so in-box singleton services (`tools`, `dsh-agent-loop`, `dsh-llm`, …) stay on the app's module instance; when the installation cannot resolve the name, the hook defers to the native internal when one exists (plain Node, which fully honors the profile anchor and ESM exports) and otherwise resolves with `createRequire(profile package.json)` — either path reaches packages only the user installed. The resolver honors ESM-only `exports` maps: a package declaring only `import`/`types` conditions (no `require`) fails CJS `require.resolve` with `ERR_PACKAGE_PATH_NOT_EXPORTED` (dsh-remote, @huanlin/dsh-plugin-mineru), so the hook then resolves the package directory through its own `package.json` and picks the `import`/`default` entry. Relative, absolute, `file:`/`data:`/`http(s):`, and `node:` specifiers import directly (relative against the passed base URL). The hook is authoritative on every host — the native internal is the profile fallback, never the primary resolver — so in-box packages resolve identically under plain Node and Electron.

## Alternatives considered

**`--expose-internals`.** Requires the flag at process launch; cannot be applied retroactively from the boot hook.

**Symlinking profile plugins into the healed `$DSH_HOME/profiles/node_modules` fallback.** Wrong direction — the healed fallback mirrors the desktop's dependencies, not profile installs, and would need updating on every market install.

**`import.meta.resolve(specifier, parentURL)`.** The parent argument was not honored by the running Node build (resolution stayed anchored to the caller), so `createRequire` was used instead.

**Changing `TOOL_RUNTIME_SCHEDULER` to `Symbol.for(...)` in the published `dsh-tools`.** Would make any copy share the same key and fix every multi-copy deployment, but requires changing the upstream package the desktop does not control and a new release; kept as the upstream hardening option, not applied here.

## Consequences

The app boots after installing any plugin through the market, and in-box singleton services stay on the app's module instance even when a plugin pulls a same-named copy into the profile. Verified: with the real profile carrying `dsh-office-tools`/`dsh-free-search` and their profile-local `dsh-tools`, a boot now keeps `ctx.tools[TOOL_RUNTIME_SCHEDULER]` defined with `prepare`/`dispatch`/`finalize`/`finish`, where the profile-first behavior made it undefined and crashed the first tool call. A user-installed package that shares an in-box name is shadowed by the app's copy. Costs: the desktop owns a loader-resolution hook that must track how the loader resolves bare names; in-box packages now resolve through the hook's partial `exports` re-implementation on plain-Node hosts too (they already did under Electron), so exports patterns and conditional subpaths beyond that re-implementation are covered only for profile-installed packages that fall through to the native internal.
