# Agent Note: Host-side virtual-host transport (fetch/WebSocket over the reported webServer port)

Status: implemented

English | [中文](2026-08-18-desktop-host-side-virtual-host-transport.zh.md)

## Problem

The desktop's [virtual webserver interceptor](../architecture/2026-08-16-virtual-webserver-interceptor.md) is socketless, and its in-process dispatch only ever serves the renderer's patched `fetch`/`WebSocket` over IPC. A third-party plugin that reads `webServer.port` to build a harness base URL and makes host-side calls from the Electron main process has no server to reach and no bridge to ride. `@xmanrui/dsh-im` is the concrete case: its apply-time check requires `webServer.port` in `[1, 65535]` and, with the virtual webserver reporting `port: 0`, threw `dsh-feishu requires an initialized DSH webServer port` — which aborted the whole plugin tree and stopped the desktop from opening. This is not a dsh-im bug: any plugin that treats the reported host/port as a reachable harness surface hits the same wall.

## Decision

The desktop serves its virtual host to host-side code as a general compatibility surface, keyed on the virtual-host identity alone — no plugin-specific code anywhere.

**Virtual port identity.** `VirtualWebServer.port` reports `VIRTUAL_HOST_PORT` (`51470`, `src/webserver.ts`) when the config carries `port: 0` (the literal "no real port"). Deliberately distinct from the DSH GUI's real `3080`, so the two loopback identities never collide. The host-side bridge matches whatever `webServer.port` reports, so a profile override that sets a nonzero port stays in sync automatically.

**Host-side virtual-host transport** (`electron/host-bridge.ts`), installed by `bootDesktop` in its `prepare` hook — before Loader entries apply, because a plugin's `fetch`/`WebSocket` reference is captured at construction time — and registered as a context effect so fiber dispose (including the in-process host reboot) restores the process globals:

- `globalThis.fetch` is patched: any URL on the virtual host identity — loopback (`127.0.0.1`, `::1`, `localhost`) on the reported port, or the `dsh.internal` name — dispatches through `dispatchHttpRequest`; every other URL passes through to the real fetch unchanged.
- `globalThis.WebSocket` is patched with a `HostVirtualSocket` shim: matching URLs run the registered upgrade route in-process through the shared socket core and expose the browser WebSocket surface (`readyState`, `on*`, `send`, `close`, `addEventListener`, `binaryType`); every other construction returns the native WebSocket. Messages arriving before `open` are buffered and flushed after, matching real socket semantics.

**`/api` fast path fixed.** `dispatchHttpRequest`'s `/api` plane now forwards method/headers/body into the shared fetch handler instead of a bare `new Request(target, { method })`, so a host-side RPC client's `client-request`/`client-response` envelope is parsed exactly as the renderer carrier's is (previously the body was dropped and the RPC answered 415).

**Shared socket core.** The in-process upgrade dispatch was extracted from the IPC websocket bridge into `electron/virtual-host-socket.ts` (`BridgeSocket`, `VirtualUpgradeRequest`, `openVirtualHostSocket`), shared by the renderer IPC bridge and the host-side `WebSocket` shim — one frame decoder, one trust boundary.

## Wire contract

The host-side transport is not a wire protocol: it patches the process's standard web APIs so the harness surface appears where plugins already look. The only observable contract change is `webServer.port` reporting a nonzero virtual port when configured at `0`.

## Alternatives considered

**Run a real loopback HTTP/WebSocket server on the virtual port.** The only answer that also covers raw `node:http`/`axios` clients, but a listening socket, which the zero-socket contract excludes; the fetch+WebSocket web-API surface covers the actual clients (dsh-im's HarnessClient uses `fetch`, its interaction stream opens `ws://…/api/events.mux`).

**Patch `node:http`/`https` (axios, got) in the main process too.** Even more invasive global patching for a transport no known plugin uses; deferred. Raw `http.request`-only clients remain a documented gap whose fallback is the loopback server above.

**Configure dsh-im with a `harnessBaseUrl`.** A per-plugin workaround, and the desktop has no way to serve that URL to host-side code anyway; not general.

**Make dsh-im tolerate `port: 0` upstream.** Not the desktop's change to make, and tolerating the check without serving the calls only trades an apply-time crash for a silent retry loop.

## Consequences

**Bought:** any plugin that reaches the harness over `webServer.port` with the standard web APIs now works in the desktop unchanged — dsh-im loads, applies all nine integrations, and its HarnessClient's health/RPC round-trips are served in-process (verified end-to-end against a profile with dsh-im installed: boot succeeds, `host.describe` answers 200 through the bridge, no dsh-im retry warnings). The bridge is general and stays socketless, so the headless boot proof still binds nothing.

**Cost:** the Electron main patches two process globals, scoped strictly by the virtual-host match rule — a mis-scoped match would divert unrelated host traffic. `HostVirtualSocket` is an interface emulation like the renderer shim (no `instanceof WebSocket`, no permessage-deflate, empty `protocol`/`extensions`). The `/api` fast path now reads request bodies, so a very large body could add buffering cost that the old bare dispatch avoided.

## Testing

`packages/dsh-plugin-desktop/tests/host-bridge.spec.ts` boots the real desktop profile and verifies: the reported virtual port; the virtual-host match rule; a host-side `fetch` to the virtual host round-tripping the full `/api` RPC envelope in-process; non-matching URLs passing through to the real fetch; a host-side `WebSocket` to a registered `ws` upgrade route (open, server→client, client→server, server close); and global restoration on fiber dispose. The refactored IPC websocket bridge keeps its own suite green, and the boot proof still runs with no socket.
