# dsh-plugin-desktop

The desktop shell package: the socketless `webServer` interceptor, the shell row, and the Electron main. See the [repository README](../README.md) and [architecture](../docs/architecture.md).

## Entries

All runtime sources are TypeScript; `pnpm build` compiles `src/` + `electron/` with `tsc` into `lib/` (the compiled paths below), and `pnpm check` adds a strict type-check of sources, scripts, and tests.

| Entry (source → compiled) | Provides |
|---|---|
| `dsh-plugin-desktop/webserver` (`src/webserver.ts` → `lib/src/webserver.js`) | `webServer` as `VirtualWebServer` — the official route-registry contract with no socket |
| `dsh-plugin-desktop` (default) (`src/index.ts` → `lib/src/index.js`) | the shell row (placeholder for native lifecycle) |
| `electron/main.ts` → `lib/electron/main.js` | the Electron main: profile boot, `file://` page, IPC bridge (envelope RPC + raw virtual-host `http-request` download surface) |
| `electron/boot-desktop.ts` → `lib/electron/boot-desktop.js` | headless-testable `bootDesktop` + `composeDesktopPatches` + `composeDesktopManifest` + `dispatchHttpRequest` |
| `electron/preload.cts` → `lib/electron/preload.cjs` | the preload bridge (`__DSH_BOOT__` + `dshDesktop`), plain CJS by Electron's preload contract |

## Config

- `dsh-plugin-desktop/webserver` config: `{ host: '127.0.0.1', port: 0 }` — reported, never bound.

## Model Experience

No model-facing behavior: the package changes the host transport only (socketless `webServer`, in-process `/api` dispatch, and the raw virtual-host `http-request` bridge that serves the session-log download). Model-visible inputs and outputs are unchanged.

## Session-log download

`dispatchHttpRequest` answers the renderer's raw `{ type: 'http-request' }` bridge messages (sent by the `dsh-plugin-desktop-connection` virtual-host bridge for the `session-log-export` HEAD probe and anchor download) through the in-process `toFetchHandler(apiProxy)`. It serves only `GET`/`HEAD` under `/api/`, so the desktop's `/export` command and the Session-header download button stream the same ZIP the web server would, with no socket.

## Agent presets

`composeDesktopPatches` appends the shipped agent-preset root (`@deepseek-ai/dsh`'s `config/agent-presets`) to the `agent-presets` row, the same assembly the official CLI's `composeProfile` performs. Without it the roster resolves no presets and every session start fails with `preset "cordis" not found (available: none)`.

## Known Limitations and Deferred Work

- The Electron shell is minimal (window + IPC); tray, terminal, bundled pnpm, profiles, updates, and installers are deferred.
- `VirtualWebServer` reimplements the official registry semantics (~90 lines) to avoid shipping-package changes; an upstream `listen: false` mode would retire it.
