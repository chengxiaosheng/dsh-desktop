# Agent Note: NSIS running-app check replaced with exact-name match

Status: implemented

English | [中文](2026-08-18-nsis-running-app-check-false-positive.zh.md)

## Problem

electron-builder 26's built-in NSIS `CHECK_APP_RUNNING` matches running processes by PATH PREFIX against the install directory (PowerShell `Get-CimInstance` `Path.StartsWith($INSTDIR)`). On machines where an unrelated process's path starts with the install directory, it reports the app as running even though DSH Desktop was never installed; clicking OK then loops forever because the matched process is not the app and cannot be killed, so the installer never completes.

## Decision

`packages/dsh-plugin-desktop/build/installer.nsh` defines the `customCheckAppRunning` macro, picked up through `nsis.include: installer.nsh`, which replaces the built-in check entirely (electron-builder dispatches `CHECK_APP_RUNNING` to `customCheckAppRunning` when the macro is defined). The replacement matches the process by exact image name only — `tasklist /FI "IMAGENAME eq dsh-desktop.exe" | findstr` — the electron-builder PR #9784 approach. `dsh-desktop.exe` is unique to this product, so only a genuinely running instance triggers the prompt; clicking OK force-kills it (`taskkill /IM ... /F`) and the install continues. Because the installer and uninstaller are compiled separately and each build expands `CHECK_APP_RUNNING` once, the macro's `doStopProcess` label does not collide.

## Alternatives considered

**No-op macro (skip the running check).** Zero NSIS risk, but loses the "close the running app before install/upgrade" behaviour, which matters for a tray-resident app.

**Upgrade electron-builder.** The path-prefix check already IS the post-PR-#9069/#9784 logic; a version bump does not remove the false positive.

## Consequences

Clean installs never trip the running check, and a genuinely running app (for example hidden in the system tray) is still offered to be closed before an install or upgrade. Costs: a custom NSIS macro that must survive electron-builder template changes (its exact-match syntax is pinned to the 26.15.3 templates); the false positive was only reproduced on the affected machine, so the macro cannot be fully compile-verified outside a Windows NSIS build; the Windows installer must be rebuilt (v0.1.1) to ship the fix.
