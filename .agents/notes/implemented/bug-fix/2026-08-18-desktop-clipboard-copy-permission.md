# Agent Note: Desktop copy buttons grant the clipboard-write permission

Status: implemented

English | [中文](2026-08-18-desktop-clipboard-copy-permission.zh.md)

## Problem

The chat copy button — and every other `navigator.clipboard` write the SPA makes (JSON/code/hover-card copy) — silently does nothing when clicked in the desktop window. The published UI copies through `@deepseek-ai/dsh-client-ui-primitives` `writeClipboard`, which awaits `navigator.clipboard.writeText` and returns `false` on rejection (the `execCommand('copy')` fallback only runs when the async API is absent). Chromium's async clipboard write is gated by a permission *request*: `ClipboardPromise::ValidatePreconditions` finds no other grant (`AllowWriteToClipboard` is the Chromium default `false`; Electron does not override it) and falls through to `permission_service_->RequestPermission(CLIPBOARD_SANITIZED_WRITE, …)`. Electron's `ElectronPermissionManager` answers that request through the window's `setPermissionRequestHandler`, and the desktop window denied every request (`callback(false)`), so `writeText` rejected with `NotAllowedError` and the copy button stayed silent.

## Decision

`electron/permissions.ts` owns the main-window permission-request policy as `isGrantedPermission`: it grants exactly the `clipboard-sanitized-write` request — the one name Electron 43 emits for `navigator.clipboard.writeText`/`write` sanitized writes (the unsanitized write path surfaces as `clipboard-read`, which stays denied) — and denies every other permission. `window.ts`'s `setPermissionRequestHandler` answers with that predicate; `setPermissionCheckHandler` stays unset, so permission *checks* keep the Electron default grant. The policy is headless-tested in `tests/clipboard-permission.spec.ts` (grants the write name, denies the rest including `clipboard-read`).

## Alternatives considered

**Route clipboard writes through a preload IPC channel** (contextBridge helper → main-process `clipboard.writeText`). The desktop-owned bridge seam could carry it, but the published UI calls `navigator.clipboard` directly; a helper would never reach the existing copy buttons without changing the shipped frontend, which the [published-packages boundary](../process/2026-08-16-upstream-as-published-packages.md) forbids.

**Allow every permission request.** Removes the shell's deny-by-default posture for camera, microphone, notifications, geolocation, and the rest, for one benign capability.

**Keep the deny-all handler and rely on `document.execCommand('copy')`.** The published `writeClipboard` never reaches the fallback while `navigator.clipboard.writeText` exists, so this changes nothing.

## Consequences

Copy buttons in the chat dialog and every other `navigator.clipboard` write now place text on the system clipboard. Costs: the SPA is granted one more capability than before — writing the clipboard, no more than the keyboard `Ctrl+C` the page already permits — and every other permission request remains denied. The policy lives in a headless-tested module, pinning the copy path against regression.
