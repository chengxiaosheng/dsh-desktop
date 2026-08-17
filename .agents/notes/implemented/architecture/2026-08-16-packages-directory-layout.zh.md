# Agent Note: 自有包归入 packages/

Status: implemented

[English](2026-08-16-packages-directory-layout.md) | 中文

## Problem

两个自有 npm 包位于仓库根目录（`dsh-plugin-desktop/` 与 `dsh-plugin-desktop-connection/`），而文档分层体系已把 `packages/` 命名为所交付源码的家，标准 pnpm monorepo 惯例也把自有包放在 `packages/` 目录下；根级包目录模糊了包与零散仓库目录的边界。

## Decision

两个桌面包位于 `packages/` 之下：`packages/dsh-plugin-desktop` 与 `packages/dsh-plugin-desktop-connection`。根 pnpm workspace 列出两个 `packages/*` 路径，桌面插件对连接插件的 `workspace:*` 依赖按包名解析而非路径，因此不变。包名、行 id、Cordis 组合以及模块级 `dsh-plugin-desktop/webserver` 引用均不动。启动测试的仓库根常量多上一层（`new URL('../../../', import.meta.url)`）；`electron/boot-desktop.js` 中未使用的 `REPO_ROOT` 被删除。`.gitignore`、`scripts/add-missing-deps.mjs`、根 `README.md`、根 `AGENTS.md` 与 `docs/architecture.md` 均引用 `packages/` 路径；`pnpm-lock.yaml` 的 importer 条目与 workspace `node_modules` 符号链接由 `pnpm install` 重新生成。

## Alternatives considered

**把包留在仓库根目录。** 改动最少，但与文档分层体系和 `packages/` 惯例相悖，未来自有包也无处安放。

**移入 `packages/` 并重命名包（作用域名）。** 重命名会改动所有行 id、patch 守卫名、import 与组合契约，却没有功能收益；本次迁移保持包名稳定，只改路径。

## Consequences

布局与文档分层体系和标准 monorepo 惯例一致，未来自有包有了明确的家，文档与脚本路径指向真实目录。代价：所有指向旧根级目录的路径引用都在同一变更中更新，任何遗留引用都会指向现在以 `packages/` 为根的目录树；包名与运行时组合不变，测试与行只在启动测试的仓库根路径上有差异。
