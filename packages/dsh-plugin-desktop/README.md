# dsh-plugin-desktop

The desktop shell package: the socketless `webServer` interceptor, the shell row, and the Electron main. See the [repository README](../README.md) and [architecture](../docs/architecture.md).

## Entries

All runtime sources are TypeScript; `pnpm build` compiles `src/` + `electron/` with `tsc` into `lib/` (the compiled paths below) and bundles the client half (`src/client/` → `lib/client.js`) with esbuild, and `pnpm check` adds a strict type-check of sources, scripts, and tests.

| Entry (source → compiled) | Provides |
|---|---|
| `dsh-plugin-desktop/webserver` (`src/webserver.ts` → `lib/src/webserver.js`) | `webServer` as `VirtualWebServer` — the official route-registry contract with no socket |
| `dsh-plugin-desktop` (default) (`src/index.ts` → `lib/src/index.js`) | the shell row: registers the durable `desktop` settings namespace (the close-window preference) |
| `dsh-plugin-desktop/client` (`src/client/` → `lib/client.js`) | the browser half: the General-settings close-behavior and restart-host rows, the `settings.desktop` locale dictionaries, and the preference policy — present only in the desktop composition |
| `electron/main.ts` → `lib/electron/main.js` | the Electron main: profile boot, `file://` page, IPC bridge (envelope RPC + raw virtual-host `http-request` download surface), the close-to-tray interception, and the tray |
| `electron/tray.ts` → `lib/electron/tray.js` | the system tray: always-visible show/restart/quit seat (labels published by the renderer from the `settings.desktop` locale dictionaries) |
| `electron/ipc.ts` → `lib/electron/ipc.js` | the bridge: envelope RPC + raw virtual-host `http-request` download dispatch + the `dsh:close-behavior` preference channel |
| `electron/boot-desktop.ts` → `lib/electron/boot-desktop.js` | headless-testable `bootDesktop` + `composeDesktopPatches` + `composeDesktopManifest` + the full-route `dispatchHttpRequest` (req/res stand-ins for in-process webserver dispatch) |
| `electron/desktop-services.ts` → `lib/electron/desktop-services.js` | the `desktopProfiles` + `desktopPnpm` host services (the plugin market's cross-environment contract) |
| `electron/package-root.ts` → `lib/electron/package-root.js` | shared package-root resolution for boot + services |
| `electron/preload.cts` → `lib/electron/preload.cjs` | the preload bridge (`__DSH_BOOT__` + `dshDesktop`), plain CJS by Electron's preload contract |

## Config

- `dsh-plugin-desktop/webserver` config: `{ host: '127.0.0.1', port: 0 }` — reported, never bound.
- The `desktop` settings namespace (`{ closeToTray: boolean }`, default `false`, applies live) owns the close-window behavior: `false` quits on window close, `true` hides to the tray. The settings row reads and writes it over the `dsh:close-behavior` bridge channel (the host ApiProxy's configuration-client allowlist does not serve the `desktop` namespace, so the main process mediates the write against the in-process provider); the Electron main reads the same value at window-close time.
- The tray menu labels (`show`/`restart`/`quit`) come from the `settings.desktop` locale dictionaries: the renderer publishes them over the `dsh:locale` channel at boot and on every locale change, so the tray matches the language the app displays; English stands until the first publication. The tray's "Restart host" item applies pending plugin changes through the same in-process reboot as the settings action.

## Model Experience

No model-facing behavior: the package changes the host transport only (socketless `webServer`, in-process `/api` dispatch, and the raw virtual-host `http-request` bridge that serves the session-log download). Model-visible inputs and outputs are unchanged.

## Virtual-host HTTP proxy

The renderer's patched fetch sends every `file://` (same-origin) and `http://dsh.internal` request over the bridge with method, headers, and body. `dispatchHttpRequest` dispatches through the full virtual `webServer` route registry (`match` → exact/prefix, then the fallback seat) with synthesized `IncomingMessage`/`ServerResponse` stand-ins and loopback `Origin`/`Host` (`127.0.0.1`) — so ANY plugin route dispatches in-process with no per-plugin bridge, and an exact route under `/api/*` (e.g. a plugin's endpoints) beats the connection's `/api` prefix exactly as the official server resolves it. The proven `/api` fast path (`toFetchHandler(apiProxy)`: unary RPC + the session-log download) serves the plane only when no exact route wins.

## Plugin market and desktop host services

The package depends on and mounts [dshmarket](https://github.com/dsh-market/dsh-market) (`dshmarket`, insert row `- id: dsh-market`), the in-app plugin market. `bootDesktop` registers the market's Desktop host contract before Loader entries mount: `desktopProfiles` (`{ current: { name: 'desktop', dir } }`) and `desktopPnpm`. `desktopPnpm.runPlugin` re-invokes the published `dsh plugin --profile desktop …` CLI under Electron's plain-Node mode (`ELECTRON_RUN_AS_NODE`), so pnpm and `dsh.profile.bundles` reconciliation happen through the ordinary DSH CLI; `desktopPnpm.run` runs pnpm directly. pnpm resolves from the system PATH — the bundled standalone binary is not shipped, so plugin installs require `pnpm` on the machine.

Plugins the market installs live in the profile's `node_modules`; the boot installs a profile-anchored `ctx.loader.internal` (`electron/loader-internal.ts`) so the Cordis loader resolves them at the next boot even under Electron, where the loader's native internal module loader is unavailable. Boot also self-heals a broken install: a bundle whose package or whose patch-referenced package cannot be resolved is dropped from `dsh.profile.bundles` (with a warning) so one bad plugin never prevents the app from opening.

## Host reboot

The settings General-section "Restart host" action (`dsh:reboot-host` channel) and the tray's "Restart host" item apply pending plugin changes by re-booting the host in-process: dispose the current generation (`ctx.fiber.dispose()`), `bootDesktop` again (new bundles compose), re-install the IPC bridge (`installIpc` returns a disposer), and reload the renderer. The Electron process, window, and tray stay up; the trigger is manual (auto-trigger waits on a durable pending-restart signal).

## Agent presets

`composeDesktopPatches` appends the shipped agent-preset root (`@deepseek-ai/dsh`'s `config/agent-presets`) to the `agent-presets` row, the same assembly the official CLI's `composeProfile` performs. Without it the roster resolves no presets and every session start fails with `preset "cordis" not found (available: none)`.

## Known Limitations and Deferred Work

- The tray always exists on every platform (a hidden window must always have a restore path); there is no setting to hide it.
- The shell is otherwise minimal (window + tray + IPC); terminal, profile management, updates, and installers are deferred.
- The host reboot is manual (a settings action); automatic reboot waits on a durable pending-restart signal from plugins.
- `VirtualWebServer` reimplements the official registry semantics (~90 lines) to avoid shipping-package changes; an upstream `listen: false` mode would retire it.
