# Agent Note: 根 README——双语、面向产品

Status: implemented

[English](2026-08-18-root-readme-bilingual-product-facing.md) | 中文

## Problem

根 `README.md` 原本是单份英文、面向工程的文档：开头讲零 socket 传输的内部机制与插件市场接线，章节为贡献者而非用户而写，也没有中文版。用户要求重写，让它先讲这个插件做什么——功能、运行模式与截图——并点名插件商店与上游项目，截图由用户后续自行补充。

## Decision

根 README 现在是双语对：`README.md`（英文）与 `README-cn.md`（中文），顶部互相链接并保持同步。两者都面向产品：先讲功能集（零 socket 完整 Web UI、内置插件市场、托盘与关闭到托盘、进程内宿主重启、随附 agent 预设、启动自愈），再讲运行模式（从源码运行、打包应用、无头启动验证），然后是作为文档化占位的截图章节——维护者把图片放入 `docs/screenshots/` 并更新相对路径——最后是引用章节，链接插件商店（`dshmarket`，默认市场）与上游项目（DeepSeek Harness，`upstream.json` 溯源）。工程内容浓缩为技术概览（零 socket 传输表、仓库布局、模型体验契约与已知限制）；深层细节留在 `docs/architecture.md` 与各包 README 中，概览按主题链接到它们。

## Alternatives considered

**保留单份英文 README。** 否决——用户明确要求中文版（`README-cn.md`），且项目自身的笔记与 locale 字典已遵循 `en`/`zh` 双语约定。

**保持工程优先的 README 并附加中文翻译。** 否决——用户要求以功能、运行模式与截图为中心的重写，而非对贡献者文档的翻译。

**编写时就内嵌截图。** 否决——截图由用户后续补充；README 携带带稳定相对路径（`docs/screenshots/*.png`）的占位块与更新说明，章节随时可填，无需再走一遍编辑。

**完全删掉技术内容。** 否决——用户选择保留精简技术概览而非彻底移除，保住仓库其余文档所依托的传输表与模型体验契约。

## Consequences

仓库的门面现在以两种语言面向用户，并在第一屏就指向插件商店与上游项目。代价：README 成为跨两个文件的维护承诺（i18n 一致性记录追踪两者的 blob 哈希），截图章节在维护者加入文件前渲染为破图占位，工程深度从 README 挪到 `docs/architecture.md` 深一层。
