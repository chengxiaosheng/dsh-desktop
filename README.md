# DSH Desktop

A desktop product around the **unmodified** published DeepSeek Harness packages: the full Web UI running with **no Node HTTP server and no port**, composed entirely as Cordis plugins over the `@deepseek-ai/*` family resolved from the dist-tags recorded in [`upstream.json`](upstream.json).

- [`upstream.json`](upstream.json) — upstream provenance: dist-tags the family resolves from (`next` for the dsh family, `latest` for the cordis framework) + the pinned `ConnectionController` copy's source version and commit.
- `packages/dsh-plugin-desktop/` — the shell row, the socketless `webServer` interceptor, and the Electron main.
- `packages/dsh-plugin-desktop-connection/` — the renderer wire client over Electron IPC.
- Documentation and decisions follow the [DeepSeek Harness conventions](AGENTS.md).

## The zero-socket transport

| Piece | Row / package | What it replaces |
|---|---|---|
| Socketless webserver | `dsh-plugin-desktop/webserver` | the official `webserver` row (disabled) |
| Renderer wire client | `dsh-plugin-desktop-connection` | the official `connection` row (disabled) — node half re-exports upstream, client half rides Electron IPC |
| Boot manifest | Electron preload (`window.__DSH_BOOT__`) | the server index tap |
| RPC dispatch | `ipcMain` (`connection.createSharedFetchHandler` + `apiProxy`) | the HTTP/WebSocket carrier |
| Virtual-host download bridge | `dsh-plugin-desktop-connection` client + `dispatchHttpRequest` (main) | the host HTTP download the official webserver served (`/api/session.export`) |

The official `modules`, `ui-theme`, `web-runtime`, and `frontend-static` rows activate unchanged against the virtual `webServer`.

## Layout

```
upstream.json                  upstream provenance (dist-tags + pinned-copy version/commit)
packages/
  dsh-plugin-desktop/
    cordis.patch.yml           desktop composition (disable + insert rows)
    src/webserver.ts           VirtualWebServer — socketless interceptor
    src/index.ts               desktop shell row
    src/cordis.d.ts            cordis Context augmentation for the desktop host
    electron/main.ts           Electron main: window + IPC bridge
    electron/preload.cts       __DSH_BOOT__ + dshDesktop bridge (compiled to preload.cjs)
    electron/boot-desktop.ts   profile boot + file:// manifest assembly (headless-testable)
    tests/                     boot proof + electron boot helper tests (TS)
    build/icon.png             app icon (electron-builder build resource)
    scripts/                   TypeScript packaging scripts (materialize + electron-builder wrappers + verification)
    lib/                       compiled runtime (tsc → lib/src + lib/electron, gitignored)
    dist/                      generated installers / unpacked apps (gitignored)
    dist-pack/                 staged thin asar app → resources/app.asar (gitignored)
    dist-host/                 staged host runtime + flat closure → resources/host (gitignored)
  dsh-plugin-desktop-connection/
    src/index.ts               node half: re-exports the official apply
    src/client/                IPC carrier + pinned ConnectionController + plugin (TS)
    scripts/build-client.mts   esbuild bundle → lib/client.js
    tests/*.spec.ts            carrier unit tests (fake bridge)
docs/                          architecture map
.agents/notes/                 Agent Notes (decision records)
```

## Running

```sh
pnpm install         # resolves @deepseek-ai/* from the dist-tags in upstream.json; pnpm-lock.yaml stays local (gitignored)
pnpm build           # compile the TypeScript sources (tsc → lib/dist, esbuild → lib/client.js, verify:upstream gate)
pnpm -r test         # headless boot proof + client carrier tests (no browser, no socket)
pnpm check           # strict type-check + tests for every package
pnpm start           # build, then launch the Electron app
```

Any plugin compiles from the root: `pnpm build` runs every workspace package's `build` script, and `pnpm --filter <plugin> build` targets one.

The core transport is verified headless (fake bridge + profile boot); the Electron window is the runnable shell over the same in-process host.

## Packaging

`dsh-plugin-desktop` ships installable artifacts through electron-builder, mirroring the `deepseek-harness-desktop` product layout:

```sh
pnpm package:dir      # unsigned unpacked app for the current host (dist/<platform>-unpacked)
pnpm dist:mac         # macOS DMG (on a macOS host)
pnpm dist:win         # Windows x64 NSIS installer (on a Windows host)
pnpm dist:linux       # Linux AppImage + deb (on a Linux host)
```

Every packaging run compiles the TypeScript sources (desktop `tsc` → `lib/`, connection `tsc` + esbuild client bundle, both gated by `verify:upstream`), then `scripts/materialize.mts` stages a self-contained payload (`dist-pack/` thin asar bootstrap + `dist-host/` runtime and flat dependency closure → `resources/host/`) — the layout used by `deepseek-harness/apps/desktop`. The closure ships as `extraResources` (real files), so the host resolves every plugin row by name from real directories instead of an asar-internal node_modules. The run finishes by booting the packaged `resources/host` headlessly (`verify:packaged`), asserting the socketless host and the renderer manifest compose from the real artifact. Installer targets build only on their native host; `package:dir` builds the current host anywhere. Artifacts land in `packages/dsh-plugin-desktop/dist/`. Code signing is off by default (`CSC_IDENTITY_AUTO_DISCOVERY=false`); set the certificate environment variables and drop that flag for a signed release.

### Linux sandbox

The unpacked app (`dist/linux-unpacked/dsh-desktop`) aborts at startup when the Chrome sandbox cannot initialize: the packaged `chrome-sandbox` is mode 0755, so a host without working user namespaces falls back to the SUID helper and Electron refuses to run. The `.deb` install is the robust path — its postinst sets `chrome-sandbox` mode 4755 when user namespaces are unavailable. For the unpacked directory, either run with `--no-sandbox` or make the helper setuid once:

```sh
./dsh-desktop --no-sandbox
sudo chown root:root dist/linux-unpacked/chrome-sandbox && sudo chmod 4755 dist/linux-unpacked/chrome-sandbox
```

## Model Experience

The desktop is a presentation and transport surface over the standard DeepSeek Harness agent. It changes no model-facing behavior: the same session log, tools, model route, and agent loop run underneath. The transport (Electron IPC instead of HTTP/WebSocket) and the socketless host are invisible to the model; model-visible inputs and outputs are unchanged.

## Known Limitations and Deferred Work

- The Electron shell is minimal: one window plus the IPC bridge. Tray, terminal, bundled pnpm, profile management, updates, and signed releases are deferred.
- The renderer `ConnectionController` is a pinned copy of the upstream source; `verify:upstream` fails the build when the installed family differs from the recorded version, forcing a reapply from the recorded commit.
- The desktop keeps a zero-socket host; the `deepseek-harness-desktop` project is the alternative loopback-carrier design for comparison.
