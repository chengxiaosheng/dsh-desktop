# Agent Note: 无 socket 的 webServer 拦截器插件

Status: implemented

English | [中文](2026-08-16-virtual-webserver-interceptor.zh.md)

## Problem

桌面产品要运行完整 Web UI 且无 Node HTTP 服务器、无端口。官方 `@deepseek-ai/dsh-host-webserver` 行在其服务 init 里绑定 node:http socket，官方 `connection` 与 `modules` 节点半身硬注入 `webServer`。无 socket 的桌面无法挂载这些行，而桌面端从不修改[已发布包](../process/2026-08-16-upstream-as-published-packages.zh.md)。

## Decision

桌面组合层禁用官方 `webserver` 行，挂载 `dsh-plugin-desktop/webserver`——一个 `VirtualWebServer extends Service`，以与官方完全一致的注册表契约提供 `webServer` 服务（`register`、`registerUpgrade`、`registerFallback`、`tapIndex`、`applyIndexTaps`、`host`、`port`，含重复抛错、最长前缀、单兜底座、tap 顺序语义），但其 `[Service.init]` 从不绑定 socket。`host` 上报 `127.0.0.1`，使 `web-runtime` 推导出仅 loopback 信任。官方 `connection` 与 `modules` 行照常挂载于其上；宿主在进程内分发——`/api` RPC 走 `connection.createSharedFetchHandler` 加 `toFetchHandler(apiProxy)`，其余所有 webserver 路由（含插件市场的 `/dsh-market/*`）走[插件市场集成笔记](2026-08-17-plugin-market-transport-and-services.zh.md)所述的全注册表代理。

## Alternatives considered

**内置真实 loopback webserver。** 这是 `deepseek-harness-desktop` 的设计：零包改动，但存在监听端口，被"零 socket"桌面排除。

**给 `@deepseek-ai/dsh-host-webserver` 加 `listen: false` 头模式。** 一个约 20 行的上游 seam 补齐可以避免重实现注册表契约，但桌面端从不修改已发布包；重实现的契约被固定版本并针对官方行为测试。

## Consequences

宿主无 socket，而 `connection`/`modules`/`ui-theme`/`web-runtime` 照常激活，由无头启动证明验证。代价：`VirtualWebServer` 重实现了约 90 行注册表语义，需与官方包保持同步；上游若有 `listen: false` 模式即可退役它。渲染端传输由[桌面客户端 connection 插件](2026-08-16-desktop-client-connection-plugin.md)覆盖。
