# DSH Desktop

[English](README.md) | 中文

一个基于 **未修改** 的、已发布的 DeepSeek Harness 包构建的桌面产品：完整 Web UI **无 Node HTTP 服务器、无端口** 运行，完全由 Cordis 插件组合在 `@deepseek-ai/*` 家族之上。桌面壳层（窗口、托盘与系统集成）运行于 Electron；每一项能力（无 socket 的 webserver、渲染端 connection、壳层本身）都是一个插件行，因此每一项都能从配置中替换，而不触碰任何已发布包。

- **上游项目**：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 本产品所包装的开源 agent harness。
- **插件商店**：[dsh-market](https://github.com/dsh-market/dsh-market) —— 内置于应用中的社区插件市场。

## 功能

### 零 socket 宿主的完整 Web UI

在桌面窗口中运行完整的 DeepSeek Harness Web UI（会话日志、工具、模型路由、agent 循环）。宿主从不绑定 socket：虚拟 `webServer` 拦截器以官方路由注册表契约提供服务但不开端口，渲染端 wire client 改乘 Electron IPC 桥接而非 HTTP/WebSocket，所有宿主路由（`/api` 平面、会话日志下载与任意插件路由）都在进程内分发。官方 `modules`、`ui-theme`、`web-runtime` 与 `frontend-static` 行照常激活。

### 内置插件市场

默认内置 [dshmarket](https://github.com/dsh-market/dsh-market)：打开 **设置 → 插件市场**，浏览、搜索并一键安装社区插件。市场的 `/dsh-market/*` 路由经进程内宿主分发，桌面端提供市场的宿主契约（`desktopProfiles` + `desktopPnpm`）。安装走真实的 `dsh plugin --profile desktop …` CLI 与内置 pnpm，因此打包应用即使没有系统 Node 或 pnpm 也能安装插件。已安装的插件在下次启动时经以 profile 为锚的加载器钩子加载。

### 系统托盘与关闭到托盘

系统托盘（打开主窗口 / 重启宿主 / 退出）在任意平台始终存在，其文案跟随应用实际显示的语言。通用设置中的一个偏好决定关闭窗口的行为：退出应用，或隐藏到托盘并在后台继续运行宿主。

### 进程内宿主重启

无法热加载的变更（例如需要重启的市场安装）通过设置 General 分区的「重启宿主」或托盘的「重启宿主」项应用：宿主 dispose 后进程内重新启动、重装 IPC 桥接并 reload 渲染端——Electron 进程、窗口与托盘保持在线。

### 随附 agent 预设

桌面端组合随附的 agent-preset 根目录，使预设名册与 `dsh web` 一致：`standard`、`code`、`minimal` 与 `cordis` 预设以 `system` 信任解析，会话启动不再报 `preset not found`。

### 启动自愈

坏安装永远不会阻止应用打开：包无法解析的 bundle 会在挂载前从 profile 清单中丢弃（附告警），应用在下一次干净启动时自愈。

## 运行模式

### 从源码运行（开发）

```sh
pnpm install         # 按 upstream.json 记录的 dist-tag 解析 @deepseek-ai/*
pnpm build           # 编译 TypeScript 源码（tsc + esbuild + verify:upstream 门禁）
pnpm check           # 每个包严格类型检查 + 测试
pnpm start           # 构建后启动 Electron 应用
```

### 打包应用

`dsh-plugin-desktop` 经 electron-builder 分发可安装产物：

```sh
pnpm package:dir      # 当前宿主的未签名解包应用（dist/<platform>-unpacked）
pnpm dist:mac         # macOS DMG（在 macOS 主机上）
pnpm dist:win         # Windows x64 NSIS 安装包（在 Windows 主机上）
pnpm dist:linux       # Linux AppImage + deb + rpm（在 Linux 主机上）
```

### 无头启动验证

传输层以无头方式验证——假桥接与 profile 启动，无需浏览器、socket 或窗口：

```sh
pnpm -r test          # 无头启动证明 + client 载波测试
```

Electron 窗口就是测试所启动的同一进程内宿主的可运行壳层。

## 运行截图

> 截图由维护者后续补充。以下区块为占位——请将图片放入 `docs/screenshots/` 并更新路径。

![主窗口](docs/screenshots/home.png)

*主窗口：桌面壳层中的完整 DeepSeek Harness Web UI。*

![插件市场](docs/screenshots/dshmarket.png)

*内置插件市场：浏览、搜索与一键安装。*

## 引用

- **上游项目** —— [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）：本桌面所包装的开源 agent harness。本仓库只消费**已发布**的 `@deepseek-ai/*` 包，按 [`upstream.json`](upstream.json) 记录的 dist-tag 解析（dsh 家族为 `next`，cordis 框架为 `latest`）；这里没有上游源码 checkout。
- **插件商店** —— [dsh-market](https://github.com/dsh-market/dsh-market)（`dshmarket`）：社区插件市场。桌面端把它作为默认市场内置；发布到 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 注册表的第三方插件都会出现在这里。

## 技术概览

### 零 socket 传输

| 组成 | 行 / 包 | 取代 |
|---|---|---|
| 无 socket webserver | `dsh-plugin-desktop/webserver` | 官方 `webserver` 行（禁用） |
| 渲染端 wire client | `dsh-plugin-desktop-connection` | 官方 `connection` 行（禁用）——节点半身原样 re-export 上游，客户端半身改乘 Electron IPC |
| 启动清单 | Electron preload（`window.__DSH_BOOT__`） | 服务器 index tap |
| RPC 分发 | `ipcMain`（`connection.createSharedFetchHandler` + `apiProxy`） | HTTP/WebSocket 载波 |
| 虚拟主机 HTTP 代理 | `dsh-plugin-desktop-connection` client + `dispatchHttpRequest`（main） | 宿主 HTTP 面——任意 webserver 路由经 IPC 进程内分发 |

### 仓库布局

```
upstream.json                    上游溯源（dist-tag + 固定副本版本/commit）
packages/
  dsh-plugin-desktop/             壳层行、虚拟 webserver、Electron main、打包
  dsh-plugin-desktop-connection/  渲染端 Electron IPC wire client
docs/                           架构地图
.agents/notes/                   Agent Notes（决策记录）
```

### 模型体验

桌面是标准 DeepSeek Harness agent 之上的展示与传输面。它不改变任何模型可见行为：底层运行同样的会话日志、工具、模型路由与 agent 循环。传输（Electron IPC 替代 HTTP/WebSocket）与无 socket 宿主对模型不可见。

### 已知限制

- Electron 壳层极简：一个窗口加 IPC 桥接。终端、profile 管理、更新与签名发布均推迟。
- 宿主重启是手动的（设置动作与托盘项）；自动触发等待持久的宿主可读信号。
- 渲染端 `ConnectionController` 是上游源码的固定副本；`verify:upstream` 在已安装版本族不一致时使构建失败，需从记录 commit 处重新应用。
- 桌面保持零 socket 宿主；`deepseek-harness-desktop` 项目是另一种 loopback 载波设计，可作对比。
