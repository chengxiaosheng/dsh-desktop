# Agent Note: 进程内宿主重启以应用待生效的插件变更

Status: implemented

[English](2026-08-17-host-reboot.md) | 中文

## Problem

插件市场的 Desktop 模式把 `allowRestart` 置为 `false`（其契约：「shell 负责重启」），因此无法热加载的变更——市场的「需要重启」横幅：复杂 patch 组合、需要 live-disable 的卸载——只能停在那里，除退出并重新拉起整个 Electron 应用外无从应用。这种重启很重：窗口、托盘、单实例锁与每个 shell 面都要为一项本来就大多可热挂载的插件变更全部关停。

## Decision

桌面改为**进程内**重启宿主，而非重启应用。`installIpc` 返回一个 disposer，移除它注册的每个 handler（`dsh:boot-manifest`、`dsh:subscribe`、`dsh:unsubscribe` 监听器与 `dsh:invoke`、`dsh:close-behavior` handler），使桥接可以对全新 ctx 重新安装。`electron/main.ts` 的 `rebootHost` 先 dispose 当前 Cordis 世代（`ctx.fiber.dispose()`，与退出流程同一条路），再启动全新一代（`bootDesktop` 重读 profile，故刚加入 `dsh.profile.bundles` 的插件在这次启动进入组合），重装 IPC 桥接，然后 reload 渲染端——preload 经 `dsh:boot-manifest` 同步重读重写后的清单。进程、窗口、托盘保持在线。

触发点是 shell 面而非市场页：shell 客户端在设置 General 分区加一行「重启宿主」（`settings.desktop.restart.*`），其按钮经桥接调用 `dsh:reboot-host` IPC 通道（`bridge.rebootHost()` → `installRebootChannel`）。托盘里的「重启宿主」项触发同一条进程内重启路径（托盘自身不持有重启状态，直接调用主进程的 `rebootHost`）。市场自身的 restart 路由在 Desktop 模式保持禁用；重启归 shell 所有。

## Alternatives considered

**重启整个 Electron 应用。** 否决——对宿主单独即可吸收的变更来说是多余折腾；进程内重启复用已被验证的 `ctx.fiber.dispose()` 路径，保住窗口、托盘与单实例锁。

**子进程托管宿主重启（杀 + 重新拉起子宿主进程）。** 推迟——隔离更强，但要多一跳 IPC（渲染端 → 主进程 → 子进程）和一次传输大重构。全路由 IPC 代理（[插件市场传输笔记](../architecture/2026-08-17-plugin-market-transport-and-services.zh.md)）保留了这条路线：子进程无非是代理的下一跳。

**从市场的 pending-restart 状态自动触发。** 推迟——市场把该状态放在自己的客户端（操作响应）里，不在宿主可读的文档中；在桌面能安全自主重启（不至于中途打断安装或意外 reload）之前，需要一条持久的「待重启」信号。

## Consequences

用户一键应用待生效的插件变更且应用保持运行；渲染端 reload（短暂闪烁）并经重装的桥接重新订阅下行流。代价：`installIpc` 必须可重装（dispose 移除 handler；残留 handler 会重复注册抛错）、重启期间新宿主启动（约 300ms）时渲染端短暂没有 `dsh:invoke` handler、第二次启动前旧世代的 profile watcher 与流泵必须完全解挂（由双重启动启动证明验证）。触发为手动；自动重启等待持久化的待重启信号。
