# Agent Note: 上游以已发布 npm 包消费

Status: implemented

[English](2026-08-16-upstream-as-published-packages.md) | 中文

## Problem

本仓库在桌面运行时已经依赖已发布的 `@deepseek-ai/*` npm 包（版本族记录在 `packages/dsh-plugin-desktop/package.json`）的同时，还以 pin 的 Git submodule 保留了 `deepseek-harness/`。该 submodule 既不是 pnpm workspace 成员，也没有任何源码 import 它，其 pin 的 commit 相对运行时版本族已过期——它只买到一份本地只读参考，代价却是每次 clone 都要 `git submodule update --init`、内部多一份 `node_modules` 与 pnpm workspace、一个会漂移的 gitlink，外加一条"永远别在 submodule 里跑 pnpm"的规则。

## Decision

仓库只以已发布 npm 包消费上游。所有 `@deepseek-ai/*` 依赖在 install 时按 [`upstream.json`](../../../../upstream.json) 记录的 dist-tag 解析（dsh 家族为 `next`，cordis 框架为 `latest`；不提交 lockfile——见 [上游以 dist-tag 浮动解析](2026-08-17-upstream-dist-tag-floating.zh.md)），`upstream.json` 独立记录上游溯源：pin 的源码 commit、运行时包版本族、以及 `sourcePath`——即 `dsh-plugin-desktop-connection` 中固定副本 `ConnectionController` 重应用所依据的上游文件。submodule 的 gitlink、`.gitmodules` 与 submodule 工作区已删除。

## Alternatives considered

**保留 submodule 并直接构建其源码。** 把 submodule 的包 workspace-link 进桌面，直接跑上游源码；这会把桌面耦合到构建与 pin 上游，与"只消费已发布包"的边界相悖。

**保留 submodule 纯作参考。** 对运行时没有任何收益，却仍保留 clone 步骤、第二份 workspace 与漂移风险；`upstream.json` 加记录 commit 处的 raw GitHub URL 已覆盖唯一的重应用工作流（抓取 `packages/client/connection/src/client/connection.ts`）。

## Consequences

clone 与安装少了 submodule 步骤和第二份 workspace，仓库不再持有庞大的上游 checkout，也没有会漂移的 gitlink。代价：不再有本地上游源码 checkout，重应用固定副本 `ConnectionController`（以及未来任何 pin 的文件）需从记录 commit 处的上游仓库抓取；commit 与版本族两条溯源记录相互独立，升级时必须同时更新；"从不改上游"的边界如今建立在"消费已发布包"之上，而非文件系统边界。
