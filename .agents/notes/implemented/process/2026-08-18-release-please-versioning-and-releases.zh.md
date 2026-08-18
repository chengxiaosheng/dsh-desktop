# Agent Note: release-please 版本管理与 GitHub Release 产物

Status: implemented

[English](2026-08-18-release-please-versioning-and-releases.md) | 中文

## Problem

版本号靠手工改，打包 workflow 只把安装包上传为会过期的 workflow artifacts，用户没有一个稳定的地方按版本下载应用。没有任何自动发布：没有版本号升级、没有 changelog、没有标签，也没有携带安装包的 GitHub Release。

## Decision

用 release-please 加既有的打包 workflow 把版本生命周期与分发自动化。`.github/workflows/release-please.yml` 在每次 push 到 master 时运行 `google-github-actions/release-please-action@v4`，配置为 `release-please-config.json`（`release-type: node`、`package-name: dsh-desktop`、`bump-minor-pre-major: true`）：它按 Conventional Commits 推断下一版本，升级根 `package.json` 与两个 workspace `package.json`（经 `extra-files`），更新 `CHANGELOG.md`，并打开发布 PR。合并该 PR 即创建 `vX.Y.Z` 标签与 GitHub Release。`.github/workflows/build.yml` 本就在 `v*` 标签推送时触发；`package` job 现在获得 `contents: write`，且仅在标签推送时，对各自平台的安装包生成 `SHA256SUMS` 并用 `softprops/action-gh-release@v2`（`tag_name` 取 `github.ref_name`）把它们挂到该 Release。用户从仓库的 Releases 页面下载应用。代码签名保持关闭，分发的安装包为未签名。

## Alternatives considered

**纯手动 tag + build.yml。** 版本号、changelog、打标签全是手工步骤；单人可用，但用户要的是自动版本管理。

**一个 `workflow_dispatch` 发布 workflow 自己改版本并打标签。** 可预测但半手动；release-please 还顺带产出 changelog 与标准发布 PR。

**electron-builder 的 GitHub `publish` provider。** 在 electron-builder 内发布并启用 `electron-updater` 自动更新，但 mac 自动更新在未签名时不可用，而这里的 Release 资产流程已满足「用户从 Releases 下载」。

## Consequences

每次合并发布 PR 都会产生一个带标签的 GitHub Release，安装包（外加 `SHA256SUMS`）自动出现在 Releases 页面；用户按平台下载，不再依赖会过期的 workflow artifacts。代价：提交必须遵循 Conventional Commits，否则推断的版本会错；release-please 的发布 PR 流程需要适应；首次运行会基于 `0.1.0` 以来的全部提交推断下一版本（此前没有标签），首个发布号可能需要确认；release 资产随各平台构建完成陆续挂到已发布的 Release（约 10 分钟），期间 Release 短暂没有资产；发布出来的安装包仍未签名（签名是独立的后续步骤）。
