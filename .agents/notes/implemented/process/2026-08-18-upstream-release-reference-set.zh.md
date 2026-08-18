# Agent Note: 上游发版时桌面的引用集合一起移动

Status: implemented

[English](2026-08-18-upstream-release-reference-set.md) | 中文

## Problem

桌面从 npm `next` dist-tag 消费发布的 DeepSeek Harness 家族（见 [dist-tag 浮动说明](2026-08-17-upstream-dist-tag-floating.md)），并把 dshmarket 插件市场当作普通依赖。上游发版不会以一次原子编辑流入本仓库：多个引用指向发布状态，各有各的更新形态。两个是本仓库自己的文件（`upstream.json` 与固定的 `ConnectionController` 副本），一个在安装时解析（`@deepseek-ai/*` 家族），两个属于市场依赖（`dshmarket` 说明符与 workspace 的 release-age 排除项）。`verify:upstream` 只把关固定副本；完整的集合与移动顺序此前没有单一归宿。

## Decision

桌面的上游引用是：

1. `upstream.json` 记录固定的 `@deepseek-ai/dsh-client-connection` 版本及其上游 commit；家族发版时随发布版本与 commit 一起更新（当前 0.1.0-rc.7，commit `99f6f02`）。
2. `packages/dsh-plugin-desktop-connection/src/client/controller.ts` 是固定的 `ConnectionController` 副本，从记录 commit 处的 `sourcePath` 恢复，并套用两处记录的机械改写。仅当上游源码确实变化时才重应用；rc.7 的源码与 rc.6 逐字节相同，所以本次发版无需重应用。`verify:upstream`（由 connection 包的 `build` 运行）把已安装的 `@deepseek-ai/dsh-client-connection` 与 `upstream.json` 比对，不一致即失败并给出重应用指引。
3. 已安装的 `@deepseek-ai/*` 家族在 `pnpm install` 时从 `next` dist-tag 解析；`package.json` 声明的是标签而非版本，所以发版不伴随清单改动。
4. `packages/dsh-plugin-desktop/package.json` 携带 `dshmarket` 说明符，随发布市场更新（当前 `^1.12.1`）。
5. `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 指名已安装的 `dshmarket` 版本与整个 `@deepseek-ai/*` scope。pnpm 11 的 `minimum-release-age` 默认是 24 小时：发布在此窗口内的包会被从 dist-tag 解析中滤掉，所以新鲜发布的 `next` 家族会静默解析到上一代家族、新鲜发布的市场会被拒绝安装。正是这个排除项让当天发布的上游版本能解析出来。

发版时集合按此顺序移动：更新 `upstream.json` 的 version/commit 与 `dshmarket` 说明符及 release-age 排除项；当上游源码变化时从新的 `sourcePath` 重应用 `controller.ts`；运行 `pnpm install`；然后构建（会运行 `verify:upstream`）与各包 check。

## Alternatives considered

**只更新 `upstream.json` 让市场浮动。** caret 说明符 `^1.11.0` 已经会解析到最新市场，所以清单无需编辑。被否决：引用应写明产品实际随附的版本，且 release-age 排除项必须指名已安装版本，否则 pnpm 可能拒绝新发布。

**用提交的 lockfile 冻结家族。** 被所属 [dist-tag 浮动说明](2026-08-17-upstream-dist-tag-floating.md) 否决——install 对标签新鲜解析。

## Consequences

发版以一次可评审的变更经过仓库，而非在安装时静默到达；且市场的桌面契约（`desktopProfiles`/`desktopPnpm`）在 1.12.1 升级中保持不变，桌面服务无需适配。代价：若发版改变了 `ConnectionController` 源码或市场的桌面契约，需要手工重应用/适配步骤；新鲜解析策略意味着不同时间的两次 install 可能解析到不同家族。
