# dsh-plugin-desktop-connection

The desktop renderer connection: the `desktop-connection` row whose node half re-exports the official `@deepseek-ai/dsh-client-connection` apply unchanged, and whose client half provides `ctx.connection` over the Electron IPC bridge instead of HTTP/WebSocket.

## Entries

| Entry | Provides |
|---|---|
| `.` (default) | the official node half re-export: `HostConnectionService`, `/api` route, downlink upgrades |
| `./client` (built to `lib/client.js`) | the `ctx.connection` ConnectionHandle over `DshDesktopBridge` |

## Config

None. The row mounts with default config, matching the official connection row it replaces.

## The renderer carrier

- `IpcApiClient extends AbstractApiClient` (from `@deepseek-ai/dsh-host-apiproxy/client`): `doFetch` → `bridge.invoke`; `openMux`/`openHost` → `bridge.subscribe`.
- `createDesktopConnectionRpc`: generic channels over `bridge.invoke` with rpcId correlation.
- `ConnectionController`: pinned copy of the upstream source (carrier-agnostic), reapply on a runtime family bump.
- `host-http.js` — the virtual-host HTTP bridge: patches `globalThis.fetch` and intercepts anchor downloads so the renderer's native host-origin requests dispatch over the bridge instead of the network. The upstream connection client and the `session-log-export` controller target the `http://dsh.internal` fallback base only on a literally-null origin; the desktop's `file://` page reports origin `"file://"` instead, so the bridge matches both the virtual host and the `file:///api/` plane (`isDesktopHostUrl`). This serves the `session-log-export` download surface in-process: the HEAD probe and the follow-up anchor download both route to the host via `{ type: 'http-request' }` IPC messages, and the ZIP travels back as base64 and is saved through a Blob URL. Non-virtual-host requests and clicks pass through unchanged.
- The bundle registers through `window.__ModuleLoader__.load({ id, factory })`.

## The bridge contract

The preload bridge's `invoke` additionally accepts a raw host HTTP request: `{ type: 'http-request', method: 'GET' | 'HEAD', path, search }`. The Electron main answers with `{ status, headers, bodyBase64 }`, dispatching through the in-process host's `toFetchHandler(apiProxy)`. Only the `/api/` GET/HEAD download surface is served; other methods and paths are refused so the bridge cannot reach beyond the composed `/api` plane.

## Model Experience

No model-facing behavior: the carrier swaps the renderer↔host transport only. Model-visible inputs and outputs are unchanged.

## Known Limitations and Deferred Work

- Generic RPC cancellation is not propagated over the IPC bridge (`IpcApiClient.call` ignores its signal).
- The `ConnectionController` is a pinned copy; drift is tracked by the reapply note in its header and covered by the integration tests.
- The `connection` row id is `desktop-connection` in the desktop composition, not `connection`.
