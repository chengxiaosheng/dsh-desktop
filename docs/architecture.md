# DSH Desktop Architecture

Read this before changing `packages/dsh-plugin-desktop/` or `packages/dsh-plugin-desktop-connection/`.

## Cordis and the plugin composition

The desktop is a Cordis plugin tree composed at boot from ordered layers, exactly like the DeepSeek Harness it wraps. Every capability — the socketless webserver, the renderer wire client, the shell — is a plugin row mounted by a patch layer, so each is replaceable from configuration without changing any published package.

The desktop runtime depends on **published** `@deepseek-ai/*` npm packages resolved from the dist-tags recorded in [`upstream.json`](../upstream.json) (`next` for the dsh family, `latest` for the cordis framework); `pnpm-lock.yaml` is not committed, so `pnpm install` resolves the tags fresh. There is no upstream source checkout in this repository.

## The zero-socket transport

The desktop product runs the full Web UI with no Node HTTP server and no port:

- **Virtual webserver** (`dsh-plugin-desktop/webserver`): provides the `webServer` service with the official route-registry contract but never binds a socket, so the official `connection` and `modules` rows mount unchanged.
- **Renderer wire client** (`dsh-plugin-desktop-connection`): the desktop composition disables the official `connection` row and mounts the desktop package as `desktop-connection`. Its node half re-exports the official `@deepseek-ai/dsh-client-connection` apply unchanged; its client half provides `ctx.connection` over an Electron IPC bridge instead of HTTP/WebSocket.
- **Boot manifest over `file://`**: the Electron main composes the client graph and rewrites every bundle URL to an absolute `file://` path; the preload exposes it as `window.__DSH_BOOT__` before page scripts run.
- **In-process dispatch**: unary `/api` calls dispatch through `connection.createSharedFetchHandler` + `toFetchHandler(apiProxy)`; the two downlink streams pump `apiProxy.events.mux` / `apiProxy.events.host` to the renderer over IPC.
- **Virtual-host download bridge**: the `session-log-export` controller calls its host base with native `fetch` plus an anchor download. On the desktop's `file://` page Electron reports `location.origin` as `"file://"` (not the string `"null"`), so the controller builds `file:///api/...` URLs instead of the upstream `http://dsh.internal` fallback; neither host has an HTTP server. The renderer connection patches `globalThis.fetch`, intercepts DOM and detached anchor clicks (`patchAnchorClick`), and routes `{ type: 'http-request' }` messages for either host form over the bridge; the main answers through `dispatchHttpRequest` against the same in-process `toFetchHandler(apiProxy)`, so the session-log ZIP downloads with no socket.

## Packages

| Package | Owns | `ctx` key |
|---|---|---|
| `dsh-plugin-desktop` | The desktop shell row, the virtual `webServer` provider, and the Electron main | `webServer` |
| `dsh-plugin-desktop-connection` | The `desktop-connection` row: official node half re-export + IPC renderer carrier | `connection` (client) |

## Composition invariants

- `dsh.client` is declared only on `dsh-plugin-desktop-connection`, and that package is referenced by exactly one row: the client-modules table keys by entry name without per-package deduplication, so a package on several rows would emit its client bundle once per row, and Cordis rejects two providers of `connection` in one scope.
- A patch layer cannot change a row's package name (the `name` field on a patch is a guard, not a rename); row replacement is disable-plus-insert.

## Extension points

- Rows are patchable from `cordis.patch.yml` and the user's profile `cordis.patch.yml`.
- The renderer bridge contract (`DshDesktopBridge`) is the only Electron dependency the connection carrier knows; the Electron main implements it.
- The Electron shell (window, tray, terminal, updates) grows as desktop-owned rows in `dsh-plugin-desktop`.

## Upstream provenance

`upstream.json` records the dist-tags the runtime family resolves from (`next` for the dsh family, `latest` for the cordis framework) and the provenance of the pinned `ConnectionController` copy independently: the source version it was taken from, the upstream commit for that version, and the upstream `sourcePath` to re-apply from. `pnpm-lock.yaml` is not committed, so `pnpm install` resolves the dist-tags fresh and an upstream release flows in on the next install. The pinned `ConnectionController` copy in `dsh-plugin-desktop-connection` re-applies from the upstream source (`sourcePath` at the recorded commit) whenever `verify:upstream` reports the installed `@deepseek-ai/dsh-client-connection` differs from the recorded version.
