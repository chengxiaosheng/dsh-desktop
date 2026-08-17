# dsh-plugin-desktop

The desktop shell package: the socketless `webServer` interceptor, the shell row, and the Electron main. See the [repository README](../README.md) and [architecture](../docs/architecture.md).

## Entries

All runtime sources are TypeScript; `pnpm build` compiles `src/` + `electron/` with `tsc` into `lib/` (the compiled paths below) and bundles the client half (`src/client/` → `lib/client.js`) with esbuild, and `pnpm check` adds a strict type-check of sources, scripts, and tests.

| Entry (source → compiled) | Provides |
|---|---|
| `dsh-plugin-desktop/webserver` (`src/webserver.ts` → `lib/src/webserver.js`) | `webServer` as `VirtualWebServer` — the official route-registry contract with no socket |
| `dsh-plugin-desktop` (default) (`src/index.ts` → `lib/src/index.js`) | the shell row: registers the durable `desktop` settings namespace (the close-window preference) |
| `dsh-plugin-desktop/client` (`src/client/` → `lib/client.js`) | the browser half: the General-settings close-behavior row, its `settings.desktop` locale dictionaries, and the preference policy — present only in the desktop composition |
| `electron/main.ts` → `lib/electron/main.js` | the Electron main: profile boot, `file://` page, IPC bridge (envelope RPC + raw virtual-host `http-request` download surface), the close-to-tray interception, and the tray |
| `electron/tray.ts` → `lib/electron/tray.js` | the system tray: always-visible show/quit seat (labels published by the renderer from the `settings.desktop` locale dictionaries) |
| `electron/ipc.ts` → `lib/electron/ipc.js` | the bridge: envelope RPC + raw virtual-host `http-request` download dispatch + the `dsh:close-behavior` preference channel |
| `electron/boot-desktop.ts` → `lib/electron/boot-desktop.js` | headless-testable `bootDesktop` + `composeDesktopPatches` + `composeDesktopManifest` + `dispatchHttpRequest` |
| `electron/preload.cts` → `lib/electron/preload.cjs` | the preload bridge (`__DSH_BOOT__` + `dshDesktop`), plain CJS by Electron's preload contract |

## Config

- `dsh-plugin-desktop/webserver` config: `{ host: '127.0.0.1', port: 0 }` — reported, never bound.
- The `desktop` settings namespace (`{ closeToTray: boolean }`, default `false`, applies live) owns the close-window behavior: `false` quits on window close, `true` hides to the tray. The settings row reads and writes it over the `dsh:close-behavior` bridge channel (the host ApiProxy's configuration-client allowlist does not serve the `desktop` namespace, so the main process mediates the write against the in-process provider); the Electron main reads the same value at window-close time.
- The tray menu labels (`show`/`quit`) come from the `settings.desktop` locale dictionaries: the renderer publishes them over the `dsh:locale` channel at boot and on every locale change, so the tray matches the language the app displays; English stands until the first publication.

## Model Experience

No model-facing behavior: the package changes the host transport only (socketless `webServer`, in-process `/api` dispatch, and the raw virtual-host `http-request` bridge that serves the session-log download). Model-visible inputs and outputs are unchanged.

## Session-log download

`dispatchHttpRequest` answers the renderer's raw `{ type: 'http-request' }` bridge messages (sent by the `dsh-plugin-desktop-connection` virtual-host bridge for the `session-log-export` HEAD probe and anchor download) through the in-process `toFetchHandler(apiProxy)`. It serves only `GET`/`HEAD` under `/api/`, so the desktop's `/export` command and the Session-header download button stream the same ZIP the web server would, with no socket.

## Agent presets

`composeDesktopPatches` appends the shipped agent-preset root (`@deepseek-ai/dsh`'s `config/agent-presets`) to the `agent-presets` row, the same assembly the official CLI's `composeProfile` performs. Without it the roster resolves no presets and every session start fails with `preset "cordis" not found (available: none)`.

## Known Limitations and Deferred Work

- The tray always exists on every platform (a hidden window must always have a restore path); there is no setting to hide it.
- The shell is otherwise minimal (window + tray + IPC); terminal, bundled pnpm, profiles, updates, and installers are deferred.
- `VirtualWebServer` reimplements the official registry semantics (~90 lines) to avoid shipping-package changes; an upstream `listen: false` mode would retire it.
