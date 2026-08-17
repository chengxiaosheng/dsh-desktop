# Agent Note: System tray and close-to-tray preference

Status: implemented

English | [中文](2026-08-17-close-to-tray.zh.md)

## Problem

Closing the main window always quit the application off-darwin, leaving no way to keep the host running in the background; the product had no system tray. A close-window preference belongs to the desktop shell only — the plain web harness must never show it — and every user-facing string is bilingual (`zh`/`en`) through the standard `locales.ts` convention.

## Decision

The close-window behavior is a durable preference owned by the desktop shell row. The node half (`src/index.ts`) registers the `desktop` settings namespace (`{ closeToTray: boolean }`, default `false`, applies `live`) through the existing settings provider, and the Electron main reads it at window-close time via `readCloseBehavior` (falling back to quit on any broken read), so an edit made while the window is open applies to the next close.

The renderer row does NOT reach the namespace through the settings wire: the host ApiProxy's `WEB_SETTINGS_NAMESPACES` allowlist answers `settings-not-exposed` for any namespace outside the shipped web preferences, and the allowlist is a module-level constant in the published `dsh-host-apiproxy` (upstream marks moving it to `settings.register()` as deferred work). The row therefore reads and writes over the desktop bridge instead: the preload exposes `getCloseBehavior`/`setCloseBehavior` (the `dsh:close-behavior` channel), and the main process mediates the write against the in-process settings provider, which is not gated by the wire allowlist. The settings document stays the single durable source of truth — the row adopts the stored value at boot, and the main reads it at close time.

The General settings row ("关闭窗口行为" / Close-window behavior: quit / minimize to tray) is contributed by the shell's browser half (`src/client/`) through the `settings.general.item` slot, following the current harness row pattern: status-gated rendering (the row hides while the bridge read is unavailable and disables the trigger while loading) and the exact upstream row CSS (including `:hover:not(:disabled)`). Dictionaries live in `src/client/locales.ts` as the `settings.desktop` locale namespace; the same dictionaries carry the tray menu copy. The row is desktop-only by construction: `dsh-plugin-desktop` mounts only in the desktop composition, so the option never appears in a plain `dsh web` run.

The tray exists on every platform regardless of the setting. A hidden window must always have a restore path, so the tray cannot be conditional on the setting that hides it. The menu (show/quit) is rebuilt at every open, and its labels are published by the renderer over the `dsh:locale` channel at boot and on every locale change — the tray always matches the language the app actually displays (explicit preference or browser-detected), with English standing until the first publication. Close interception lives in `electron/main.ts`: `before-quit` sets a quitting flag, and the window's `close` handler hides instead of destroying unless a real quit is underway (tray quit, Cmd+Q, or quit while the preference is off). Hidden windows restore through the tray, `second-instance`, and macOS `activate`.

The client bundle (`scripts/build-client.mts`) matches the upstream artifact shape: the whole module body lives inside the `window.__ModuleLoader__.load({ id, factory })` handoff, and cross-package imports stay `require(...)` calls resolved by the module loader at runtime. `react`/`react/jsx-runtime` must be the renderer's own instances (hook state), `dsh-client-ui-primitives` follows the upstream external set, and `dsh-client-runtime/client` is itself a loader bundle that cannot be inlined. esbuild's CJS output is wrapped in the factory with `module`/`exports` shims; CSS modules are inlined as hashed class maps with a guarded `<style>`-tag injection. `tsconfig.build.json` uses `rewriteRelativeImportExtensions` so sources keep `.ts` specifiers (node tests import them directly) while emitting `.js`.

## Alternatives considered

**Tray only while the preference is on.** Rejected — disabling the preference while the window is hidden would strand it with no restore path; an always-on tray keeps every hide recoverable.

**Reaching the settings wire with the `desktop` namespace.** Rejected — the host ApiProxy's explicit allowlist refuses it (`settings-not-exposed`), and the allowlist is upstream-published module state; the bridge-mediated write against the in-process provider preserves the document as the durable source without touching upstream.

**On/off switch instead of the two-option selector.** Rejected — the two options (quit / minimize to tray) match the preference's wording exactly, and the selector mirrors the harness row pattern.

**Default to minimize-to-tray.** Rejected — the default preserves the pre-tray behavior (close = quit) for existing users.

**Bundling the framework store (`createSnapshotStore`) or react into the client bundle.** Rejected — the runtime client is itself a ModuleLoader bundle (nesting its `load` call breaks), and a second react copy would break hook state shared with the renderer.

**Tray labels read from the `locale` settings namespace in the main process.** Rejected — that document only carries an explicit preference; a browser-detected locale would leave the tray in English. Publishing the resolved labels from the renderer covers both cases.

## Consequences

Users get an always-visible tray whose labels track the app's displayed language, and a bilingual General-settings choice that persists and takes effect on the next window close, with the default behavior unchanged; the packaged app ships `lib/client.js` automatically through the existing materialize pipeline (it copies `lib/**`). Costs: two small bridge channels (`dsh:close-behavior`, `dsh:locale`) beyond the connection carrier; the client bundle build is a CJS-factory wrap rather than the connection package's plain IIFE (the externals require the loader's synchronous `require`); the tray icon reuses the window icon (`build/icon.png`) with no dedicated tray asset; tray click/menu behavior across the three platforms needs manual verification (Linux appindicator surfaces vary by desktop environment).