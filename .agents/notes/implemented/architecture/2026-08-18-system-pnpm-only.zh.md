# Agent Note: 只依赖系统 pnpm——去掉内置独立二进制

Status: implemented

[English](2026-08-18-system-pnpm-only.md) | 中文

## Problem

打包应用曾随包携带 `@pnpm/exe`，其独立二进制内嵌了 Node.js 运行时加整个 pnpm CLI——约 140MB，外加 19MB 的 JS dist，是 465MB 依赖闭包里最大单项。它让每个安装包膨胀约三分之一（win NSIS 436MB、mac DMG 331MB、linux AppImage 259MB），换来「无需系统 pnpm 也能装插件」。Electron 本身已内置 Node 运行时，这个独立二进制的内嵌 Node 原则上是冗余的；而插件市场的 `dsh plugin` CLI（已发布的上游包）直接从 PATH `spawnSync("pnpm")`，npm 无法替代。

桌面 GUI 启动不会 source 用户的 shell profile（macOS Finder/Dock、Windows Explorer、Linux 桌面菜单都继承一份精简 PATH），因此用户经 nvm、`pnpm setup`、Homebrew 或 `npm -g` 安装的 pnpm 对 spawn 出的 `dsh` CLI 不可见，尽管终端里能找到它——于是明明装有 pnpm 的机器上，插件安装也会报上游的 "pnpm not found on PATH"。

## Decision

`@pnpm/exe` 不再是产品的一部分：从 `dsh-plugin-desktop` 的 `dependencies` 与 `pnpm-workspace.yaml` 的 `allowBuilds` 中移除，且 `materialize.mts` 通过 `PNPM_BUNDLED_PKG` 把它（连同仅安装期使用的 `@pnpm/<platform>` 平台包）排除出物化闭包。`desktopPnpm` 从系统 PATH 解析 `pnpm`——`desktop-services.ts` 删除了内置 pnpm 分支，其 `childEnv` 把众所周知的用户 bin 目录（`electron/path-bootstrap.ts`：homebrew、`~/.local/bin`、`~/.local/share/pnpm`、`~/.npm-global/bin`、`~/.volta/bin`，以及每个装有 `node`/`pnpm` 的 nvm node bin）追加到每个包管理器子进程的 PATH，因此 GUI 启动仍能解析到用户 pnpm。`dsh` CLI 仍以 Electron 纯 Node 模式运行，因此插件安装只需 `pnpm` 存在于可发现位置；CLI 在缺失时报 "pnpm not found on PATH — install pnpm to manage profile plugins"。

市场的「一键安装 pnpm」在桌面模式下被 stub（上游 dshmarket 的 `createDesktopPluginRuntime` 让 `probePnpm`/`provisionPnpm` 直接返回成功而不安装任何东西），所以桌面侧的补偿是上面的 PATH bootstrap，而不是这个按钮。

## Alternatives considered

**保留内置独立二进制。** 保住「零系统依赖安装插件」，代价是每个安装包多约 159MB——因体积而否决。

**用 Electron 的 Node 跑 pnpm 的 JS 发行版**（`spawn(process.execPath, [pnpm-cli.js, ...])`）。去掉独立二进制内嵌的 Node，但上游 `dsh plugin` CLI 内部的 `spawnSync("pnpm")` 仍需 PATH 上可见的 `pnpm`，得加一个能定位 Electron 二进制的 shim——复杂度更高，推迟。

**回退到 npm。** 上游 `dsh plugin` CLI 是 pnpm 专用的转发器（`spawnSync("pnpm")` 加仅 pnpm 的 `dsh.profile.bundles` 收尾），不改发布包就无法用 npm 替代。

**缺失时在运行时自装 pnpm。** 首次使用要写盘并下载，带权限/网络失败模式；因越界而否决——bootstrap 已覆盖已安装的 pnpm，缺失时仍有清晰的上游提示兜底。

**用探测而非已知目录做 PATH bootstrap。** 对每个候选跑 `pnpm --version` 会给每次操作加一个子进程并缓存状态；静态的已知目录列表（与 dshmarket web 运行时做法一致）确定且可无头测试——采纳。

## Consequences

安装包约缩小三分之一（win ~436→~330MB、mac ~331→~250MB、linux AppImage ~259→~200MB）。插件安装现在要求机器上有系统 pnpm；「无需系统 Node 或 pnpm 装插件」的特性被移除，README 已改为说明 pnpm 要求。将来若离线安装重要，重新加回内置 pnpm 只是一行排除改动。GUI 启动（常见的桌面场景）现在能在任何已知位置解析到用户 pnpm；市场的设置按钮在桌面端仍是 stub（上游），README 已将其列为已知限制。
