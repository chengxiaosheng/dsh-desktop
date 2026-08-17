# Agent Note: 桌面启动器组合随附的 agent-preset 根目录

Status: implemented

English | [中文](2026-08-16-desktop-shipped-preset-root.zh.md)

## Problem

桌面 profile（dsh-base + dsh-web-app）挂载 `@deepseek-ai/dsh-agent-presets`，其 roster 由 `config.roots` 加上可写的 `$DSH_HOME/.agent-presets` 根目录构成。随附 preset（`standard`、`code`、`minimal`、`cordis`）位于 `@deepseek-ai/dsh` 包的 `config/agent-presets` 目录，官方 `dsh` CLI 通过其 `composeProfile` 把该根目录补丁进 `agent-presets` 行。桌面启动器的 `bootDesktop` 只组合了 bundle 层、桌面补丁层和 profile 层，因此 `config.roots` 始终为空。结果 roster 报不出任何 preset，每次会话启动都失败并报 `agent-presets: preset "cordis" not found (available: none)`，也没有任何 preset 行挂载——桌面显示 135 个插件条目，而 `dsh web` 是 160 个，25 行的差距正是 preset 自身的行。

## Decision

`bootDesktop` 现在通过导出的 `composeDesktopPatches(profile, desktopPatches, shippedPresetRoot)` 辅助函数组合完整补丁栈。它用 `composeEntries` 建立 id→行索引，当组合带有 `agent-presets` 行时，追加一个按 id 定向的 overlay，把 `roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }]` 合并进该行配置——与官方 CLI 的 `composeProfile` 所做完全一致。`SHIPPED_PRESET_ROOT` 从安装锚点的依赖闭包解析：`require.resolve('@deepseek-ai/dsh/package.json')` → `config/agent-presets`。无头启动测试导入 `composeDesktopPatches`，并断言已配置 system-trust 根目录且四个随附 preset 都能解析。

## Alternatives considered

**在 `cordis.patch.yml` 里写死字面量根路径。** 随附根目录是装配事实——已安装包旁边的一个路径——不是用户配置。补丁里写死路径会破坏打包，也不会跟随已安装的 `dsh` 包变化。官方 CLI 同样选择在启动器一侧处理。

**改为把 preset 装进可写的用户根目录。** 那会把只读的部署 preset 移进用户空间，把它们的信任从 `system` 改成 `user`，而且仍然和官方 roster 不一致。

## Consequences

桌面 roster 现在与 `dsh web` 一致：四个随附 preset 都以 `system` 信任解析，会话创建和模型选择不再报 `available: none`，会话启动会挂载 preset 自身的行，从而补齐 135 对 160 的条目差距。可写的用户根目录仍归 `dsh-agent-presets` 所有，因此没有走到这个补丁的组合仍能找到用户的 preset。把随附根目录的解析留在启动器，意味着未来 `@deepseek-ai/dsh` 移动 preset 存放位置时，必须和官方 CLI 一起更新 `composeDesktopPatches`。
