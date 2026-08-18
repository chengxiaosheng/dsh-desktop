# Agent Note: 可自助更新的插件市场，以内置版兜底

Status: implemented

[English](2026-08-18-market-override-update.md) | 中文

## Problem

插件市场是桌面包的硬 `dependencies`，由桌面 patch 的 `dsh-market` 行挂载、经 healed profile 回退解析。这带来两个后果：市场只能随桌面发版更新（版本锁定在应用上）；市场把自己列为"未安装"（它的已安装集合是 profile 的 `package.json` `dependencies`，里面从不出现 `dshmarket`）。用户想不重装桌面就从应用内更新市场——但天真地"把市场装进 profile"会破坏桌面：loader 对内置包闭包优先、`healProfilesModuleFallback` 在它管辖的符号链接处遇到真实目录会抛错、而 profile bundle 安装会组合出重复的 `dsh-market` 行 id（Cordis 整树 hard-fail）。

## Decision

市场仍内置为**兜底副本**，用户安装的 **override**（覆盖层）在下次启动时遮蔽它。构件：

1. `dshmarket` 移到 `optionalDependencies`。`healProfilesModuleFallback` 只遍历 `dependencies` + `peerDependencies`，于是它不再占用 `profiles/node_modules/dshmarket`——这个路径必须留给 override，因为渲染端的 client-modules 表（`createRequire(profile)`）与 loader 都从这里解析。
2. `bootDesktop` 自己维护这条 profile 链接（`ensureMarketFallback`）：默认符号链接到内置副本；存在真实 override 时不动它；损坏的 override（无可加载入口产物）则移除、清掉 profile 依赖、重新链接内置版。`normalizeMarketNotABundle` 把 `dshmarket` 从 profile 的 `dsh.profile.bundles` 中剔除（持久化），使市场自身管理的安装永远不会组合出重复行。
3. loader 对可覆盖包——`dshmarket`（`OVERRIDABLE_PACKAGES`）——profile 优先、闭包兜底（`createProfileLoaderInternal`），于是节点半边用 override，其余内置包保持闭包优先的单一实例。
4. 更新入口由桌面 shell 拥有，而非市场自身：设置 General 区的行（`MarketVersionRow`）经 preload 桥走 `dsh:market-version` IPC 通道，底层是 `electron/market-version.ts`。它读取内置/覆盖/registry 三版本，对候选版本做闭包 peer 兼容性闸门（闭包缺失或无法满足的 peer 一律拒绝——新拉一份 `@deepseek-ai/*` peer 会分裂服务身份），把精确版本写进 profile 的 release-age 排除（pnpm 默认 24h 门槛会拒绝当天发布的新版），并通过 `desktopPnpm.run` 做**只写依赖**的安装——绝不写 `dsh.profile.bundles`。回退移除 override，下次启动回到内置版。

## Alternatives considered

**把市场整体搬进 profile 作为普通 bundle，并在首启引导安装。** 让市场能直接自我管理，但首启强依赖联网安装（破坏离线基线与 headless 无 socket 的 boot proof），破损或当天发布的市场没有版本闸门，用户能把市场卸载到"什么都没有"，且抬高 peer 身份分裂风险。被否决——改为内置兜底 + 受控 override。

**更新走市场自己的管理流程。** 市场的通用安装会把包调和进 `dsh.profile.bundles`，组合出重复的 `dsh-market` 行；被否决——行由桌面拥有，版本自然也该由桌面控制。

## Consequences

用户从 **设置 → 插件市场版本** 更新内置市场，可见内置/覆盖/最新三态，并可一键回退到内置版——无需桌面发版。内置副本仍是离线、供应链受控的兜底；桌面闭包无法满足其 peer 的市场版本会被明确拒绝。代价：更新在下次重启宿主时生效（绝不热挂载）；DSH 内核演进时兼容性闸门要随之复核；`dshmarket` 不再是硬依赖，构建期安装失败会报"市场不可用"而非直接失败。
