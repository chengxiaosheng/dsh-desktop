# Agent Note: In-process host reboot applies pending plugin changes

Status: implemented

English | [中文](2026-08-17-host-reboot.zh.md)

## Problem

The plugin market's Desktop mode sets `allowRestart: false` (its contract: "the shell remains responsible for restart"), so changes that cannot hot-load — the market's "needs restart" banner: complex patch compositions, removals needing live-disable — sit pending with no way to apply them short of quitting and relaunching the whole Electron application. That restart is heavy: the window, tray, single-instance lock, and every shell surface go down for a plugin that mostly hot-mounts already.

## Decision

The desktop re-boots the host **in-process** instead of restarting the app. `installIpc` returns a disposer that removes every handler it registered (the `dsh:boot-manifest`, `dsh:subscribe`, `dsh:unsubscribe` listeners and the `dsh:invoke`, `dsh:close-behavior` handlers), so the bridge can be installed against a fresh context. `electron/main.ts`'s `rebootHost` disposes the current Cordis generation (`ctx.fiber.dispose()`, the same path the quit flow uses), boots a fresh one (`bootDesktop` re-reads the profile, so a plugin added to `dsh.profile.bundles` composes on this boot), re-installs the IPC bridge, and reloads the renderer — the preload re-reads the rewritten manifest synchronously via `dsh:boot-manifest`. The process, window, and tray stay up.

The trigger is a shell surface, not the market's page: the shell client adds a "Restart host" row to the settings General section (`settings.desktop.restart.*`), whose button calls the `dsh:reboot-host` IPC channel over the bridge (`bridge.rebootHost()` → `installRebootChannel`). The tray's "Restart host" item triggers the same in-process reboot (the tray owns no reboot state of its own; it calls the main's `rebootHost` directly). The market's own restart route stays disabled in Desktop mode; the shell owns restart.

## Alternatives considered

**Restart the whole Electron application.** Rejected — unnecessary churn for a change the host alone can absorb; the in-process re-boot reuses the proven `ctx.fiber.dispose()` path and keeps the window, tray, and single-instance lock.

**Subprocess-host reboot (kill + respawn a child host process).** Deferred — stronger isolation, but a second IPC hop (renderer → main → child) and a large refactor of the transport. The full-route IPC proxy ([plugin market transport note](../architecture/2026-08-17-plugin-market-transport-and-services.md)) keeps this open: the child would simply become the proxy's next hop.

**Auto-trigger from the market's pending-restart state.** Deferred — the market keeps that state in its own client (operation responses), not in a host-readable document; a durable "pending restart" signal would be needed before the desktop can safely reboot on its own without risking a mid-install or unexpected reload.

## Consequences

A user applies pending plugin changes with one click and keeps the application running; the renderer reloads (a brief flash) and re-subscribes to the downlink streams through the re-installed bridge. Costs: `installIpc` must be re-installable (dispose removes handlers; a stale handler would double-register and throw), a reboot briefly leaves the renderer with no `dsh:invoke` handler while the fresh host boots (~300ms), and the old generation's profile watchers and stream pumps must fully unwind before the second boot (verified by the double-boot boot proof). The trigger is manual; automatic reboot waits on a durable pending-restart signal.
