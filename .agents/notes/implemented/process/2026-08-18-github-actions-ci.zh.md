# Agent Note: GitHub Actions CI 与发布打包

Status: implemented

[English](2026-08-18-github-actions-ci.md) | 中文

## Problem

仓库没有任何 CI：提交之后没有东西跑测试、类型检查，也不产出可分发的安装包，workspace 组合或打包管线的回归只会在开发者的机器上暴露。

## Decision

`.github/workflows/` 下有两个 GitHub Actions workflow。`ci.yml` 在每次 push 到 master 与每个 pull request 上运行：它像本地 checkout 一样安装 workspace（因为 `pnpm-lock.yaml` 不提交，按 `upstream.json` 记录的 dist-tag 重新解析 `@deepseek-ai/*`），运行 `pnpm check`（每个包做严格类型检查、编译与测试，含 `verify:upstream` 固定副本门禁），然后在 Linux runner 上运行 `package:dir` 证明完整的 electron-builder 管线（build → materialize → electron-builder → 无头启动打包后的 `resources/host`）。`build.yml` 在原生 runner 上打包可分发的产物（macOS 出 DMG、Windows 出 x64 NSIS、Linux 出 AppImage+deb+rpm）并作为 workflow artifact 上传；它在 `v*` 标签、手动 `workflow_dispatch`、以及改动打包相关文件的 master push（由 `dorny/paths-filter` 检测，普通提交不会烧掉三个原生 runner）时触发。两个 workflow 都缓存 pnpm store 与 Electron/electron-builder 下载缓存，因无 lockfile 而以 manifest 为缓存键。`dist.mts` 在 Windows 上以 `shell: true` 派生 `pnpm`，使其内部的 `spawnSync('pnpm', …)` 调用能解析 `pnpm.cmd` shim。代码签名保持关闭（`CSC_IDENTITY_AUTO_DISCOVERY=false`），不发布任何产物（electron-builder `publish: null`）——产出 artifact 是构建步骤，发布是独立的发布决策。

## Alternatives considered

**合并成一个 workflow 文件。** 读起来更简单，但把每次提交的快速测试门禁与慢速的跨平台打包矩阵耦合在一起；带路径过滤的 master 触发与标签/手动派发各自成文更清晰。

**每次提交都跑完整打包矩阵。** 反馈最多，但每个 push 都要三个原生 runner 跑完整个 electron-builder 管线（Electron 下载与约 230MB 产物）；`ci.yml` 里的 `package:dir` 步骤已经在每次提交上无头地演练了这条管线。

**提交 `pnpm-lock.yaml` 以获得可复现安装。** 被既有的 dist-tag 浮动决策否决；CI 的安装与本地一样随标签浮动，`verify:upstream` 用已安装的家族门禁固定副本 `ConnectionController`。

## Consequences

每次提交都被类型检查、构建、测试与无头打包证明把关；`v*` 标签与 master push 产出三个平台的未签名、可上传的安装包。代价：pnpm store 缓存是尽力而为，因为安装是浮动的（键基于 manifest 而非 lockfile）；上游新发布可能因 `verify:upstream` 失败而需要先重做固定副本；mac 产物在 arm64 的 `macos-latest` runner 上构建（electron-builder 的原生架构），其它 mac 架构需向 `dist:mac` 传 `--x64`/`--arm64`；打包任务依赖 Electron/electron-builder 下载缓存以免每次重下二进制。
