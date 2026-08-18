# Agent Note: 桌面端复制按钮授予剪贴板写入权限

Status: implemented

[English](2026-08-18-desktop-clipboard-copy-permission.md) | 中文

## Problem

桌面窗口中的对话复制按钮——以及 SPA 其余所有 `navigator.clipboard` 写入（JSON/代码/hover-card 复制）——点击后毫无反应。已发布的 UI 通过 `@deepseek-ai/dsh-client-ui-primitives` 的 `writeClipboard` 复制：它 `await navigator.clipboard.writeText`，被拒绝时返回 `false`（`execCommand('copy')` 回退仅在异步 API 缺失时才运行）。Chromium 的异步剪贴板写入由一个权限**请求**把关：`ClipboardPromise::ValidatePreconditions` 找不到其他放行途径（`AllowWriteToClipboard` 取 Chromium 默认值 `false`，Electron 未覆盖它），于是落入 `permission_service_->RequestPermission(CLIPBOARD_SANITIZED_WRITE, …)`。Electron 的 `ElectronPermissionManager` 通过窗口的 `setPermissionRequestHandler` 回答该请求，而桌面窗口拒绝了每一个请求（`callback(false)`），因此 `writeText` 以 `NotAllowedError` 被拒，复制按钮保持沉默。

## Decision

`electron/permissions.ts` 以 `isGrantedPermission` 持有主窗口的权限请求策略：它恰好放行 `clipboard-sanitized-write` 这一种请求——这是 Electron 43 为 `navigator.clipboard.writeText`/`write` 的净化写入发出的唯一名称（非净化写入路径以 `clipboard-read` 呈现，保持拒绝）——并拒绝其余所有权限。`window.ts` 的 `setPermissionRequestHandler` 用该谓词作答；`setPermissionCheckHandler` 保持不设置，因此权限**检查**沿用 Electron 默认放行。该策略在 `tests/clipboard-permission.spec.ts` 中做了无头测试（放行写入名、拒绝其余各项，包括 `clipboard-read`）。

## Alternatives considered

**经 preload IPC 通道转发剪贴板写入**（contextBridge 助手 → 主进程 `clipboard.writeText`）。桌面自有的桥接缝可以承载它，但已发布 UI 直接调用 `navigator.clipboard`；不改动已发布前端就无法触达现有复制按钮，而这被[已发布包边界](../process/2026-08-16-upstream-as-published-packages.md)禁止。

**放行所有权限请求。** 为一项良性的能力，放弃外壳对摄像头、麦克风、通知、地理定位等各项的默认拒绝姿态。

**保留全拒绝处理器，依赖 `document.execCommand('copy')`。** 只要 `navigator.clipboard.writeText` 存在，已发布的 `writeClipboard` 就不会走到回退分支，因此这不会改变任何行为。

## Consequences

对话中的复制按钮以及 SPA 其余所有 `navigator.clipboard` 写入现在都能把文本放入系统剪贴板。代价：SPA 比之前多获得一项能力——写入剪贴板，并不超过页面本已允许的键盘 `Ctrl+C`——而其余所有权限请求仍然被拒绝。策略位于一个可无头测试的模块中，把复制路径钉死以防回归。
