# Agent Note: 桌面虚拟宿主 WebSocket 桥接（走 IPC）

Status: implemented

English | [中文](2026-08-18-desktop-virtual-host-websocket-bridge.zh.md)

## Problem

桌面的[虚拟 webserver 拦截器](../architecture/2026-08-16-virtual-webserver-interceptor.md) 镜像了官方 `webServer` 契约（含 `registerUpgrade`），但没有 socket 就没有任何升级请求会被分发——插件对着宿主开浏览器 WebSocket 时没有可连的服务器。dsh-better-sidebar 的终端就是具体案例：其客户端 `new WebSocket(new URL('/sidebar/ws/terminal', location.origin))` 并把协议换成 `ws:`。在桌面的 `file://` 页面上 `location.origin` 是 `"file://"`，URL 解析器会静默拒绝 `file:` → `ws:` 的替换（需要 host 的特殊 scheme 无法替换掉 host 为空的 `file:`），于是 socket 用 `file://` URL 构造并抛出 `The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. 'file' is not allowed.` 即使 scheme 正确也依旧没有服务器可连。

## Decision

渲染端打补丁替换 `window.WebSocket`（`dsh-plugin-desktop-connection` 客户端，`host-websocket.ts`），使指向桌面宿主面的构造走 IPC 桥：任何 `file:` 派生的 URL（`file://` 页面唯一能产出的 origin）以及任何 `ws(s)://dsh.internal` URL 都解析到虚拟宿主，变成 `DesktopWebSocket` shim——即浏览器 WebSocket 接口（readyState、on\* 处理器、`send`、`close`、addEventListener、binaryType）跑在 preload 桥上。其余构造一律保留被捕获的原生构造函数。桥契约在 `DshDesktopBridge` 上新增四个成员（`wsOpen` invoke；`wsSend`/`wsClose` 单向；`onWsEvent` 订阅），在 Electron 主进程侧对应 `dsh:ws-open` / `dsh:ws-send` / `dsh:ws-close` / `dsh:ws-event`。

升级分发核心——桥接的 `Duplex`（`BridgeSocket`）、合成的 `GET` 升级请求（`VirtualUpgradeRequest`）与 `openVirtualHostSocket`——位于 `electron/virtual-host-socket.ts`，与[宿主侧虚拟主机传输](2026-08-18-desktop-host-side-virtual-host-transport.zh.md)的宿主侧 `WebSocket` shim 共用；IPC 桥（`electron/websocket-bridge.ts`）只负责 renderer 侧接线。主进程在进程内分发升级：按 pathname 查 `webServer.upgrades`，合成 `GET` 升级请求（回环 `Host`/`Origin`、全新 `Sec-WebSocket-Key`、可选 `Sec-WebSocket-Protocol`）使插件自己的信任围栏放行，并把桥接的 `Duplex` 与空 head 交给路由。路由的 `wss.handleUpgrade` 完成真实握手并产出真实的 `ws` 实例——`ws` 库在主进程内拥有整个协议，因此不需要复制 socket、端口或帧编解码。桥通过 `ws` 的私有 `kWebSocket` 符号（`Symbol('websocket')`，按 description 查找）在 socket 上定位该实例，并按消息级事件转发：

- 服务器→客户端数据：Sender 写入 socket 的帧被解码（帧可能跨多次 write 拆分，故部分字节先缓冲）后以 `ws-message` 推送；
- 客户端→服务器数据：以带掩码的帧推回 socket 的可读侧，恰好像真实客户端一样喂给 `ws` receiver；
- 服务器关闭帧会被回显为带掩码的关闭帧，使关闭握手立即完成（否则 ws 要等满 30 s closeTimeout 也等不到永远不会来的对端关闭帧），随后产生的 `close` 事件携带服务器真实的 code 与 reason；
- 渲染端主动 close 时推入带掩码的关闭帧，让握手以渲染端的 code 正常完成；与 open 竞争先到的 close 会被记住，待 socket 一旦建立即拆除。

每个打开的 socket 都绑定到打开它的渲染端上下文：主帧导航或 web contents 销毁会终止这些 socket，插件的 `close` 处理器把这种情况当作裸 socket 掉线（pty 保留其重连宽限期）。`installIpc` 的 disposer 会 dispose 桥，因此进程内宿主重启会随代际一起拆除全部 socket。

## Wire contract

四个消息形状声明了两遍——连接客户端 `ipc-api-client.ts` 里的 `DesktopWsOpenRequest` / `DesktopWsOpenResult` / `DesktopWsEvent`，与桌面包 `electron/websocket-bridge.ts` 里的逐字镜像——遵循仓库惯例：桥的两端各持有一份契约副本。

## Alternatives considered

**在主进程跑一个真正的回环 WebSocket 服务器。** 零 socket 桌面排除了任何监听 socket，而无 socket 契约正是无头启动证明能在无浏览器环境下运行的前提。

**在渲染端 shim 里解码帧（完整实现客户端 WebSocket）。** 会复制 `ws` 已经实现的线上协议（掩码、长度编码、分片、UTF-8 校验），并把信任边界挪进渲染端。

**双向透传原始字节，让渲染端说线上协议。** 同样的重复实现，且渲染端还要自行校验握手。

**改插件上游。** dsh-better-sidebar 的 URL 构造可以避开 `file:` 派生 URL，但桌面依旧没有可连的 WebSocket 服务器，插件只会换成另一个错误；缺口在桌面的升级分发，本桥对所有插件一并补上。

**等升级落定后再回复 invoke。** 处理器在 open 回复到达前就会写数据（终端 transcript 回放）；shim 会把连接期间收到的消息缓冲起来，因此 open 回复与首批消息竞速是安全的。

## Consequences

虚拟 webserver 契约的 `registerUpgrade` 半边现在被真正服务了：开宿主 WebSocket 的插件（终端、推送流）无需任何插件改动即可在桌面工作，桥仍然无 socket。代价：主进程持有帧解码器（只解服务器→客户端帧；关闭帧回显，ping/pong 丢弃），并依赖 `ws` 的私有 `kWebSocket` 符号按 description 查找——若未来 `ws` 改名，open 会以 "websocket upgrade did not complete" 失败，降级但可见。shim 是接口模拟而非字节级复刻：`instanceof WebSocket` 对 shim 实例不成立（被测插件从未使用）、`protocol` 与 `extensions` 报告为空、永不定制 permessage-deflate（渲染端不发 `Sec-WebSocket-Extensions`，因此压缩帧不会出现）。`file:` scheme 的 WebSocket 按定义就是宿主工作——桌面没有其他服务器面——所以此类构造一律被转向，与 HTTP 桥的同源规则一致。

## Testing

`packages/dsh-plugin-desktop/tests/websocket-bridge.spec.ts` 启动一个最小进程内宿主（cordis context + 虚拟 webserver + 一个 better-sidebar 风格的 `WebSocketServer({ noServer: true })` 升级路由）并驱动完整转发：open、服务器→客户端数据、客户端→服务器数据、服务器主动关闭（含 code/reason）、客户端主动关闭、拒绝与拆除。`packages/dsh-plugin-desktop-connection/tests/host-websocket.spec.ts` 用假桥覆盖 shim 状态机（open/refuse/buffer/close/send/patch）。两者都在既有测试套件里无头运行；启动证明依然无 socket 启动。
