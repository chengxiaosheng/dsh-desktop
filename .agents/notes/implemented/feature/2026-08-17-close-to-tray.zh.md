# Agent Note: 系统托盘与关闭到托盘偏好

Status: implemented

[English](2026-08-17-close-to-tray.md) | 中文

## Problem

关闭主窗口在非 darwin 平台总是退出应用，无法让宿主在后台继续运行，产品也没有系统托盘。关闭窗口偏好只属于桌面壳层——纯 web harness 绝不能显示它——且每个面向用户的字符串都通过标准的 `locales.ts` 约定提供 `zh`/`en` 双语。

## Decision

关闭窗口行为是由桌面壳行持有的持久化偏好。node 半区（`src/index.ts`）通过既有 settings provider 注册 `desktop` 设置命名空间（`{ closeToTray: boolean }`，默认 `false`，`applies: 'live'`）；Electron 主进程在窗口关闭时经 `readCloseBehavior` 读取（任何异常读取都回退为退出），因此窗口打开期间修改的设置对下一次关闭立即生效。

渲染端行**不**经 settings wire 触达该命名空间：宿主 ApiProxy 的 `WEB_SETTINGS_NAMESPACES` 白名单对白名单之外的任何命名空间回答 `settings-not-exposed`，而该白名单是已发布 `dsh-host-apiproxy` 中的模块级常量（上游把「移到 `settings.register()`」标记为 deferred work）。因此行改为经桌面桥读写：preload 暴露 `getCloseBehavior`/`setCloseBehavior`（`dsh:close-behavior` 通道），主进程代写进程内 settings provider——它不受 wire 白名单约束。settings 文档仍是唯一持久事实源：行在启动时采纳存储值，主进程在关闭时读取同一值。

通用设置行（「关闭窗口行为」：退出应用 / 最小化到托盘）由壳层浏览器半区（`src/client/`）经 `settings.general.item` 槽位贡献，遵循当前 harness 行模式：按状态门控渲染（桥读取不可用时隐藏行、加载期间禁用触发器），并使用与上游逐字节一致的行 CSS（含 `:hover:not(:disabled)`）。字典位于 `src/client/locales.ts`，注册为 `settings.desktop` locale 命名空间；同一字典也承载托盘菜单文案。该行天然仅桌面可见：`dsh-plugin-desktop` 只挂载于桌面组合，纯 `dsh web` 运行中永远不会出现。

托盘在任意平台、无论设置如何都始终存在。隐藏的窗口必须有恢复路径，因此托盘不能随「隐藏窗口的设置」而条件性出现。菜单（打开主窗口 / 退出）每次打开前重建，其文案由渲染端在启动时与每次语言切换时经 `dsh:locale` 通道发布——托盘始终与应用实际显示的语言一致（显式偏好或浏览器探测皆覆盖），首次发布前以英文兜底。关闭拦截位于 `electron/main.ts`：`before-quit` 置位退出标志，窗口的 `close` 处理器在非真实退出时改为隐藏而非销毁（真实退出包括托盘退出、Cmd+Q、以及偏好关闭时的窗口关闭）。隐藏窗口经托盘、`second-instance` 与 macOS `activate` 恢复。

client bundle（`scripts/build-client.mts`）与上游产物形态一致：整个模块体位于 `window.__ModuleLoader__.load({ id, factory })` 交接内，跨包导入保持为 `require(...)` 调用，由 module loader 在运行时解析。`react`/`react/jsx-runtime` 必须是 renderer 自己的实例（hook 状态），`dsh-client-ui-primitives` 跟随上游 external 集合，`dsh-client-runtime/client` 本身是 loader bundle，无法内联。esbuild 的 CJS 输出以 `module`/`exports` shim 包进 factory；CSS modules 以哈希类名 + 带守卫的 `<style>` 注入内联。`tsconfig.build.json` 使用 `rewriteRelativeImportExtensions`，源码保留 `.ts` 说明符（node 测试可直接导入）而产物改写为 `.js`。

## Alternatives considered

**仅在偏好开启时显示托盘。** 已拒绝——在窗口已隐藏时关闭该偏好会让窗口失去恢复路径；常驻托盘保证任何隐藏都可恢复。

**用 `desktop` 命名空间走 settings wire。** 已拒绝——宿主 ApiProxy 的显式白名单拒绝它（`settings-not-exposed`），且白名单是上游发布的模块状态；经桥代写进程内 provider 既保住文档这一持久源，又不触碰上游。

**用开关代替双选项选择器。** 已拒绝——两个选项（退出应用 / 最小化到托盘）与偏好措辞完全对应，且选择器复刻了 harness 行模式。

**默认最小化到托盘。** 已拒绝——默认值保留既有行为（关闭即退出），不影响存量用户。

**把框架 store（`createSnapshotStore`）或 react 打进 client bundle。** 已拒绝——runtime client 本身是 ModuleLoader bundle（嵌套其 `load` 调用会破坏注册），而第二份 react 会破坏与 renderer 共享的 hook 状态。

**托盘文案在主进程读 `locale` 设置命名空间。** 已拒绝——该文档只承载显式偏好；浏览器探测出的语言会让托盘停留在英文。由渲染端发布已解析文案可同时覆盖两种情况。

## Consequences

用户获得常驻托盘（文案跟随应用实际显示语言）与双语的通用设置选项，设置持久化并在下一次关闭窗口时生效，默认行为不变；打包产物经既有 materialize 管线（复制 `lib/**`）自动携带 `lib/client.js`。代价：连接载体之外新增两个小桥通道（`dsh:close-behavior`、`dsh:locale`）；client bundle 构建是 CJS-factory 包装而非 connection 包的纯 IIFE（external 依赖 loader 的同步 `require`）；托盘图标复用窗口图标（`build/icon.png`），没有独立托盘资源；三个平台的托盘点击/菜单行为需要人工验证（Linux appindicator 随桌面环境而异）。