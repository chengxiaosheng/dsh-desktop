# Agent Note: 插件市场集成——全路由 IPC 代理与桌面宿主服务

Status: implemented

[English](2026-08-17-plugin-market-transport-and-services.md) | 中文

## Problem

桌面运行完整 Web UI 且无 HTTP socket、无端口：渲染端 fetch 被打补丁，把主机请求经 preload 桥接发送，主进程的 `dispatchHttpRequest` 此前只通过 `toFetchHandler(apiProxy)` 服务 `/api` 的 GET/HEAD 下载面。[dshmarket](https://github.com/dsh-market/dsh-market) 插件市场——在官方 `webServer` 路由注册表上挂载二十余条 `/dsh-market/*` 路由并注入设置分区的社区插件市场——因此永远无法从桌面页面触达自己的路由：相对 `fetch('/dsh-market/status')` 会落到原生 `file://` fetch 并失败。为每个插件路由扩展桥接是朴素的修法，且不可扩展：未来每个插件的路由都需要一条定制的桥接腿。

安装市场插件还需要桌面未暴露的包管理器与 profile 收尾。市场已自带一套桌面契约（`desktopProfiles` + `desktopPnpm`，上游桌面 `plugin-services.md` 文档化的公开跨环境服务），但本桌面两者都没有提供，市场会回退去 spawn `dsh` CLI——而打包桌面并不带这个二进制。

## Decision

**预装市场。** `dshmarket` 是桌面包的依赖，由 `cordis.patch.yml` 的一条 insert 行挂载（`- id: dsh-market, name: dshmarket`），启动时经 heal 出来的 `$DSH_HOME/profiles/node_modules` 回退解析，与所有桌面依赖一致。其自身 bundle patch 不参与组合——行只在这里挂载一次。市场的 client bundle 自动进入渲染端图。市场安装进 profile 的插件在启动时经启动过程提供的、以 profile 为锚的加载器解析钩子加载，因为 Electron 无法承载加载器的原生内部模块加载器（见[加载器解析笔记](../bug-fix/2026-08-17-profile-anchored-loader-resolution.zh.md)）。

**把传输泛化为全路由 IPC 代理。** 渲染端（`dsh-plugin-desktop-connection` 的 `host-http.ts`）现在拦截**所有** `file://`（同源）与 `http://dsh.internal` 请求，并携带 method、headers 与 UTF-8 body。主进程（`boot-desktop.ts` 的 `dispatchHttpRequest`）经虚拟 `webServer` 路由注册表分发（`match` → exact/prefix，再落兜底座），用合成的 `IncomingMessage`/`ServerResponse` 替身——method、url、供 `readJsonBody` 使用的可异步迭代 body、缓冲的 `writeHead`/`end`，以及补全的 loopback `Origin`/`Host`（`127.0.0.1`），使市场的 `sameOrigin()` 校验与插件的 loopback 围栏都通过。exact 优先于 prefix，与官方服务器一致，故插件在 `/api/*` 下注册的路由会赢过 connection 的 `/api` prefix；只有匹配结果确实是 connection 自身 prefix 时，已验证的 `toFetchHandler` 快通道才服务 `/api` 平面（见[exact-`/api`-路由笔记](../bug-fix/2026-08-17-exact-api-routes-beat-connection-prefix.zh.md)）。任意插件路由都无需逐插件桥接即可进程内工作——这就是官方 HTTP 服务器路由的无 socket 类比。

**提供市场的桌面宿主服务。** `bootDesktop` 的 prepare 钩子（在 Loader 条目挂载前）经 `createDesktopServices` 注册 `desktopProfiles`（`{ current: { name: 'desktop', dir } }`）与 `desktopPnpm`。`desktopPnpm.runPlugin` 以 Electron 的纯 Node 模式（`process.execPath` 加 `ELECTRON_RUN_AS_NODE=1`）重新调用已发布的 `dsh plugin --profile desktop <args>` CLI——pnpm 加 `dsh.profile.bundles` 收尾的官方权威——以调用方目录为 cwd，并把内置 pnpm 的目录前置到子进程 PATH。`desktopPnpm.run` 以活动 profile 为 cwd 直接跑 pnpm（契约的低层腿）。每个世代至多同时一个包操作（第二个调用抛出市场可识别的 busy 消息）。

**内置 pnpm 以支持离线安装。** `@pnpm/exe` 是依赖；其安装期 `setup.js` 把平台独立二进制硬链接进自己的 `pnpm` 文件（经 `allowBuilds` 放行构建）。打包闭包含 `@pnpm/exe` 及其物化后的原生二进制，而平台包（`@pnpm/linux-*`/`win-*`/`macos-*`，仅安装期使用，每个约 150MB）被排除出闭包。内置二进制存在时在子进程 PATH 上优先；否则系统 `pnpm` 兜底。打包应用安装插件无需系统 Node。

## Alternatives considered

**按插件路由扩展桥接。** 否决——每个插件的路由都要一条定制桥接腿；全路由代理让所有插件的路由（以及 `/api`）都经一次注册表分发。

**让 `/dsh-market/*` 走 `/api` 快通道。** 否决——市场的路由是 exact 级 webServer 注册，不是 connection 的 `/api` prefix 路由；经 `webServer.match` 分发是唯一同时覆盖两者的机制。

**`desktopPnpm` 直接跑裸 pnpm 并自己收尾。** 否决——重新调用已发布的 `dsh plugin` CLI 复用了官方收尾逻辑（`dsh.profile.bundles`），贴合上游契约（`runPlugin` 跑 `dsh plugin --profile <active> …`），并随上游演进保持正确。

**只依赖系统 pnpm。** 应要求否决——打包应用应能在无系统 pnpm 时安装插件，故 `@pnpm/exe` 进闭包并在 PATH 上优先。

**待生效插件变更走整个应用重启。** 推迟——由配套的[宿主重启笔记](../feature/2026-08-17-host-reboot.zh.md)改走进程内重启。

## Consequences

市场在桌面端全链路可用：设置分区渲染、每条 `/dsh-market/*` 路由进程内分发、安装经真实 `dsh` CLI 且可离线用 pnpm，绝大多数变更热挂载无需重启。代价：`dshmarket` 与内置 pnpm（约 159MB）增大打包闭包；此处内置 pnpm 只服务 `linux-x64`——其他平台需由常规 `pnpm install` 在各自主机上经 `allowBuilds` 跑 `setup.js` 物化对应的 `@pnpm/*` 二进制；req/res 替身缓冲响应，长连接流式路由（SSE）不在桥接面内；市场自身的 restart 路由在 Desktop 模式保持禁用（重启由 shell 负责，见配套笔记）。
