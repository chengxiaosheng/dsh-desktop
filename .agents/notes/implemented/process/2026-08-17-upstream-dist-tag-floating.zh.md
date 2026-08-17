# Agent Note: 上游以 dist-tag 浮动解析，不提交 lockfile

Status: implemented

[English](2026-08-17-upstream-dist-tag-floating.md) | 中文

## Problem

之前的决策把所有 `@deepseek-ai/*` 依赖 pin 在精确的运行时版本族，并用提交的 `pnpm-lock.yaml` 固定解析，导致上游发布一次就要一次专门的手工变更（bump `package.json` 版本族、bump `upstream.json` 的 commit、重新应用固定副本 `ConnectionController`）。用户想要消费者式的工作流：`pnpm install` 自动解析上游最新发布包。两个 registry 事实决定了机制：`@deepseek-ai/dsh-*` 家族发布在 `next` dist-tag 下（多数包的 `latest` 标签还指着远古的 `0.0.1-rc.1`，写 `latest` 会装到坏的、过期的家族），而 cordis 框架包（`@deepseek-ai/cordis`、`@deepseek-ai/cordis-plugin-*`、`@deepseek-ai/schemastery`）的稳定版发布在 `latest` 下，`next` 只是 rc 变体。

## Decision

`packages/dsh-plugin-desktop/package.json` 与 `packages/dsh-plugin-desktop-connection/package.json` 把 `@deepseek-ai/dsh-*` 家族声明为 `next` dist-tag，cordis 框架包声明为 `latest` dist-tag，于是每次 `pnpm install` 都解析到最新的上游发布。`pnpm-lock.yaml` 不提交（已 gitignore），install 对标签新鲜解析。`upstream.json` 记录家族跟随的 dist-tag（`tag: "next"`）、固定副本 `ConnectionController` 取自的版本、该版本对应的上游 commit、以及重应用所依据的上游 `sourcePath`。固定副本由新门禁绑定真相源：`dsh-plugin-desktop-connection` 的 `build` 先跑 `scripts/verify-upstream.mts`，把已安装的 `@deepseek-ai/dsh-client-connection` 版本与记录的版本比对，不一致即失败并给出重应用指引——浮动的家族不能静默带出过期副本。

## Alternatives considered

**家族声明为 `latest` dist-tag。** 用户最初的直译选择；被 registry 证据否决——多数 `@deepseek-ai/dsh-*` 包的 `latest` 解析到 `0.0.1-rc.1`，而当前家族在 `next` 下，安装会破坏 peer 约束（`^0.1.0-rc.6`）与整个组合。

**保留提交的 pin 并加升级脚本。** 保留可复现性与 dedicated-change 流程；被否决，因为用户要的是 install 本身浮动，而非手工脚本步骤。

**提交 lockfile 并用 `pnpm update` 重新解析。** 在两次更新之间保持可复现安装；被否决，因为用户选择完全不提交 lockfile，接受每次 install 都新鲜解析。

## Consequences

桌面自动跟踪最新上游发布：上游发版后下一次 `pnpm install` 即生效，无需专门变更。代价：install 不再可复现（不同时间的两次 install 可能解析到不同家族）；固定副本 `ConnectionController` 可能静默漂移，所以每次构建必须由 `verify:upstream` 把关，且重应用工作流（按记录 commit 抓取 `sourcePath`、复制进 `src/client/controller.ts` 并应用两处记录的机械改写、更新 `upstream.json` 的 version/commit）是手工步骤；未来上游发布若改变 peer 要求，在桌面自身 pin 或副本追上之前可能直接破坏 `pnpm install`。
