# Agent Note: Linux window-to-desktop-entry association via desktopName

Status: implemented

English | [中文](2026-08-18-linux-desktop-name-window-association.zh.md)

## Problem

The Linux .deb installed a proper launcher icon and .desktop entry (`Icon=dsh-desktop`, `StartupWMClass=DSH Desktop`), but the running window showed no icon in the taskbar/dock. `package.json` lacked `desktopName`: Electron derives its Linux app_id/WM_CLASS from that field (falling back to the package name), while electron-builder wrote `StartupWMClass` from `productName` — the mismatch breaks window↔desktop-entry association, and electron-builder warns about exactly this.

## Decision

`dsh-plugin-desktop/package.json` sets `desktopName: dsh-desktop.desktop`; `scripts/materialize.mts` propagates it into the packaged `dist-pack/package.json` (Electron reads the app manifest for its app_id); and `electron-builder.yml` linux sets `syncDesktopName: true` so the installed .desktop filename follows `desktopName`. Both the .desktop `StartupWMClass` and Electron's runtime app_id become `dsh-desktop`, so desktop environments link the running window to the entry and show the app icon in the taskbar/dock.

## Alternatives considered

**Call `app.setDesktopName()` in the Electron main.** Duplicates what the package.json field does and must be wired per-platform manually; the manifest field is the documented mechanism.

**Only the existing `linux.icon`.** Already present and correct for the launcher; it does not fix the running-window association.

## Consequences

The running Linux window is associated with the .desktop entry, so the taskbar/dock shows the app icon. Costs: the packaged app manifest must carry `desktopName` (materialize propagation added in the same change); the fix takes effect only in rebuilt installers; the hicolor icon is still installed at 1024x1024 only (the source is a single 1024×1024 PNG).
