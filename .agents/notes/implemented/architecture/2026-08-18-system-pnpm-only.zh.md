# Agent Note: 只依赖系统 pnpm——去掉内置独立二进制

Status: implemented

[English](2026-08-18-system-pnpm-only.md) | 中文

## Problem

打包应用曾随包携带 `@pnpm/exe`，其独立二进制内嵌了 Node.js 运行时加整个 pnpm CLI——约 140MB，外加 19MB 的 JS dist，是 465MB 依赖闭包里最大单项。它让每个安装包膨胀约三分之一（win NSIS 436MB、mac DMG 331MB、linux AppImage 259MB），换来「无需系统 pnpm 也能装插件」。Electron 本身已内置 Node 运行时，这个独立二进制的内嵌 Node 原则上是冗余的；而插件市场的 `dsh plugin` CLI（已发布的上游包）直接从 PATH `spawnSync("pnpm")`，npm 无法替代。

## Decision

`@pnpm/exe` 不再是产品的一部分：从 `dsh-plugin-desktop` 的 `dependencies` 与 `pnpm-workspace.yaml` 的 `allowBuilds` 中移除，且 `materialize.mts` 通过 `PNPM_BUNDLED_PKG` 把它（连同仅安装期使用的 `@pnpm/<platform>` 平台包）排除出物化闭包。`desktopPnpm` 从系统 PATH 解析 `pnpm`（`desktop-services.ts` 删除了内置 pnpm 分支）。`dsh` CLI 仍以 Electron 纯 Node 模式运行，因此插件安装只需 PATH 上有 `pnpm`；CLI 在缺失时报 "pnpm not found on PATH — install pnpm to manage profile plugins"。

## Alternatives considered

**保留内置独立二进制。** 保住「零系统依赖安装插件」，代价是每个安装包多约 159MB——因体积而否决。

**用 Electron 的 Node 跑 pnpm 的 JS 发行版**（`spawn(process.execPath, [pnpm-cli.js, ...])`）。去掉独立二进制内嵌的 Node，但上游 `dsh plugin` CLI 内部的 `spawnSync("pnpm")` 仍需 PATH 上可见的 `pnpm`，得加一个能定位 Electron 二进制的 shim——复杂度更高，推迟。

**回退到 npm。** 上游 `dsh plugin` CLI 是 pnpm 专用的转发器（`spawnSync("pnpm")` 加仅 pnpm 的 `dsh.profile.bundles` 收尾），不改发布包就无法用 npm 替代。

## Consequences

安装包约缩小三分之一（win ~436→~330MB、mac ~331→~250MB、linux AppImage ~259→~200MB）。插件安装现在要求机器上有系统 pnpm；「无需系统 Node 或 pnpm 装插件」的特性被移除，README 已改为说明 pnpm 要求。将来若离线安装重要，重新加回内置 pnpm 只是一行排除改动。
