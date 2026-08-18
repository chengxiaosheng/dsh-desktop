# Agent Note: 用 electron-builder 做跨平台打包

Status: implemented

[English](2026-08-17-electron-builder-packaging.md) | 中文

## Problem

桌面产品没有任何可分发的产物：只有 `pnpm start`（开发启动），跨 mac/win/linux 交付意味着要在装有 Electron 与 workspace 的 checkout 里运行。README 把安装包列为 deferred。

## Decision

`dsh-plugin-desktop` 通过 electron-builder 26.15.3（`deepseek-harness-desktop` 与 `deepseek-harness/apps/desktop` 两个参考项目同版本）打包，采用物化布局：`scripts/materialize.mts` 产出 `dist-pack/`——一个薄的 asar 应用，其引导 main 只从 `resources/host` import 真实运行时、自身不 import 任何 `@deepseek-ai` 包——以及 `dist-host/`，按条目 `extraResources` → `resources/host` 运载编译后的 electron 运行时（`lib/electron`）、编译后的行源码（`lib/src`）、`cordis.patch.yml`、扁平依赖闭包（`node_modules/`，按 `healProfilesModuleFallback` 同样的方式遍历的真实文件）与声明整个闭包的 host manifest。打包 boot 锚定 `resources/host/package.json`，因此每个插件行——`dsh-plugin-desktop` 自身、`dsh-plugin-desktop-connection`、以及 `@deepseek-ai/*` bundle——都按名从真实目录解析。之所以如此，是因为整应用 asar 布局无法解析裸行说明符：Node 的 ESM loader 既不遍历 asar 内部 node_modules，也不会从嵌套 loader 位置应用应用的 self-reference，loader 会以 `Cannot find package 'dsh-plugin-desktop'` 中止（且 electron-builder 的 node_modules 收集器会裁剪闭包）。所有自有源码在物化前编译（desktop 的 `tsc` 产出 `lib/`，connection 的 node 半边 `tsc` 产出 `dist/`、客户端 bundle 产出 `lib/client.js`）。`verify:packaged` 无头启动打包后的 `resources/host`，断言 socketless host、connection 挂载与组合出的 file:// manifest。目标：mac DMG、win x64 NSIS、linux AppImage + deb；安装包目标限定原生主机；默认关闭代码签名（`CSC_IDENTITY_AUTO_DISCOVERY=false`），并保持 hardened runtime 关闭（`hardenedRuntime: false`），使未签名或 ad-hoc 构建不触发库校验拒绝。两个 workspace 固定让工具链在 pnpm 下可用：`app-builder-lib>@electron/get: ^3.1.0`（app-builder-lib 26.15.3 需要 `ElectronDownloadCacheMode`）与 `electron-winstaller: false`（其 Squirrel.Windows 构建脚本无用）。

## Alternatives considered

**整应用 asar + asarUnpack。** 最初的方案；loader 的裸 import 与应用自身的 self-reference 从 asar 内部 node_modules 均无法生效，且 electron-builder 的依赖遍历会裁剪仅含 peer 的闭包，打包应用无法启动。

**electron-forge。** 是有效备选，但偏离两个参考项目的工具链。

**继续推迟打包。** 三个平台都无法向用户交付应用。

## Consequences

产品从根目录 `pnpm dist:*` 产出 mac DMG / win NSIS / linux AppImage+deb，每个都经打包后 `resources/host` 的无头启动验证。代价：产物偏大（AppImage 约 230MB），因为整个依赖闭包以真实文件运载于 `resources/host`；每次打包变更都必须重作物化（它已是 `package:dir`/`dist:*` 的一环）；安装包目标要求原生主机；签名/公证被推迟；`@electron/get` override 与禁用 `electron-winstaller` 构建是 pnpm 特定的固定，依赖升级时必须保留。
