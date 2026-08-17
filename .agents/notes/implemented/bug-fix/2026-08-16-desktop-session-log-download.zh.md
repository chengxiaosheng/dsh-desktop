# Agent Note: 桌面端虚拟主机桥接在进程内提供 Session 日志下载

Status: implemented

[English](2026-08-16-desktop-session-log-download.md) | 中文

## Problem

Session 头部下载按钮与 `/export` 指令报错「Session 导出失败 / Failed to fetch」。官方 `session-log-export` 客户端控制器先用原生 `fetch(new URL('/api/session.export', hostBase()), { method: 'HEAD' })` 探测主机，再把同一 URL 交给浏览器下载管理器（anchor）。`hostBase()` 返回 `location.origin`，除非它是字符串 `"null"` 才回退到 `http://dsh.internal`。桌面页面以 `file://` 加载，Electron 的 Chromium 将 `location.origin` 报告为 `"file://"`——而非 `"null"`——因此回退从不触发，控制器构建的是 `file:///api/session.export?...` 这类 URL。零 socket 桌面对这两个主机都没有 HTTP 服务器，因此 HEAD 探测以「Failed to fetch」拒绝；随后的 anchor 下载还会让 SPA 跳走，因为跨源时 `download` 属性被忽略。

## Decision

桌面连接渲染插件（`dsh-plugin-desktop-connection`）以 `ctx.effect` 贡献安装虚拟主机 HTTP 桥接。`patchFetch` 包装 `globalThis.fetch`，使所有指向桌面进程内主机面的请求——`http://dsh.internal`（上游空源回退）或控制器实际构建的 `file://` 源的 `/api/` 平面——以 `{ type: 'http-request', method, path, search }` 经 preload 桥接分发。`patchDownloadClicks` 在捕获阶段拦截 href 指向该面的 anchor 点击，阻止默认导航并下载目标；`patchAnchorClick` 补丁 `HTMLAnchorElement.prototype.click`，因为控制器点击的是**脱离 DOM** 的 anchor，其 click 事件永远不会到达 `document` 监听器。Electron 主进程的 `dsh:invoke` 把 `http-request` 消息路由给 `boot-desktop.js` 中的 `dispatchHttpRequest`，后者通过 `connection.createSharedFetchHandler` 加 `toFetchHandler(apiProxy)` 应答——与信封 RPC 相同的进程内分发——并返回 `{ status, headers, bodyBase64 }`。渲染端为 HEAD 探测重建 `Response`，并把 GET 响应体经 Blob URL 保存。只服务 `/api/` 下的 `GET`/`HEAD`；其他方法与路径一律拒绝，使桥接无法触及所组合 `/api` 平面之外。全流程有无头测试：桥接单元测试（两种主机形式的 HEAD 探测、GET 响应体、脱离与在 DOM 中的 anchor 点击拦截、外部主机放行）与对已启动桌面主机的 `dispatchHttpRequest` 测试（缺 sessionId 400、未知会话 404 带响应体、非 `/api` 404、方法 405）。

## Alternatives considered

**用特权自定义 scheme + `protocol.handle` 提供 SPA。** fetch 与 anchor 下载都经同一处理器解析，但会重写文档化的 `file://` 启动清单并拦截整个 scheme——为一次下载付出过大的改动面。

**在主进程拦截 `http` scheme 只处理虚拟主机，其他主机委托 `net.fetch`。** 原生处理 anchor 下载，但全局 `http` 拦截过宽，有波及渲染端合法外部 fetch 的风险。

**修改上游 `session-log-export` 控制器注入 fetcher/save。** [已发布包边界](../process/2026-08-16-upstream-as-published-packages.zh.md)禁止改动已发布包，且控制器在上游客户端代码内以默认值构造。

## Consequences

下载面在无 socket、无已发布包改动的情况下可用：HEAD 探测与 anchor 下载都在进程内分发，ZIP 经 Blob URL 保存。代价：ZIP 以 base64 跨 IPC 传输并在主进程内整体缓冲（web 服务器是流式输出）；桥接以 effect 贡献方式补丁浏览器全局（`globalThis.fetch` 与 `HTMLAnchorElement.prototype.click`）并安装 document 捕获监听（stop 时解挂）；`VIRTUAL_HOST` 钉住上游回退常量 `dsh.internal`——上游若重命名该常量，必须同步更新此副本。

## Related

该桥接与[桌面客户端连接插件](../architecture/2026-08-16-desktop-client-connection-plugin.zh.md)同乘渲染端 wire client；两者共同覆盖桌面传输，本笔记记录其上的原生 fetch 下载面。

