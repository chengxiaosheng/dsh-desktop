# Agent Note: Socketless webServer interceptor plugin

Status: implemented

English | [中文](2026-08-16-virtual-webserver-interceptor.zh.md)

## Problem

The desktop product must run the full Web UI with no Node HTTP server and no port. The official `@deepseek-ai/dsh-host-webserver` row binds a node:http socket in its service init, and the official `connection` and `modules` node halves hard-inject `webServer`. A desktop without a socket cannot mount those rows, and the desktop never edits the [published packages](../process/2026-08-16-upstream-as-published-packages.md).

## Decision

The desktop composition disables the official `webserver` row and mounts `dsh-plugin-desktop/webserver`, a `VirtualWebServer extends Service` that provides the `webServer` service with the exact official route-registry contract — `register`, `registerUpgrade`, `registerFallback`, `tapIndex`, `applyIndexTaps`, `host`, `port`, with duplicate-throw, longest-prefix-wins, single-fallback-seat, and tap-ordering semantics — but whose `[Service.init]` never binds a socket. `host` reports `127.0.0.1` so `web-runtime` derives loopback-only trust; `port` reports the stable virtual port `VIRTUAL_HOST_PORT` when configured at `0`, and plugins that read `webServer.port` to reach the harness host-side are served by the [host-side virtual-host transport](2026-08-18-desktop-host-side-virtual-host-transport.md). The official `connection` and `modules` rows mount unchanged against it; the host dispatches in-process — `/api` RPC through `connection.createSharedFetchHandler` plus `toFetchHandler(apiProxy)`, and every other webserver route (the plugin market's `/dsh-market/*` included) through the full-registry proxy covered by the [plugin market integration note](2026-08-17-plugin-market-transport-and-services.md).

## Alternatives considered

**Ship a real loopback webserver.** This is the `deepseek-harness-desktop` design: zero package changes but a listening socket, which the zero-socket desktop excludes.

**Add a `listen: false` headless mode to `@deepseek-ai/dsh-host-webserver`.** A ~20-line upstream seam completion would avoid reimplementing the registry contract, but the desktop never edits the published packages; the reimplemented contract is pinned and tested against the official behavior.

## Consequences

The host is socketless while `connection`/`modules`/`ui-theme`/`web-runtime` activate unchanged, verified by the headless boot proof. The cost: `VirtualWebServer` reimplements ~90 lines of registry semantics that must stay in sync with the official package; a `listen: false` upstream mode would retire it. The renderer transport is covered by the [desktop client connection plugin](2026-08-16-desktop-client-connection-plugin.md).
