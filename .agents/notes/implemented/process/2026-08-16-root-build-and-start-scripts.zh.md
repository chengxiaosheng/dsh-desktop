# Agent Note: 根目录 build 与 start 脚本

Status: implemented

[English](2026-08-16-root-build-and-start-scripts.md) | 中文

## Problem

根 `package.json` 只暴露 `test`：启动桌面须记得逐包的 `pnpm --filter dsh-plugin-desktop start`，而该 `start` 静默假设 `dsh-plugin-desktop-connection` 的 esbuild 客户端 bundle（`lib/client.js`）已存在。根目录没有任何编译插件的入口；编译步骤只存在于各包自己的 `build` 脚本里。

## Decision

根 `package.json` 拥有启动器脚本。`pnpm build` 运行 `pnpm -r build`，编译所有定义了 `build` 脚本的 workspace 插件，因此任何现有或未来的插件都能从根目录编译；`pnpm --filter <插件> build` 针对单个插件。`pnpm start` 先编译 desktop-connection 客户端 bundle，再运行桌面壳的 `start`（`electron .`），因此窗口打开时渲染端客户端总是最新的。`dsh-plugin-desktop` 新增 `build` 脚本，对其 ESM/CJS 源码逐个运行 `node --check`——它没有转换步骤，只有解析校验——使 `pnpm -r build` 也覆盖它。

## Alternatives considered

**只保留逐包 `start`。** 会留下 bundle 过期或缺失的隐患，且根目录没有启动入口，而产品正是在根目录启动的。

**根 `start` 先跑 `pnpm build`（编译全部）。** 比需要更宽更慢；只有 connection 客户端 bundle 是 Electron 窗口的运行时前置。

**通用按插件名分发的脚本。** 比标准的 `pnpm --filter <插件> build` 惯用法多出无谓的表面。

## Consequences

根目录成为唯一的编译与启动入口：`pnpm start` 每次都会提供最新构建的渲染端 bundle，`pnpm build`/`pnpm --filter <插件> build` 可从根目录编译任意插件。代价：`pnpm start` 每次启动都会重跑 esbuild bundle（毫秒级），且 `dsh-plugin-desktop` 的 `build` 是成败式解析校验而非产物。
