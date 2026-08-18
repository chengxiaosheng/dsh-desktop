# Agent Note: 进程内分发中，`/api` 下的 exact 插件路由优先于 connection 的 `/api` prefix

Status: implemented

[English](2026-08-17-exact-api-routes-beat-connection-prefix.md) | 中文

## Problem

`dispatchHttpRequest` 在查 webserver 路由注册表之前，把每个 `/api/*` 请求都短路到组合好的 `toFetchHandler(apiProxy)` 快通道。凡是在 `/api/*` 下注册 **exact** 路由的插件——如 dsh-usage-stats 的 `/api/usage-stats/usage`、`/providers`、`/balance`——都会被遮蔽：官方服务器是 exact 优先于 prefix，这些路由永远不应答，桌面返回 404。还有第二个独立缺陷：合成的 `Host` 头携带的是虚拟主机名（`dsh.internal`），过不了插件的 loopback 围栏——dsh-usage-stats 的 `rejectForeignCaller` 要求 loopback Host，这与官方服务器 `127.0.0.1:<port>` 的请求一致。

## Decision

`dispatchHttpRequest` 现在先查 `webServer.match`（exact → prefix），并分发任何非 connection 自身 `/api` prefix 路由的匹配。只有匹配结果确实是 connection 的 `/api` prefix（即无 exact 路由的 `/api/*` 路径）时，才保留已验证的 `/api` 快通道——保住 session 日志下载与 unary RPC 面的既有行为。未匹配的非 `/api` 路径仍落入 SPA 兜底座。合成的 `Origin`/`Host` 现携带 loopback 身份（`http://127.0.0.1` / `127.0.0.1`），同时满足市场的 `sameOrigin()` 与插件的 loopback 围栏。

## Alternatives considered

**把快通道挂成真正的 `/api` prefix 路由，并让所有请求都走注册表。** 语义等价，但会把已验证的 session 日志面挪到注册表的 req/res 替身上；受保护的快通道让该面保持逐字节一致。

**合成 `localhost`。** 可行，但 `127.0.0.1` 与官方服务器实际的 loopback 绑定一致。

## Consequences

带 `/api/*` 路由的插件在桌面可应答（对装有 dsh-usage-stats 的 profile 验证：usage/providers/balance 返回 200 带真实数据、方法拒绝 405；市场与 session 日志面不变；打包宿主仍可启动）。代价：分发正确性现在依赖 `webServer.match` 的 exact-over-prefix 顺序与 loopback 头合成——两者都由启动回归测试断言（`/api/probe-route` 优先于快通道；无路由的 `/api/*` 仍落入 apiProxy 平面）。
