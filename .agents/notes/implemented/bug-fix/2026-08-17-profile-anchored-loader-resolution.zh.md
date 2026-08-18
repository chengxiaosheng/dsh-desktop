# Agent Note: 以 profile 为锚的加载器解析，让已安装插件在 Electron 下可加载

Status: implemented

[English](2026-08-17-profile-anchored-loader-resolution.md) | 中文

## Problem

在市场安装插件（如 `@liustack/modlens`）会把它写进 profile 的 `node_modules` 并把 `dsh.profile.bundles` 收尾——下一次启动却以 `Cannot find package '@liustack/modlens' imported from …/cordis-plugin-loader/lib/index.js` 失败。Cordis 加载器解析裸（非相对）条目 specifier 时，若有「内部」模块加载器（`node-addon-require-builtin` 暴露 Node 的 ESM 加载器）则走它，否则从加载器**自身**模块位置用 `import.meta.resolve`。普通 Node 下原生内部加载器存在，并把解析锚定到 profile（`bareModuleBaseUrl`）；而 **Electron** 下原生 addon 无法加载内部加载器，裸名就从工作区/打包树解析——profile 里安装的插件永远不会在那里。

## Decision

`bootDesktop` 的 prepare 钩子安装一个以 profile 为锚的 `ctx.loader.internal`（`createProfileLoaderInternal`，位于 `electron/loader-internal.ts`）：有原生 internal 时原样委托（普通 Node 上行为不变，它本就锚定 profile）；没有时用 `createRequire(profile package.json).resolve(...)` 解析裸 specifier 并 `import` 得到的文件 URL——纯 ESM，不依赖 Node 内部——使 Electron 下 profile 里安装的插件在启动时可解析。解析器也尊重仅 ESM 的 `exports` 映射：只声明 `import`/`types` 条件（无 `require`）的包会让 CJS `require.resolve` 以 `ERR_PACKAGE_PATH_NOT_EXPORTED` 失败（如 dsh-remote、@huanlin/dsh-plugin-mineru），此时钩子改为经包自身的 `package.json` 解析包目录并选取 `import`/`default` 入口。相对、绝对、`file:`/`data:`/`http(s):` 与 `node:` specifier 直接 import（相对按传入 base URL 解析）。

## Alternatives considered

**`--expose-internals`。** 需要在进程启动时携带；无法从启动钩子事后补上。

**把 profile 插件 symlink 进 heal 出来的 `$DSH_HOME/profiles/node_modules` 回退。** 方向错了——heal 回退镜像的是桌面包的依赖，不是 profile 安装；每次市场安装都要更新。

**`import.meta.resolve(specifier, parentURL)`。** 当前运行的 Node 构建不认 parent 参数（解析仍锚定调用方），故改用 `createRequire(profile)`。

## Consequences

在市场安装任意插件后应用都能启动（验证：带 `@liustack/modlens` 及仅 ESM 的 `dsh-remote`/`@huanlin/dsh-plugin-mineru` 的真实 profile 可启动；打包宿主仍可启动）。代价：桌面包持有一个加载器解析钩子，需跟踪加载器解析裸名的语义；回退先走 CJS `createRequire.resolve`，对仅 ESM 的包只重实现了 `exports["."]`/`main` 入口选取——exports 模式与条件子路径的其余情况在普通 Node 宿主上仍由原生内部加载器覆盖。
