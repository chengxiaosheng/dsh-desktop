# Agent Note: Desktop renderer connection provided by a desktop client plugin over Electron IPC

Status: implemented

English | [中文](2026-08-16-desktop-client-connection-plugin.zh.md)

## Problem

The desktop product runs the full Web UI with no Node HTTP server and no port. The host side is already socketless — the [virtual webserver interceptor](../architecture/2026-08-16-virtual-webserver-interceptor.md) provides the `webServer` service without binding a socket, and the official `connection` and `modules` node halves mount unchanged against it. The renderer still needs a wire client: over `file://` the official `@deepseek-ai/dsh-client-connection` client half (`WebApiClient`, HTTP + WebSocket) has no server to reach. The desktop must provide `ctx.connection` over an Electron IPC bridge instead.

## Decision

The desktop composition disables the official `connection` row and mounts `dsh-plugin-desktop-connection` as a new `desktop-connection` row. A patch layer cannot change a row's package name (the `name` field on a patch is a guard, not a rename), so the replacement is disable-plus-insert rather than rename.

- **Node half** (`dsh-plugin-desktop-connection` `src/index.ts`) re-exports the official `@deepseek-ai/dsh-client-connection` apply unchanged: `HostConnectionService`, the `/api` prefix route, and the two downlink upgrade routes behave exactly as the web profile's, mounted against the virtual `webServer`.
- **Client half** (built to `lib/client.js`, declared by `dsh.client`, served by `exports["./client"]`) bundles an `IpcApiClient` — an `AbstractApiClient` subclass whose `doFetch` routes unary/respond through the preload bridge's `invoke` and whose `openMux`/`openHost` pump the two downlink streams through the bridge's `subscribe` — plus a pinned copy of the official `ConnectionController` (carrier-agnostic: its constructor takes the `IApiClient` face), and provides the standard `ctx.connection` ConnectionHandle. The bridge contract (`DshDesktopBridge`) is the only Electron dependency the carrier knows. The same client bundle carries the virtual-host HTTP bridge, which routes every `file://` and `http://dsh.internal` request — the session-log download surface and every plugin route (`/dsh-market/*`) — over the bridge; see the [download bridge note](../bug-fix/2026-08-16-desktop-session-log-download.md) and the [plugin market integration note](2026-08-17-plugin-market-transport-and-services.md).

The `dsh.client` declaration lives only on `dsh-plugin-desktop-connection`, and that package is referenced by exactly one row, because the client-modules table keys by entry name without per-package deduplication — a package declared by several rows would emit its client bundle once per row, and two providers of `connection` in one scope would be rejected by Cordis (`service "connection" has been registered`).

The Electron main boots the profile in-process, composes the boot graph from `clientModules.graph()` rewriting every bundle URL to an absolute `file://` path, and fronts the transport over IPC: `ipcMain.handle('dsh:invoke')` dispatches unary/respond through `connection.createSharedFetchHandler` plus `toFetchHandler(apiProxy)`, and `dsh:subscribe`/`dsh:unsubscribe` pump `apiProxy.events.mux`/`host` to the renderer. The preload exposes `window.__DSH_BOOT__` (sendSync) and `window.dshDesktop` through `contextBridge`.

## Alternatives considered

**Modify the official `connection` client apply to select the IPC carrier.** The `feat/desktop-electron` branch took this route (a `window.dshDesktop` branch in the connection client). It changes a shipped package, which the [published-packages boundary](../process/2026-08-16-upstream-as-published-packages.md) forbids here.

**Patch the published `@deepseek-ai/dsh-client-connection` artifact.** The `deepseek-harness-desktop` project patches npm artifacts for packaging bugs, but injecting an IPC carrier into the bundled client would pin the desktop to a bundle layout and drift on every upstream bump.

**Provide `connection` alongside the official row.** Cordis rejects two providers of one service in the same scope, and the browser half ships through the same row as the node half — there is no per-half disable.

**Keep the official HTTP/WebSocket carrier on a loopback socket.** This is the `deepseek-harness-desktop` design: zero package changes but a listening socket, which the zero-socket desktop excludes.

## Consequences

The renderer gets a working wire client with no socket and no shipped-package change; the node half stays byte-identical to upstream. The costs: the `ConnectionController` is a pinned copy (reapply from the upstream source on a runtime family bump, tracked in its header), the desktop bundle re-embeds `@deepseek-ai/dsh-host-apiproxy` modules, and the `connection` row's id changes to `desktop-connection` in the desktop composition. The `dsh.client`-single-row constraint is a documented composition invariant.
