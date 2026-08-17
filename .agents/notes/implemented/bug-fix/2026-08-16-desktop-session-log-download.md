# Agent Note: Desktop virtual-host bridge serves the session-log download in-process

Status: implemented

English | [中文](2026-08-16-desktop-session-log-download.zh.md)

## Problem

The Session-header download button and the `/export` command fail with "Session 导出失败 / Failed to fetch". The official `session-log-export` client controller probes the host with native `fetch(new URL('/api/session.export', hostBase()), { method: 'HEAD' })` and then hands the same URL to the browser download manager through an anchor. `hostBase()` returns `location.origin` unless that is the string `"null"`, falling back to `http://dsh.internal`. The desktop page loads from `file://`, and Electron's Chromium reports `location.origin` as `"file://"` — not `"null"` — so the fallback never triggers and the controller builds `file:///api/session.export?...` URLs. The zero-socket desktop has no HTTP server for either host, so the HEAD probe rejects with "Failed to fetch"; the follow-up anchor download would then navigate the SPA away, because the `download` attribute is ignored off same-origin.

## Decision

The desktop connection renderer plugin (`dsh-plugin-desktop-connection`) installs a virtual-host HTTP bridge as `ctx.effect` contributions. `patchFetch` wraps `globalThis.fetch` so every request targeting the desktop's in-process host surface — `http://dsh.internal` (the upstream null-origin fallback) or the `/api/` plane of the `file://` origin the controller actually builds — dispatches over the preload bridge as `{ type: 'http-request', method, path, search }`. `patchDownloadClicks` intercepts capture-phase anchor clicks whose href targets that surface, prevents the default navigation, and downloads the target; `patchAnchorClick` patches `HTMLAnchorElement.prototype.click` because the controller clicks a **detached** anchor (never in the DOM), whose click event never reaches a `document` listener. The Electron main's `dsh:invoke` routes `http-request` messages to `dispatchHttpRequest` in `boot-desktop.js`, which answers through `connection.createSharedFetchHandler` plus `toFetchHandler(apiProxy)` — the same in-process dispatch the envelope RPC uses — returning `{ status, headers, bodyBase64 }`. The renderer rebuilds a `Response` for the HEAD probe and saves the GET body through a Blob URL. Only `GET`/`HEAD` under `/api/` are served; other methods and paths are refused so the bridge cannot reach beyond the composed `/api` plane. The flow is headless-tested: bridge unit tests (HEAD probe for both host forms, GET body, detached and DOM anchor-click interception, foreign pass-through) and `dispatchHttpRequest` tests against the booted desktop host (400 missing sessionId, 404 unknown session with body, 404 non-`/api`, 405 method).

## Alternatives considered

**Serve the SPA over a privileged custom scheme with `protocol.handle`.** Fetch and anchor downloads both resolve through one handler, but it rewrites the documented `file://` boot manifest and intercepts the whole scheme — a large surface change for one download.

**Intercept the `http` scheme in the main process for the virtual host, delegating other hosts to `net.fetch`.** Handles the anchor download natively, but global `http` interception is broad and risks the renderer's legitimate external fetches.

**Patch the upstream `session-log-export` controller to inject a fetcher/save pair.** The [published-packages boundary](../process/2026-08-16-upstream-as-published-packages.md) forbids shipped-package changes, and the controller is constructed with defaults inside upstream client code.

## Consequences

The download surface works with no socket and no shipped-package change: the HEAD probe and the anchor download both dispatch in-process, and the ZIP is saved through a Blob URL. Costs: the ZIP crosses IPC as base64 and is fully buffered in the main process (the web server streams instead), the bridge patches browser globals (`globalThis.fetch` and `HTMLAnchorElement.prototype.click`) and installs a document capture listener as effect contributions (unwound on stop), and `VIRTUAL_HOST` pins the upstream fallback constant `dsh.internal` — an upstream rename of that constant must update this copy.

## Related

The bridge rides the same renderer wire client as the [desktop client connection plugin](../architecture/2026-08-16-desktop-client-connection-plugin.md); the two cover the desktop transport, this note the native-fetch download surface on it.

