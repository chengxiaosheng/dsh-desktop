# Agent Note: TypeScript 源码、tsc 产出、Node 类型剥离测试

Status: implemented

[English](2026-08-17-typescript-sources.md) | 中文

## Problem

全部自有代码都是纯 JavaScript：`dsh-plugin-desktop` 的"构建"只是 `node --check` 语法检查，渲染端 carrier 与打包脚本是带 JSDoc 契约的手写 JS，pinned 的 `ConnectionController` 是上游 TypeScript 文件的手工移植版，翻译过程中可能漂移。两个桌面包都没有类型检查。

## Decision

所有自有源码均为 TypeScript，经严格检查并由 `tsc` 编译：`dsh-plugin-desktop` 把 `src/` + `electron/` 产出到 `lib/`（tsc `rootDir` 为包根，因此 `lib/src/*.js` 与 `lib/electron/*.js` 镜像源码；`electron/preload.cts` 产出 Electron preload 契约要求的 CJS `preload.cjs`）。`dsh-plugin-desktop-connection` 把 node 半边（`src/index.ts`）产出到 `dist/src/`，并用 esbuild 把客户端半边打包成自包含的 `lib/client.js`（构建同时写出 `lib/client.d.ts`，让 bundle 测试可以带类型导入）。测试与打包脚本通过 Node 内置类型剥离运行（`node --test tests/*.spec.ts`、`node scripts/*.mts`）——engines 下限（Node ≥ 22.19）默认开启该能力——`erasableSyntaxOnly` 保证每份源码都可剥离。每包一份 `tsconfig.json`（noEmit、`strict`、`verbatimModuleSyntax`、`isolatedModules`、`allowImportingTsExtensions`、对已发布 `@deepseek-ai/*` 声明的 `skipLibCheck`）与 `tsconfig.build.json`（emit）驱动 `pnpm check` = 类型检查 + 测试、`pnpm build` = 编译。Pinned 的 `ConnectionController` 现在是按记录 commit 逐字恢复的上游 TypeScript 文件，仅有两处记录的机械改写：`./api.ts` 类型导入改写为 `@deepseek-ai/dsh-host-apiproxy/api`（`HostDescription` 在本地声明——rc.6 发布类型未携带它），以及构造函数参数属性改写为显式字段（参数属性不是可剥离语法）。`verify:upstream` 仍然把关 connection 构建。打包先编译再物化：`scripts/materialize.mts` 装载 `lib/electron` + `lib/src`，self 包闭包复制的是 `lib/`，因此 `package:dir`/`dist:*` 先跑 desktop 构建。desktop 包产出到 `lib/` 而非 `dist/`，因为 electron-builder 的输出目录就是 `dist/`。

## Alternatives considered

**保留 JavaScript + JSDoc。** 没有类型检查，controller 仍是手工移植；重写本身就是目标，故否决。

**测试也用 tsc 编译。** 增加 build-before-test 步骤与重复的导入扩展名处理；Node 类型剥离直接运行同一份源码，无需额外工具。

**tsx/vitest/jsdom 测试运行器。** 引入额外运行时依赖与工具面；纯 Node 的 fake-bridge 测试风格已能无浏览器覆盖 carrier。

**desktop 的 tsc 产出放到 `dist/`。** 与 electron-builder 输出目录冲突（安装产物与编译产物共享一棵树）；`lib/` 已在 .gitignore 中，且把两类产物分开。

**把 controller 恢复为重标注类型的 JS 移植版。** 重应用工作流仍含翻译步骤；上游文件本身就是 TypeScript，重应用因此改为逐字复制，故否决。

## Consequences

类型错误由 `pnpm check` 在启动前拦截，`node --check` 已移除。`pnpm start` 与打包必须先构建——编译产物现在是真实存在的，不再是源码直通。测试与脚本用 `.ts` 扩展名导入源码，交付代码保持 `.js` 说明符（Node 类型剥离不重写说明符；tsc 产出 `.js`），两种导入风格是有意为之并在文档中说明。rc.6 发布类型落后于部分运行时表面（`HostConnectionHandle` 未声明 `createSharedFetchHandler`/`dispatch`；desktop 的通用通道 `dispatch` 分支在 rc.6 运行时中并未实现，触达时仍然 reject——与 JS 原版一致），因此 IPC 边界处有少量带 cast 的局部表面。`erasableSyntaxOnly` 禁止在自有代码中使用 enum、namespace 与参数属性。源码每次变更后都要重建 connection bundle，因为测试会执行构建出的 `lib/client.js`。
