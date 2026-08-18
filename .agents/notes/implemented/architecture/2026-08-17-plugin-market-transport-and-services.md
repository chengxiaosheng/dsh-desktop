# Agent Note: Plugin market integration — full-route IPC proxy and desktop host services

Status: implemented

English | [中文](2026-08-17-plugin-market-transport-and-services.zh.md)

## Problem

The desktop runs the full Web UI with no HTTP socket and no port: the renderer's fetch is patched to send host requests over the preload bridge, and the main's `dispatchHttpRequest` served only the `/api` GET/HEAD download plane through `toFetchHandler(apiProxy)`. The [dshmarket](https://github.com/dsh-market/dsh-market) plugin market — the community plugin market that mounts two dozen `/dsh-market/*` routes on the official `webServer` route registry and injects a settings section — could therefore never reach its own routes from the desktop page: a relative `fetch('/dsh-market/status')` fell through to native `file://` fetch and failed. Extending the bridge per plugin route was the naive fix, and it would not scale: every future plugin's route would need a bespoke bridge leg.

Installing the market's plugins needs a package manager and profile reconciliation the zero-socket desktop did not expose. The market already ships a Desktop contract (`desktopProfiles` + `desktopPnpm`, the public cross-environment services documented in the upstream desktop's `plugin-services.md`), but this desktop provided neither service, so the market would have fallen back to spawning the `dsh` CLI — a binary the packaged desktop does not ship.

## Decision

**Ship the market.** `dshmarket` is an `optionalDependencies` entry of the desktop package, mounted by an insert row in `cordis.patch.yml` (`- id: dsh-market, name: dshmarket`). Because it is an optional dependency, the heal walk does not manage its profile fallback link; the boot maintains that link itself and honors a user-installed override — the market is user-updatable with the bundled copy as the fallback (see the [market-override note](../feature/2026-08-18-market-override-update.md)). Its own bundle patch is not composed — the row is mounted once here. The market's client bundle enters the renderer graph automatically. Plugins the market installs into the profile load at boot through a profile-anchored loader-resolution hook the boot provides, because Electron cannot host the loader's native internal module loader (see the [loader-resolution note](../bug-fix/2026-08-17-profile-anchored-loader-resolution.md)).

**Generalize the transport to a full-route IPC proxy.** The renderer (`dsh-plugin-desktop-connection`'s `host-http.ts`) now diverts *every* `file://` (same-origin) and `http://dsh.internal` request, carrying method, headers, and the UTF-8 body. The main (`boot-desktop.ts` `dispatchHttpRequest`) dispatches through the virtual `webServer` route registry (`match` → exact/prefix, then the fallback seat) with synthesized `IncomingMessage`/`ServerResponse` stand-ins — method, url, an async-iterable body for `readJsonBody`, buffered `writeHead`/`end`, and loopback `Origin`/`Host` (`127.0.0.1`) filled in so the market's `sameOrigin()` checks and plugin loopback fences pass. Exact beats prefix exactly as the official server resolves it, so a plugin's route under `/api/*` wins over the connection's `/api` prefix; the proven `toFetchHandler` fast path serves the `/api` plane only when the match is the connection's own prefix (see the [exact-`/api`-route note](../bug-fix/2026-08-17-exact-api-routes-beat-connection-prefix.md)). Any plugin route works in-process with no per-plugin bridge — the socketless analog of the official HTTP server's routing.

**Provide the market's Desktop host services.** `bootDesktop`'s prepare hook (before Loader entries mount) registers `desktopProfiles` (`{ current: { name: 'desktop', dir } }`) and `desktopPnpm` via `createDesktopServices`. `desktopPnpm.runPlugin` re-invokes the published `dsh plugin --profile desktop <args>` CLI — the ordinary DSH authority for pnpm plus `dsh.profile.bundles` reconciliation — under Electron's plain-Node mode (`ELECTRON_RUN_AS_NODE=1` on `process.execPath`), with the caller directory as cwd and the bundled pnpm's directory prepended to the child PATH. `desktopPnpm.run` runs pnpm directly with the active profile as cwd (the contract's low-level leg). At most one package operation runs per generation (a second call throws the market's recognized busy message).

**Bundle pnpm for offline installs.** `@pnpm/exe` is a dependency; its install-time `setup.js` hard-links the platform standalone binary into its own `pnpm` file (build approved via `allowBuilds`). The packaged closure carries `@pnpm/exe` with the materialized native binary, and the platform packages (`@pnpm/linux-*`/`win-*`/`macos-*`) — install-time-only, ~150MB each — are excluded from the closure. When the bundled binary is present it wins on the child PATH; otherwise the system `pnpm` serves. No system Node is required to install plugins in a packaged app.

## Alternatives considered

**Extend the bridge per plugin route.** Rejected — each plugin's routes would need a bespoke bridge leg; the full-route proxy serves every plugin's routes (and `/api`) through one registry dispatch.

**Reaching `/dsh-market/*` through the `/api` fast path.** Rejected — the market's routes are exact webServer registrations, not the connection's `/api` prefix; dispatching through `webServer.match` is the one mechanism that covers both.

**`desktopPnpm` running raw pnpm with desktop-owned reconciliation.** Rejected — re-invoking the published `dsh plugin` CLI reuses the official reconciliation logic (`dsh.profile.bundles`), matches the upstream contract (`runPlugin` runs `dsh plugin --profile <active> …`), and stays correct as upstream evolves.

**System pnpm only.** Rejected on request — the packaged app should install plugins without a system pnpm, so `@pnpm/exe` ships in the closure and wins on PATH.

**Whole-application restart for pending plugin changes.** Deferred — the companion [host reboot note](../feature/2026-08-17-host-reboot.md) covers the in-process re-boot instead.

## Consequences

The market works end-to-end in the desktop: its settings section renders, every `/dsh-market/*` route dispatches in-process, and installs run through the real `dsh` CLI with offline pnpm, hot-mounting most changes with no restart. Costs: `dshmarket` and the bundled pnpm (~159MB) grow the packaged closure; the bundled pnpm only serves `linux-x64` here — other platforms need their own `@pnpm/*` binary materialized by the normal `pnpm install` (the workspace's `allowBuilds` runs `setup.js` on each host); the req/res shims buffer responses, so long-lived streaming routes (SSE) are outside the bridge surface; the market's own restart route stays disabled in Desktop mode (the shell owns restart, see the companion note).
