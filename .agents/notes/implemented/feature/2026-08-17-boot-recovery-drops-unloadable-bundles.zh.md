# Agent Note: 启动自愈——丢弃无法加载的 profile bundle

Status: implemented

[English](2026-08-17-boot-recovery-drops-unloadable-bundles.md) | 中文

## Problem

单个坏安装会让整棵树在启动时硬失败，应用永远打不开。`dsh-web-search-pro` 的 bundle patch 插入 `browser (@anweat/dsh-browser)` 一行，但该包未发布到 npm、也不在该 bundle 清单的依赖里——加载器无法解析，启动中止。用户只能手动改 profile，而桌面没有 CLI 可卸载。

## Decision

`bootDesktop` 在挂载前自愈。阶段一（`recoverMissingBundlePackages`，在 `loadProfile` 之前）丢弃自身包无法从 profile 解析的 bundle——`loadProfile` 对列出却无可用包的 bundle 会大声失败，否则启动在恢复前就中止。阶段二（`recoverMissingBundleRows`，在 `loadProfile` 之后）丢弃 patch 插入行引用了不可解析包的 bundle 层。两者都把移除持久化进 `dsh.profile.bundles`（经 `writeProfileManifest`）并告警。包仍留在 `dependencies`/`node_modules`：应用能启动，市场可正常卸载，包可用后重新加回 bundle 即可。可解析性用的是与加载器 profile 锚定解析相同的 ESM 感知检查（`canResolveBare`），故能解析但缺入口产物的包同样会被丢弃。

## Alternatives considered

**把缺失条目 stub 掉**（`{ name, apply() {} }`，市场 shim 模式）。否决——同 bundle 的兄弟行仍会挂载，坏插件每次启动都半死不活；用户要求的是删除。

**连 `dependencies` 一起移除。** 否决——启动时要跑 pnpm；保留安装让市场负责卸载，状态可恢复。

**只移除缺失的那个包。** 否决——该包根本不存在，该走的是拥有它的那个 bundle。

## Consequences

应用在坏安装下也能打开，日志点名被丢弃的 bundle 与缺失 specifier，并幂等地修剪该 bundle（清单不再列出，下次启动干净）。代价：启动过程拥有一次 profile 清单变更（只做移除，且经与加载器相同的解析判定为真正不可解析才触发）；若 bundle 只是临时不可解析（pnpm 安装中途状态）会被丢弃，需重新加回。
