# Agent Note: 用 desktopName 建立 Linux 窗口与桌面条目的关联

Status: implemented

[English](2026-08-18-linux-desktop-name-window-association.md) | 中文

## Problem

Linux 的 .deb 安装了正确的启动器图标与 .desktop 条目（`Icon=dsh-desktop`、`StartupWMClass=DSH Desktop`），但运行中的窗口在任务栏/坞里不显示图标。`package.json` 缺少 `desktopName`：Electron 从该字段推导 Linux 的 app_id/WM_CLASS（缺失时回退到包名），而 electron-builder 用 `productName` 写入 `StartupWMClass`——两者不匹配破坏了窗口↔桌面条目的关联，electron-builder 对此也给出了明确警告。

## Decision

`dsh-plugin-desktop/package.json` 设置 `desktopName: dsh-desktop.desktop`；`scripts/materialize.mts` 把它传播进打包后的 `dist-pack/package.json`（Electron 从应用清单读 app_id）；`electron-builder.yml` 的 linux 段设置 `syncDesktopName: true`，使安装后的 .desktop 文件名跟随 `desktopName`。这样 .desktop 的 `StartupWMClass` 与 Electron 运行时的 app_id 都是 `dsh-desktop`，桌面环境即可把运行窗口关联到该条目，并在任务栏/坞中显示应用图标。

## Alternatives considered

**在 Electron main 里调用 `app.setDesktopName()`。** 与 package.json 字段重复，还需按平台手工接线；清单字段才是文档化的机制。

**只保留既有的 `linux.icon`。** 对启动器已正确且必需，但无法修复运行窗口的关联。

## Consequences

Linux 运行窗口与 .desktop 条目正确关联，任务栏/坞显示应用图标。代价：打包应用清单必须携带 `desktopName`（同一改动里给 materialize 加了传播）；修复只在重建安装包后生效；hicolor 图标仍只以 1024x1024 安装（源是单张 1024×1024 PNG）。
