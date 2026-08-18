# Agent Note: 以 profile 为锚的加载器解析，让已安装插件在 Electron 下可加载

Status: implemented

[English](2026-08-17-profile-anchored-loader-resolution.md) | 中文

## Problem

在市场安装插件（如 `@liustack/modlens`）会把它写进 profile 的 `node_modules` 并把 `dsh.profile.bundles` 收尾；一次无法解析它的启动以 `Cannot find package '@liustack/modlens' imported from …/cordis-plugin-loader/lib/index.js` 失败。Cordis 加载器解析裸（非相对）条目 specifier 时，若有「内部」模块加载器（`node-addon-require-builtin` 暴露 Node 的 ESM 加载器）则走它，否则从加载器**自身**模块位置用 `import.meta.resolve`。普通 Node 下原生内部加载器存在，并把解析锚定到 profile（`bareModuleBaseUrl`）；而 **Electron** 下原生 addon 无法加载内部加载器，裸名就从工作区/打包树解析——profile 里安装的插件永远不会在那里。

profile 优先解析还带来更严重的第二类故障：依赖 `@deepseek-ai/dsh-tools` 的市场插件（如 `dsh-office-tools`、`dsh-free-search`）会把第二个副本装进 profile 的 `node_modules`。加载器于是从该副本挂载 in-box 的 `tools` 服务，而 `dsh-agent-loop` 用的是应用的副本——两份副本各自持有不同的 `unique symbol` 身份 `TOOL_RUNTIME_SCHEDULER`（是 `Symbol(...)` 而非 `Symbol.for(...)`）。第一次工具分派用 agent-loop 的 symbol 读 `ctx.tools[TOOL_RUNTIME_SCHEDULER]`，读不到，整轮以 `Cannot read properties of undefined (reading 'prepare')` 崩溃——任何调用过工具的会话都会崩。

## Decision

`bootDesktop` 的 prepare 钩子安装一个安装闭包优先的 `ctx.loader.internal`（`createProfileLoaderInternal`，位于 `electron/loader-internal.ts`）。每个裸 specifier 先用 `createRequire(app install package.json).resolve(...)` 解析，使 in-box 单例服务（`tools`、`dsh-agent-loop`、`dsh-llm`、…）保持在应用的模块实例上；当安装闭包无法解析该名称时，钩子先委托给原生内部加载器（普通 Node 下存在，它完整尊重 profile 锚点与 ESM exports），否则用 `createRequire(profile package.json)` 解析——两条路径都能到达仅由用户安装的包。解析器也尊重仅 ESM 的 `exports` 映射：只声明 `import`/`types` 条件（无 `require`）的包会让 CJS `require.resolve` 以 `ERR_PACKAGE_PATH_NOT_EXPORTED` 失败（如 dsh-remote、@huanlin/dsh-plugin-mineru），此时钩子改为经包自身的 `package.json` 解析包目录并选取 `import`/`default` 入口。相对、绝对、`file:`/`data:`/`http(s):` 与 `node:` specifier 直接 import（相对按传入 base URL 解析）。钩子在所有宿主上同样权威——原生内部加载器只作为 profile 回退，从不作为主解析器——因此 in-box 包在普通 Node 与 Electron 下解析一致。

## Alternatives considered

**`--expose-internals`。** 需要在进程启动时携带；无法从启动钩子事后补上。

**把 profile 插件 symlink 进 heal 出来的 `$DSH_HOME/profiles/node_modules` 回退。** 方向错了——heal 回退镜像的是桌面包的依赖，不是 profile 安装；每次市场安装都要更新。

**`import.meta.resolve(specifier, parentURL)`。** 当前运行的 Node 构建不认 parent 参数（解析仍锚定调用方），故改用 `createRequire`。

**把已发布的 `dsh-tools` 中的 `TOOL_RUNTIME_SCHEDULER` 改成 `Symbol.for(...)`。** 能让任何副本共享同一 key、修复所有多副本部署，但需要改动桌面不受控的上游包并发版；保留为上游加固选项，此处未采用。

## Consequences

在市场安装任意插件后应用都能启动，且即使某个插件把同名副本拉进 profile，in-box 单例服务仍保持在应用的模块实例上。已验证：用带 `dsh-office-tools`/`dsh-free-search` 及其 profile 本地 `dsh-tools` 的真实 profile 启动，现在 `ctx.tools[TOOL_RUNTIME_SCHEDULER]` 保持已定义，含 `prepare`/`dispatch`/`finalize`/`finish`；而 profile 优先时它是 undefined，第一次工具调用即崩溃。用户安装的与 in-box 同名的包会被应用副本遮蔽。代价：桌面包持有一个加载器解析钩子，需跟踪加载器解析裸名的语义；in-box 包在普通 Node 宿主上也改走钩子对 `exports` 的部分重实现（Electron 下本就这样），因此超出该重实现的 exports 模式与条件子路径仅对回退到原生内部加载器的 profile 安装包被覆盖。
