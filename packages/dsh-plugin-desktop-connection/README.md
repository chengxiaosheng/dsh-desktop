# dsh-plugin-desktop-connection

The desktop renderer connection: the `desktop-connection` row whose node half re-exports the official `@deepseek-ai/dsh-client-connection` apply unchanged, and whose client half provides `ctx.connection` over the Electron IPC bridge instead of HTTP/WebSocket.

## Entries

| Entry | Provides |
|---|---|
| `.` (`src/index.ts` → `dist/src/index.js`) | the official node half re-export: `HostConnectionService`, `/api` route, downlink upgrades |
| `./client` (built to `lib/client.js`) | the `ctx.connection` ConnectionHandle over `DshDesktopBridge` |

## Config

None. The row mounts with default config, matching the official connection row it replaces.

## Build

`pnpm build` runs three steps: `verify:upstream` (the pinned-copy gate), `tsc` over the node half (`src/index.ts` → `dist/src/index.js`), and esbuild over the client half (`src/client/entry.ts` → the self-contained `lib/client.js`, plus a `lib/client.d.ts` declaration for the bundle test). `pnpm check` adds a strict type-check of the sources, scripts, and tests.

## The renderer carrier

- `IpcApiClient extends AbstractApiClient` (from `@deepseek-ai/dsh-host-apiproxy/client`): `doFetch` → `bridge.invoke`; `openMux`/`openHost` → `bridge.subscribe`.
- `createDesktopConnectionRpc`: generic channels over `bridge.invoke` with rpcId correlation.
- `ConnectionController` (`src/client/controller.ts`): pinned copy of the upstream TypeScript source, restored verbatim except two documented mechanical adaptations (the `./api.ts` type import rewritten to `@deepseek-ai/dsh-host-apiproxy/api`, and the constructor's parameter properties spelled as explicit fields — parameter properties are not erasable syntax). Reapply whenever `verify:upstream` reports the installed family differs from the version recorded in `upstream.json`.
- `host-http.ts` — the virtual-host HTTP bridge: patches `globalThis.fetch` and intercepts anchor downloads so the renderer's host-origin requests dispatch over the bridge instead of the network. The upstream connection client and the `session-log-export` controller target the `http://dsh.internal` fallback base only on a literally-null origin; the desktop's `file://` page reports origin `"file://"` instead, so the bridge matches every `file://` (same-origin) request and the virtual host (`isDesktopHostUrl`), carrying method, headers, and body. This serves every host route in-process — the `session-log-export` download surface (HEAD probe + anchor download, ZIP back as base64, saved through a Blob URL) and any plugin's routes (e.g. the plugin market's `/dsh-market/*`) — via `{ type: 'http-request' }` IPC messages. External (non-host) requests and clicks pass through unchanged.
- The bundle registers through `window.__ModuleLoader__.load({ id, factory })`.

## The bridge contract

The preload bridge's `invoke` additionally accepts a raw host HTTP request: `{ type: 'http-request', method, path, search, headers?, body? }`. The Electron main answers with `{ status, headers, bodyBase64 }`: the `/api` plane dispatches through the in-process host's `toFetchHandler(apiProxy)`, and every other pathname dispatches through the full virtual `webServer` route registry (`match` → exact/prefix → fallback) with synthesized request/response stand-ins — so any plugin route works with no per-plugin bridge.

## Model Experience

No model-facing behavior: the carrier swaps the renderer↔host transport only. Model-visible inputs and outputs are unchanged.

## Known Limitations and Deferred Work

- Generic RPC cancellation is not propagated over the IPC bridge (`IpcApiClient.call` ignores its signal).
- The `ConnectionController` is a pinned copy; `verify:upstream` (run by `build`) fails when the installed family differs from the recorded version, and drift is covered by the integration tests.
- The `connection` row id is `desktop-connection` in the desktop composition, not `connection`.
