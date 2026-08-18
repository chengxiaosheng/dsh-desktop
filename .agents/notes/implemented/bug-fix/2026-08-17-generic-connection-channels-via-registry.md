# Agent Note: Generic connection channels dispatch through the webserver registry

Status: implemented

English | [中文](2026-08-17-generic-connection-channels-via-registry.zh.md)

## Problem

Plugins that open a generic connection channel — `@huanlin/dsh-plugin-mineru`'s `/mineru-api` via `connection.rpc.call("/mineru-api", …)`, dsh-remote's `/remote` — spammed `TypeError: connection.dispatch is not a function` in the Electron main. The renderer's generic-channel RPC is an envelope POST to `<channel>/<endpoint>`, and the desktop's `dsh:invoke` handler routed every non-`/api` `client-request` to `connection.dispatch` — a method the rc.6 `HostConnectionService` does not provide. A second defect: the channel route handlers run the connection's `bridge` helper, which calls `res.on("close")` and reads `res.writableEnded`, so even reaching a channel route failed with `res.on is not a function` on the synthesized `ServerResponse`.

## Decision

Generic connection channels are served by webServer **prefix routes** — that is how the official `HostConnectionService.register` mounts a channel (`ctx.webServer.register({ kind: 'prefix', path: channel, … })`, the `rpcFetchHandler` answering each request). The `dsh:invoke` handler now routes a non-`/api` `client-request` envelope through `dispatchHttpRequest` as a POST to the channel path (the full-registry dispatch, same as any plugin route) and returns the parsed server-response envelope. The synthesized response (`VirtualResponse`) now extends `EventEmitter` and carries the `writableEnded` flag plus `destroy()` (emitting `finish`/`close`), and the request stand-in gained a `destroy()` no-op, so the connection's `bridge` helper runs unchanged against the stand-ins.

## Alternatives considered

**Implementing `dispatch` on the host.** The rc.6 runtime lacks the method; routing through the existing webServer channel routes is the official mechanism and needs no new host surface.

**Stubbing the missing `dispatch` to return not-found.** Would silence the spam but leave the channel feature dead; the registry route already serves it.

## Consequences

Generic-channel plugins (mineru, dsh-remote) work in the desktop: their channel RPCs reach the registered handler and return structured server-responses (verified headlessly against the real profile; the packaged host still boots). Costs: the `dispatch` leg is removed from the desktop transport surface (documented on `DesktopHostConnection`), and the synthesized response is now an EventEmitter — the long-lived streaming/SSE surface remains outside the request/response bridge.
