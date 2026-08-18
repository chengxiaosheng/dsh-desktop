# Agent Note: materialize 与 build-client 的 Windows 安全路径分隔符

Status: implemented

[English](2026-08-18-windows-materialize-path-separator.md) | 中文

## Problem

`scripts/materialize.mts` 的 `copyRuntime` 用 `rel.split('/')[0]` 守卫扁平闭包复制，跳过每个包内嵌套的 `node_modules`。在 Windows 上 `path.relative()` 以反斜杠分隔，守卫永不命中：复制会把 pnpm 的嵌套符号链接树一并拖入，`fs.cpSync` 在无权限（EPERM）时尝试重建符号链接，或产出膨胀且非扁平的闭包——Windows 打包任务（`pnpm dist:win`）必然失败。`scripts/build-client.mts` 也在文件路径上用了同样的 `split('/')`，在该平台把整个 Windows 路径作为 CSS module 的 style-tag id。

## Decision

两处 split 现在都按任一分隔符切分：`materialize.mts` 用 `rel.split(/[\\/]/)[0]`，`build-client.mts` 用 `args.path.split(/[\\/]/).pop()`。在 POSIX 上与旧的前斜杠 split 行为完全一致；在 Windows 上恢复预期的扁平闭包复制（跳过嵌套 `node_modules`，`dist-host/node_modules` 零符号链接）与按文件的 style-tag id。

## Alternatives considered

**在切分前把路径归一化为前斜杠**（`rel.replaceAll('\\', '/')`）。结果等价，但比分隔符类 split 改动更多。

**用 `node:path` 的 `sep`/`parse` 取第一层**。正确，但对一次首层判断来说比正则 split 更重。

## Consequences

Windows 打包不再因分隔符不匹配在 materialize 内失败，产出的 `dist-host/node_modules` 在各平台都保持扁平且无符号链接（已核验：`package:dir` 后 260 个包目录、0 符号链接）。代价：新增的正则 split 是唯一新面；在 POSIX 上行为中性。
