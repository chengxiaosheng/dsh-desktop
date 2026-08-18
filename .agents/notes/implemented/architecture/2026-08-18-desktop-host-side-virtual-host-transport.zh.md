# Agent Note: 宿主侧虚拟主机传输（fetch/WebSocket 走上报的 webServer 端口）

Status: implemented

English | [中文](2026-08-18-desktop-host-side-virtual-host-transport.zh.md)

## Problem

桌面端的[虚拟 webserver 拦截器](../architecture/2026-08-16-virtual-webserver-interceptor.zh.md)是无 socket 的，其进程内分发只服务 renderer 侧补丁过的 `fetch`/`WebSocket`（走 IPC）。而第三方插件一旦读取 `webServer.port` 构造 harness 基址、并在宿主（Electron 主进程）侧发起调用，既没有可连的服务器，也没有可走的桥。`@xmanrui/dsh-im` 是具体案例：它 apply 期校验要求 `webServer.port` 落在 `[1, 65535]`，而虚拟 webserver 上报 `port: 0`，于是抛出 `dsh-feishu requires an initialized DSH webServer port`——这会让整个插件树加载失败、桌面无法打开。这不是 dsh-im 的缺陷：任何把"上报的主机/端口"当作可达 harness 表面的插件都会撞同一堵墙。

## Decision

桌面把虚拟主机作为**通用兼容面**提供给宿主侧代码，判定完全基于虚拟主机身份——全程没有任何插件专用代码。

**虚拟端口身份。** `VirtualWebServer.port` 在配置为 `port: 0`（即"无真实端口"的字面值）时上报 `VIRTUAL_HOST_PORT`（`51470`，`src/webserver.ts`）。刻意与 DSH GUI 的真实 `3080` 区分，避免两个 loopback 身份混淆。宿主桥按 `webServer.port` 实际上报值匹配，所以 profile 覆盖为非零端口时自动保持一致。

**宿主侧虚拟主机传输**（`electron/host-bridge.ts`），由 `bootDesktop` 在 `prepare` 钩子里安装——必须在 Loader 条目 apply 之前，因为插件的 `fetch`/`WebSocket` 引用在构造时被捕获——并以 context effect 注册，fiber dispose（含进程内宿主重启）时恢复进程全局：

- 补丁 `globalThis.fetch`：命中虚拟主机身份——loopback（`127.0.0.1`、`::1`、`localhost`）且端口等于上报端口，或 `dsh.internal` 名字——则经 `dispatchHttpRequest` 进程内分发；其余 URL 原样透传给真实 fetch。
- 补丁 `globalThis.WebSocket` 为 `HostVirtualSocket` shim：命中 URL 经共享 socket 核心进程内跑注册的 upgrade 路由，暴露浏览器 WebSocket 表面（`readyState`、`on*`、`send`、`close`、`addEventListener`、`binaryType`）；其余构造返回原生 WebSocket。`open` 前到达的消息先缓冲、open 后冲刷，贴合真实 socket 语义。

**修复 `/api` 快速路径。** `dispatchHttpRequest` 的 `/api` 平面现在把 method/headers/body 一并交给共享 fetch handler，而不是 `new Request(target, { method })` 的空壳——宿主侧 RPC 客户端的 `client-request`/`client-response` 信封与 renderer 载体走完全相同的解析（此前 body 被丢弃，RPC 直接 415）。

**共享 socket 核心。** 进程内 upgrade 分发从 IPC websocket 桥抽取到 `electron/virtual-host-socket.ts`（`BridgeSocket`、`VirtualUpgradeRequest`、`openVirtualHostSocket`），由 renderer IPC 桥与宿主侧 `WebSocket` shim 共用——一套帧解码、一个信任边界。

## Wire contract

宿主侧传输不是线协议：它补丁进程的标准 Web API，使 harness 表面出现在插件本来就会去找的地方。唯一可观察的契约变化是：`webServer.port` 在配置为 `0` 时上报非零虚拟端口。

## Alternatives considered

**在虚拟端口上跑真实 loopback HTTP/WebSocket 服务器。** 唯一能同时覆盖原生 `node:http`/`axios` 客户端的方案，但那是监听 socket，被零 socket 契约排除；fetch+WebSocket 这一标准 Web API 表面已覆盖真实客户端（dsh-im 的 HarnessClient 用 `fetch`，其 interaction 流开 `ws://…/api/events.mux`）。

**连 `node:http`/`https`（axios、got）也在主进程补丁。** 为一种没有已知插件使用的传输再做更重的全局补丁；推迟。只走原生 `http.request` 的客户端仍是文档化的缺口，其兜底就是上面那个 loopback 服务器。

**给 dsh-im 配置 `harnessBaseUrl`。** 逐插件的临时对策，而且桌面本来也无法向宿主侧代码提供那个 URL；不通用。

**上游让 dsh-im 容忍 `port: 0`。** 这不是桌面端该做的改动，而且只放过校验、不服务调用，只会把 apply 期崩溃换成静默重试循环。

## Consequences

**买到的：** 任何用标准 Web API 经 `webServer.port` 连 harness 的插件，都能在桌面里不改一行而工作——dsh-im 可装载、九个集成全部 apply、其 HarnessClient 的健康检查/RPC 往返都由进程内桥接服务（端到端验证：在装有 dsh-im 的 profile 上启动成功，`host.describe` 经桥接回 200，无 dsh-im 重试告警）。桥是通用的且保持无 socket，headless 启动证明仍然不绑定任何东西。

**代价：** Electron 主进程补丁了两个进程全局，靠虚拟主机匹配规则严格限定范围——匹配规则一旦过宽会分流无关的宿主流量。`HostVirtualSocket` 与 renderer shim 一样是接口仿真（`instanceof WebSocket` 不成立、无 permessage-deflate、`protocol`/`extensions` 为空）。`/api` 快速路径现在会读请求体，超大 body 会比旧的空壳分发多一份缓冲开销。

## Testing

`packages/dsh-plugin-desktop/tests/host-bridge.spec.ts` 启动真实桌面 profile 并验证：上报的虚拟端口；虚拟主机匹配规则；宿主侧 `fetch` 到虚拟主机完成 `/api` RPC 信封的进程内往返；非命中 URL 透传给真实 fetch；宿主侧 `WebSocket` 连上注册的 `ws` upgrade 路由（open、服务端→客户端、客户端→服务端、服务端 close）；fiber dispose 后全局恢复。重构后的 IPC websocket 桥保持其独立测试套件全绿，启动证明仍无 socket 运行。
