# Agent Note: Windows-safe path separators in materialize and build-client

Status: implemented

English | [中文](2026-08-18-windows-materialize-path-separator.zh.md)

## Problem

`scripts/materialize.mts` `copyRuntime` guarded the flat-closure copy with `rel.split('/')[0]` to skip each package's nested `node_modules`. On Windows `path.relative()` is backslash-separated, so the guard never matched: the copy dragged in pnpm's nested-symlink tree, so `fs.cpSync` tried to recreate symlinks without the required privilege (EPERM) or shipped a bloated, non-flat closure — the Windows packaging job (`pnpm dist:win`) failed deterministically. `scripts/build-client.mts` had the same `split('/')` on a file path, producing whole Windows paths as CSS-module style-tag ids on that platform.

## Decision

Both split sites now split on either separator: `rel.split(/[\\/]/)[0]` in `materialize.mts`, and `args.path.split(/[\\/]/).pop()` in `build-client.mts`. On POSIX the regex behaves exactly as the old forward-slash split; on Windows it restores the intended flat-closure copy (nested `node_modules` skipped, zero symlinks in `dist-host/node_modules`) and the per-file style-tag id.

## Alternatives considered

**Normalize paths to forward slashes before splitting** (`rel.replaceAll('\\', '/')`). Equivalent result, more churn than a separator-class split.

**Use `node:path` `sep`/`parse` to walk the first component.** Correct but heavier than the regex split for a single first-component check.

## Consequences

Windows packaging no longer fails inside materialize from a separator mismatch, and the shipped `dist-host/node_modules` stays flat and symlink-free on every platform (verified: 260 package dirs, 0 symlinks after `package:dir`). Costs: the regex split is the only new surface; on POSIX it is behavior-neutral.
