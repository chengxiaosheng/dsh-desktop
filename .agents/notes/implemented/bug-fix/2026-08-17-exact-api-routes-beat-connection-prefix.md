# Agent Note: Exact `/api` plugin routes beat the connection's `/api` prefix in the in-process dispatch

Status: implemented

English | [中文](2026-08-17-exact-api-routes-beat-connection-prefix.zh.md)

## Problem

`dispatchHttpRequest` short-circuited every `/api/*` request to the composed `toFetchHandler(apiProxy)` fast path before consulting the webserver route registry. Plugins that register **exact** routes under `/api/*` — e.g. dsh-usage-stats' `/api/usage-stats/usage`, `/providers`, `/balance` — were shadowed: the official server resolves exact-over-prefix, so those routes never answered and the desktop returned 404. A second, independent defect: the synthesized `Host` header carried the virtual-host name (`dsh.internal`), which fails plugin loopback fences — dsh-usage-stats' `rejectForeignCaller` demands a loopback Host, mirroring the official server's `127.0.0.1:<port>` requests.

## Decision

`dispatchHttpRequest` now consults `webServer.match` (exact → prefix) first and dispatches any route that is not the connection's own `/api` prefix route. The proven `/api` fast path is kept only when the match IS the connection's `/api` prefix (a route-less `/api/*` path) — preserving the session-log download and unary RPC surfaces with their existing behavior. Unmatched non-`/api` paths still fall to the SPA fallback seat. The synthesized `Origin`/`Host` now carry a loopback identity (`http://127.0.0.1` / `127.0.0.1`), satisfying both the market's `sameOrigin()` and plugin loopback fences.

## Alternatives considered

**Mounting the fast path as a real `/api` prefix route and dispatching everything through the registry.** Semantically equivalent, but it would move the proven session-log surface onto the registry's req/res stand-ins; the guarded fast path keeps that surface byte-identical.

**Synthesizing `localhost`.** Works, but `127.0.0.1` matches the official server's actual loopback bind.

## Consequences

Plugins with `/api/*` routes answer in the desktop (verified against a profile with dsh-usage-stats: usage/providers/balance return 200 with real data, method rejection 405; the market and session-log surfaces are unchanged; the packaged host still boots). Costs: dispatch correctness now depends on `webServer.match`'s exact-over-prefix ordering and the loopback header synthesis — both asserted by the boot regression test (`/api/probe-route` wins over the fast path; a route-less `/api/*` still reaches the apiProxy plane).
