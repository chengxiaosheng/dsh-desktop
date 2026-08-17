# Agent Note: Modular Electron shell and packaging pipeline

Status: implemented

English | [中文](2026-08-17-electron-shell-structure.zh.md)

## Problem

The Electron main was a single ~250-line module owning every shell concern - lifecycle wiring, window creation, the IPC bridge, renderer diagnostics, and error formatting - with platform-lifecycle gaps: it quit on any window close (no macOS `activate`/`window-all-closed` semantics), had no single-instance lock (two launches race on the same profile home), no window-open/navigation/permission guards, and resolved the preload path via URL `.pathname`, which yields `/C:/...` on Windows. The electron-builder config lived as the `build` field in package.json (no comments possible) and the packaging pipeline was re-declared as a four-step chain in each of the four dist scripts.

## Decision

`electron/main.ts` is a thin composition root that owns application lifecycle only; every other shell concern is its own module, and future shell capabilities (updates, terminal) mount beside them there: `window.ts` (creation options, `ready-to-show`, minimum size, linux window icon, `setWindowOpenHandler` deny with `shell.openExternal` for http/https, `will-navigate` pinned to the staged page, permission requests denied), `page.ts` (the `file://` SPA staging), `ipc.ts` (the bridge, installed once per application with the renderer resolved per send), `menu.ts` (role-based menu on macOS, `null` elsewhere), `tray.ts` (the system tray, added by the later close-to-tray feature), `diagnostics.ts` (renderer failure logs, plus detached devtools behind `DSH_DESKTOP_DEBUG=1`), and `errors.ts` (boot-failure flattening). Lifecycle follows platform conventions: `requestSingleInstanceLock` with `second-instance` focusing or recreating the window, `activate` recreating a closed window on macOS, `window-all-closed` quitting only off-darwin, `will-quit` disposing the host fiber before exit (profile writes unwind), and a fatal boot path that logs one line per underlying error and shows a native `dialog.showErrorBox` when packaged. The preload path resolves through `fileURLToPath` (Windows-correct), and Windows sets the app user model ID to the builder `appId`. `boot-desktop.ts` gains an exported `resolvePackageRoot()` so `window.ts` reuses the one package-root walk; `boot-desktop` and the preload stay byte-identical in contract (headless tests and `verify:packaged` import them unchanged), and the zero-socket `file://` transport is untouched.

Packaging moved to a standalone `electron-builder.yml` (the wrapper passes `--config` explicitly; `publish: null` keeps the builder from ever uploading) with the linux target set AppImage + deb + rpm; `scripts/dist.mts` runs the whole pipeline once - desktop build, connection build, materialize, electron-builder, headless packaged-boot verify - with arguments passing through to electron-builder, so the four package.json dist scripts are one-liners and single-target builds (`--linux deb`) need no script edits. `materialize.mts` reads `productName` from the builder config (single source; the packaged app's userData derives from it) and stages `build/icon.png` under `resources/host/build` so the packaged linux window icon resolves. `tests/packaging.spec.ts` parses the yml and asserts the contract: target matrix, identity fields, asar staging, and the extraResources host mapping.

## Alternatives considered

**Keep the single-file main.** Every new shell capability widens one file and re-checks everything; rejected - the module seams are the extension point.

**Custom privileged protocol (`app://`) replacing the `file://` page.** Cleaner URL story, but it changes the page origin the renderer connection client's virtual-host bridge keys on (`location.origin === 'file://'`), which is a `dsh-plugin-desktop-connection` contract; out of scope for this package.

**electron-forge.** Valid toolchain, but departs from the electron-builder reference projects.

**Keep the builder config in package.json.** No comments, and the pipeline stayed duplicated across four scripts; rejected for the yml + dist orchestrator pair.

**`backgroundColor` on the window.** `ready-to-show` already prevents the unpainted-window flash, and a hard-coded color risks mismatching the SPA theme; dropped.

## Consequences

The shell grows by adding modules beside `main.ts` instead of widening it; macOS window lifecycle, second-launch focus, graceful fiber dispose, and packaged boot-failure reporting now follow Electron platform conventions; the packaging target matrix is asserted by a test, so a config edit cannot silently drop rpm. Costs: rpm artifacts need `rpmbuild` installed on the build host (Ubuntu package `rpm`); the menu is minimal by design (devtools live behind `DSH_DESKTOP_DEBUG=1`, not a menu item); and the permission handler denies every request - revisit if the SPA ever needs notifications or media.
