# Agent Note: Desktop virtual-host WebSocket bridge over IPC

Status: implemented

English | [中文](2026-08-18-desktop-virtual-host-websocket-bridge.zh.md)

## Problem

The desktop's [virtual webserver interceptor](../architecture/2026-08-16-virtual-webserver-interceptor.md) mirrors the official `webServer` contract including `registerUpgrade`, but with no socket nothing ever dispatches an upgrade — a plugin that opens a browser WebSocket against the host has no server to reach. dsh-better-sidebar's terminal is the concrete case: its client builds `new WebSocket(new URL('/sidebar/ws/terminal', location.origin))` and swaps the protocol to `ws:`. On the desktop's `file://` page `location.origin` is `"file://"`, and the URL parser silently refuses the `file:` → `ws:` swap (a host-requiring special scheme cannot replace `file:` with an empty host), so the socket is constructed from a `file://` URL and throws `The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. 'file' is not allowed.` A correctly-schemed URL would still find no server.

## Decision

The renderer patches `window.WebSocket` (`dsh-plugin-desktop-connection` client, `host-websocket.ts`) so constructions targeting the desktop host surface ride the IPC bridge: any `file:`-derived URL (the only origin a `file://` page can produce) and any `ws(s)://dsh.internal` URL resolve to the virtual host and become a `DesktopWebSocket` shim — the browser WebSocket interface (readyState, on\* handlers, `send`, `close`, addEventListener, binaryType) over the preload bridge. Every other construction keeps the captured native constructor. The bridge contract grows four members on `DshDesktopBridge` (`wsOpen` invoke; `wsSend`/`wsClose` one-way; `onWsEvent` subscription), mirrored on the Electron main as `dsh:ws-open` / `dsh:ws-send` / `dsh:ws-close` / `dsh:ws-event`.

The upgrade-dispatch core — the bridge-backed `Duplex` (`BridgeSocket`), the synthesized `GET` upgrade request (`VirtualUpgradeRequest`), and `openVirtualHostSocket` — lives in `electron/virtual-host-socket.ts`, shared with the host-side `WebSocket` shim of the [host-side virtual-host transport](2026-08-18-desktop-host-side-virtual-host-transport.md); the IPC bridge (`electron/websocket-bridge.ts`) owns the renderer wiring. The main dispatches the upgrade in-process: it looks the pathname up in `webServer.upgrades`, synthesizes a `GET` upgrade request (loopback `Host`/`Origin`, fresh `Sec-WebSocket-Key`, optional `Sec-WebSocket-Protocol`) so the plugin's own trust fence passes, and hands the route a bridge-backed `Duplex` plus an empty head. The route's `wss.handleUpgrade` performs the real handshake and yields a real `ws` instance — the `ws` library owns the protocol inside the main process, so no socket, port, or frame codec is duplicated. The bridge locates the instance on the socket via `ws`'s private `kWebSocket` symbol (`Symbol('websocket')`, found by description) and relays message-level events:

- server→client data: frames the Sender writes into the socket are decoded (frames can arrive split across writes, so partial bytes are buffered) and pushed as `ws-message`;
- client→server data: pushed back as masked frames into the socket's readable side, which feeds the `ws` receiver exactly like a real client;
- a server close frame is echoed as a masked close frame so the closing handshake completes immediately (ws would otherwise wait out its 30 s closeTimeout for a peer close frame that never comes) and the resulting `close` event carries the server's real code and reason;
- a renderer-initiated close pushes a masked close frame and lets the handshake complete with the renderer's code; a close racing the open is remembered and tears the socket down the moment it exists.

Every open socket is bound to the renderer context that opened it: a main-frame navigation or a destroyed web contents terminates the sockets, which the plugin's own `close` handlers treat as a bare socket drop (ptys keep their reconnect grace). `installIpc`'s disposer disposes the bridge, so an in-process host reboot tears everything down with the generation.

## Wire contract

The four message shapes are declared twice — `DesktopWsOpenRequest` / `DesktopWsOpenResult` / `DesktopWsEvent` in the connection client's `ipc-api-client.ts`, mirrored verbatim in the desktop package's `electron/websocket-bridge.ts` — following the repo convention that each end of the bridge owns its copy of the contract.

## Alternatives considered

**Run a real loopback WebSocket server in the main process.** The zero-socket desktop excludes any listening socket, and the socketless contract is what lets the boot proof run headless.

**Decode frames in the renderer shim (a full client-side WebSocket implementation).** Duplicates the wire protocol (masking, length encoding, fragmentation, UTF-8 validation) that `ws` already implements, and moves the trust boundary into the renderer.

**Tunnel raw bytes bidirectionally and let the renderer speak the wire protocol.** Same duplication, plus the renderer would need to validate the handshake itself.

**Fix the plugin upstream instead.** dsh-better-sidebar's URL builder could avoid `file:`-derived URLs, but the desktop still has no WebSocket server to connect to, so the plugin would merely throw a different error; the gap is the desktop's upgrade dispatch, which this bridge closes for every plugin.

**Reply to the invoke only after the upgrade settles.** The handler writes (a terminal transcript replay) before the open reply lands; the shim buffers messages received while connecting, so the open reply can race the first messages safely.

## Consequences

The `registerUpgrade` half of the virtual webserver contract is now served: plugins that open host WebSockets (terminals, push streams) work in the desktop without any plugin change, and the bridge stays socketless. The costs: the main process owns a frame decoder (only server→client frames; close frames are echoed, ping/pong are dropped) and depends on `ws`'s private `kWebSocket` symbol by description — if a future `ws` renames it, opens fail with "websocket upgrade did not complete", degraded but visible. The shim is an interface emulation, not a byte-exact replica: `instanceof WebSocket` does not hold for shim instances (the plugin under test never uses it), `protocol` and `extensions` report empty, and permessage-deflate is never negotiated (the renderer sends no `Sec-WebSocket-Extensions`, so compressed frames never occur). A `file:`-scheme WebSocket is by definition host work — the desktop has no other server surface — so every such construction is diverted, matching the HTTP bridge's same-origin rule.

## Testing

`packages/dsh-plugin-desktop/tests/websocket-bridge.spec.ts` boots a minimal in-process host (cordis context + virtual webserver + a better-sidebar-style `WebSocketServer({ noServer: true })` upgrade route) and drives the full relay: open, server→client data, client→server data, server-initiated close with code/reason, client-initiated close, refusals, and teardown. `packages/dsh-plugin-desktop-connection/tests/host-websocket.spec.ts` covers the shim state machine (open/refuse/buffer/close/send/patch) against a fake bridge. Both run headless in the existing suites; the boot proof still boots with no socket.
