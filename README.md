# DSH Desktop

A desktop product around the **unmodified** published DeepSeek Harness packages: the full Web UI running with **no Node HTTP server and no port**, composed entirely as Cordis plugins over the `@deepseek-ai/*` family pinned in [`upstream.json`](upstream.json).

- [`upstream.json`](upstream.json) — upstream provenance pin: source commit + published runtime package family.
- `packages/dsh-plugin-desktop/` — the shell row, the socketless `webServer` interceptor, and the Electron main.
- `packages/dsh-plugin-desktop-connection/` — the renderer wire client over Electron IPC.
- Documentation and decisions follow the [DeepSeek Harness conventions](AGENTS.md).

## The zero-socket transport

| Piece | Row / package | What it replaces |
|---|---|---|
| Socketless webserver | `dsh-plugin-desktop/webserver` | the official `webserver` row (disabled) |
| Renderer wire client | `dsh-plugin-desktop-connection` | the official `connection` row (disabled) — node half re-exports upstream, client half rides Electron IPC |
| Boot manifest | Electron preload (`window.__DSH_BOOT__`) | the server index tap |
| RPC dispatch | `ipcMain` (`connection.createSharedFetchHandler` + `apiProxy`) | the HTTP/WebSocket carrier |
| Virtual-host download bridge | `dsh-plugin-desktop-connection` client + `dispatchHttpRequest` (main) | the host HTTP download the official webserver served (`/api/session.export`) |

The official `modules`, `ui-theme`, `web-runtime`, and `frontend-static` rows activate unchanged against the virtual `webServer`.

## Layout

```
upstream.json                  upstream provenance pin (source commit + package family)
packages/
  dsh-plugin-desktop/
    cordis.patch.yml           desktop composition (disable + insert rows)
    src/webserver.js           VirtualWebServer — socketless interceptor
    src/index.js               desktop shell row
    electron/main.js           Electron main: window + IPC bridge
    electron/preload.cjs       __DSH_BOOT__ + dshDesktop bridge
    electron/boot-desktop.js   profile boot + file:// manifest assembly (headless-testable)
    tests/                     boot proof + electron boot helper tests
  dsh-plugin-desktop-connection/
    src/index.js               node half: re-exports the official apply
    src/client/                IPC carrier + pinned ConnectionController + plugin
    scripts/build-client.mjs   esbuild bundle → lib/client.js
    tests/client.spec.js       carrier unit tests (fake bridge)
docs/                          architecture map
.agents/notes/                 Agent Notes (decision records)
```

## Running

```sh
pnpm install
pnpm build            # compile every plugin (esbuild client bundle + source checks)
pnpm -r test          # headless boot proof + client carrier tests (no browser, no socket)
pnpm start            # compile the connection bundle, then launch the Electron app
```

Any plugin compiles from the root: `pnpm build` runs every workspace package's `build` script, and `pnpm --filter <plugin> build` targets one.

The core transport is verified headless (fake bridge + profile boot); the Electron window is the runnable shell over the same in-process host.

## Model Experience

The desktop is a presentation and transport surface over the standard DeepSeek Harness agent. It changes no model-facing behavior: the same session log, tools, model route, and agent loop run underneath. The transport (Electron IPC instead of HTTP/WebSocket) and the socketless host are invisible to the model; model-visible inputs and outputs are unchanged.

## Known Limitations and Deferred Work

- The Electron shell is minimal: one window plus the IPC bridge. Tray, terminal, bundled pnpm, profile management, updates, and installers are deferred.
- The renderer `ConnectionController` is a pinned copy of the upstream source (reapply from the commit recorded in `upstream.json` on a runtime family bump).
- The desktop keeps a zero-socket host; the `deepseek-harness-desktop` project is the alternative loopback-carrier design for comparison.
