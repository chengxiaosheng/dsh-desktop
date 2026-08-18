# Agent Note: 用精确进程名匹配替换 NSIS 运行检测

Status: implemented

[English](2026-08-18-nsis-running-app-check-false-positive.md) | 中文

## Problem

electron-builder 26 内置的 NSIS `CHECK_APP_RUNNING` 用「路径前缀」匹配运行中的进程（PowerShell `Get-CimInstance` `Path.StartsWith($INSTDIR)`）。在有些机器上，某条无关进程的路径恰好以安装目录开头，即使从未安装过 DSH Desktop 也会判定「应用在运行」；点确定后会无限循环——被匹配的进程不是应用本身、杀不掉，安装永远无法完成。

## Decision

`packages/dsh-plugin-desktop/build/installer.nsh` 定义 `customCheckAppRunning` 宏，经 `nsis.include: installer.nsh` 被 electron-builder 识别，整体替换内置检测（定义了该宏后 `CHECK_APP_RUNNING` 就分发到它）。替换实现只做精确进程名匹配——`tasklist /FI "IMAGENAME eq dsh-desktop.exe" | findstr`，即 electron-builder PR #9784 的做法。`dsh-desktop.exe` 是本产品独有进程名，因此只有真实运行中的实例才会弹窗；点确定后 `taskkill /IM ... /F` 强制结束并继续安装。安装器与卸载器分别编译、每次构建只展开一次 `CHECK_APP_RUNNING`，宏内的 `doStopProcess` 标签不会冲突。

## Alternatives considered

**空实现宏（完全跳过运行检测）。** NSIS 风险为零，但失去「安装/升级前关闭正在运行的应用」这一对常驻托盘应用有意义的特性。

**升级 electron-builder。** 路径前缀检测本身就是 PR #9069/#9784 修复后的逻辑；升级版本并不会消除误报。

## Consequences

干净机器安装不再触发运行检测；真实运行中的实例（例如隐藏在系统托盘中）在安装/升级前仍会提示关闭。代价：自定义 NSIS 宏必须随 electron-builder 模板演进（精确匹配语法与 26.15.3 模板绑定）；误报只在受影响的机器上复现，宏无法在本仓库环境外做完整编译验证；Windows 安装包需要重建（v0.1.1）才能带上修复。
