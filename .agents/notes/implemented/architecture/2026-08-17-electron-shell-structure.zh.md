# Agent Note: 模块化 Electron 壳层与打包管线

Status: implemented

[English](2026-08-17-electron-shell-structure.md) | 中文

## Problem

Electron main 此前是一个约 250 行的单文件模块，承担壳层的全部职责--生命周期接线、窗口创建、IPC 桥、渲染进程诊断与错误格式化--且存在平台生命周期缺口：任意窗口关闭即退出（没有 macOS 的 `activate`/`window-all-closed` 语义）、没有单实例锁（两次启动会在同一 profile home 上竞争）、没有 window-open/导航/权限防护，且 preload 路径经 URL `.pathname` 解析--在 Windows 上产出 `/C:/...`。electron-builder 配置内嵌于 package.json 的 `build` 字段（无法写注释），打包管线在四条 dist 脚本里各自重复一遍四步链。

## Decision

`electron/main.ts` 是只管应用生命周期的瘦组合根；其余壳层职责各自成模块，未来的壳层能力（更新、终端）在旁边挂载：`window.ts`（创建选项、`ready-to-show`、最小尺寸、linux 窗口图标、`setWindowOpenHandler` 全拒并对 http/https 走 `shell.openExternal`、`will-navigate` 锁定暂存页、权限请求全拒）、`page.ts`（`file://` SPA 暂存）、`ipc.ts`（桥接，每应用安装一次、renderer 按 send 解析）、`menu.ts`（macOS 角色菜单，其他平台置空）、`tray.ts`（系统托盘，由后续的关闭到托盘特性加入）、`diagnostics.ts`（渲染进程失败日志，外加 `DSH_DESKTOP_DEBUG=1` 开分离 devtools）、`errors.ts`（启动失败展平）。生命周期遵循平台惯例：`requestSingleInstanceLock` 配 `second-instance` 聚焦或重建窗口、`activate` 在 macOS 重建已关闭窗口、`window-all-closed` 仅非 darwin 退出、`will-quit` 在退出前释放宿主 fiber（profile 写入得以回绕），致命启动路径逐底层错误打一行日志并在打包状态下弹原生 `dialog.showErrorBox`。preload 路径改经 `fileURLToPath` 解析（Windows 正确），Windows 上把 app user model ID 设为 builder 的 `appId`。`boot-desktop.ts` 新增导出 `resolvePackageRoot()`，让 `window.ts` 复用唯一的包根回溯；`boot-desktop` 与 preload 的契约逐字不变（无头测试与 `verify:packaged` 原样导入），零 socket 的 `file://` 传输未动。

打包迁至独立的 `electron-builder.yml`（wrapper 显式传 `--config`；`publish: null` 使 builder 永不上传），linux 目标集为 AppImage + deb + rpm；`scripts/dist.mts` 一次跑完整管线--desktop 构建、connection 构建、materialize、electron-builder、无头打包启动验证--参数透传给 electron-builder，于是 package.json 的四条 dist 脚本各成一行，单目标构建（`--linux deb`）无需改脚本。`materialize.mts` 从 builder 配置读取 `productName`（单一来源；打包应用的 userData 由它派生），并把 `build/icon.png` 暂存到 `resources/host/build`，使打包后的 linux 窗口图标可解析。`tests/packaging.spec.ts` 解析该 yml 并断言契约：目标矩阵、身份字段、asar 暂存、extraResources 的 host 映射。

## Alternatives considered

**保留单文件 main。** 每个新壳层能力都会加宽同一文件并需要全量复核；否决--模块接缝本身就是扩展点。

**自定义特权协议（`app://`）替代 `file://` 页面。** URL 语义更干净，但会改变渲染端 connection client 虚拟主机桥所依赖的页面 origin（`location.origin === 'file://'`），那是 `dsh-plugin-desktop-connection` 的契约；超出本包范围。

**electron-forge。** 工具链正当，但偏离 electron-builder 参考项目。

**builder 配置留在 package.json。** 无法注释，且管线在四条脚本中重复；否决，改为 yml + dist 编排器组合。

**窗口 `backgroundColor`。** `ready-to-show` 已阻止未绘制窗口闪现，硬编码颜色反而可能不匹配 SPA 主题；放弃。

## Consequences

壳层通过在 `main.ts` 旁新增模块生长，而非加宽它；macOS 窗口生命周期、二次启动聚焦、优雅 fiber 释放、打包态启动失败报告均符合 Electron 平台惯例；打包目标矩阵由测试断言，配置编辑不会悄悄丢掉 rpm。代价：rpm 工件要求构建宿主安装 `rpmbuild`（Ubuntu 包 `rpm`）；菜单刻意最小（devtools 藏在 `DSH_DESKTOP_DEBUG=1` 之后而非菜单项）；权限处理器拒绝一切请求--若 SPA 将来需要通知或媒体能力需重新审视。
