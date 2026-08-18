# Agent Note: 由桌面客户端插件通过 Electron IPC 提供渲染端 connection

Status: implemented

English | [中文](2026-08-16-desktop-client-connection-plugin.zh.md)

## Problem

桌面产品要运行完整 Web UI 且无 Node HTTP 服务器、无端口。宿主侧已经无 socket——[虚拟 webserver 拦截器](../architecture/2026-08-16-virtual-webserver-interceptor.md) 提供的 `webServer` 服务不绑定 socket，官方 `connection` 与 `modules` 节点半身照常挂载。渲染端仍需要 wire client：在 `file://` 下官方 `@deepseek-ai/dsh-client-connection` 客户端半身（`WebApiClient`，HTTP + WebSocket）没有可连的服务器。桌面必须改用 Electron IPC 桥来提供 `ctx.connection`。

## Decision

桌面组合层禁用官方 `connection` 行，并把 `dsh-plugin-desktop-connection` 作为新行 `desktop-connection` 挂载。patch 层不能改行的包名（patch 上的 `name` 是守卫而非改名），所以替换方式是"禁用 + 插入"而非改名。

- **节点半身**（`dsh-plugin-desktop-connection` 的 `src/index.ts`）原样 re-export 官方 `@deepseek-ai/dsh-client-connection` 的 apply：`HostConnectionService`、`/api` prefix 路由、两条下行 upgrade 路由与 web profile 完全一致，挂载在虚拟 `webServer` 之上。
- **客户端半身**（构建到 `lib/client.js`，由 `dsh.client` 声明、`exports["./client"]` 提供）打包了一个 `IpcApiClient`——`AbstractApiClient` 子类，其 `doFetch` 经 preload 桥的 `invoke` 走 unary/respond，`openMux`/`openHost` 经桥的 `subscribe` 泵两条下行流——外加一份固定版本、载波无关的官方 `ConnectionController` 副本（构造器只收 `IApiClient`），并装配标准 `ctx.connection` ConnectionHandle。桥契约（`DshDesktopBridge`）是本载波知道的唯一 Electron 依赖。同一客户端 bundle 还承载虚拟主机 HTTP 桥接，把所有 `file://` 与 `http://dsh.internal` 请求——session 日志下载面与所有插件路由（`/dsh-market/*`）——改经桥接分发；参见[下载桥接笔记](../bug-fix/2026-08-16-desktop-session-log-download.zh.md)与[插件市场集成笔记](2026-08-17-plugin-market-transport-and-services.zh.md)。

`dsh.client` 只声明在 `dsh-plugin-desktop-connection` 上，且该包只被一个行引用：client-modules 表按行名键控、不做按包去重——一个被多个行引用的包会按行各发射一次 client bundle，而同一作用域内两个 `connection` provider 会被 Cordis 拒绝（`service "connection" has been registered`）。

Electron main 在进程内启动 profile，用 `clientModules.graph()` 组装启动图并把每个 bundle URL 重写为绝对 `file://` 路径，然后经 IPC 承载传输：`ipcMain.handle('dsh:invoke')` 通过 `connection.createSharedFetchHandler` 加 `toFetchHandler(apiProxy)` 分发 unary/respond，`dsh:subscribe`/`dsh:unsubscribe` 把 `apiProxy.events.mux`/`host` 泵给渲染端。preload 经 `contextBridge` 暴露 `window.__DSH_BOOT__`（sendSync）与 `window.dshDesktop`。

## Alternatives considered

**改官方 `connection` 客户端 apply 选择 IPC 载波。** `feat/desktop-electron` 分支走的是这条路（在 connection 客户端里加 `window.dshDesktop` 分支）。它改的是已发布包，本仓库的[已发布包边界](../process/2026-08-16-upstream-as-published-packages.zh.md)不允许。

**patch 已发布的 `@deepseek-ai/dsh-client-connection` 产物。** `deepseek-harness-desktop` 项目会为打包 bug patch npm 产物，但往打包后的客户端里注入 IPC 载波会把桌面钉死在某个 bundle 布局上，且每次上游升级都漂移。

**在官方行旁边叠加提供 `connection`。** Cordis 拒绝同一作用域内两个 provider 提供同一服务，且浏览器半身与节点半身走同一行——没有按半身禁用的机制。

**保留 loopback socket 上的官方 HTTP/WebSocket 载波。** 这是 `deepseek-harness-desktop` 的设计：零包改动，但存在监听端口，被"零 socket"桌面排除。

## Consequences

渲染端在无 socket、不改已发布包的前提下拿到可用 wire client；节点半身与上游逐字节一致。代价：`ConnectionController` 是一份固定副本（运行时版本族升级时需从上游源重应用，见其文件头注释）、桌面 bundle 重新内嵌了 `@deepseek-ai/dsh-host-apiproxy` 模块、桌面组合里 `connection` 行的 id 变成了 `desktop-connection`。`dsh.client` 单行约束是文档化的组合不变量。
