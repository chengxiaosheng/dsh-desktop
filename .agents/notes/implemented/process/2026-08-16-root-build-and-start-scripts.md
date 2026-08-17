# Agent Note: Root build and start scripts

Status: implemented

English | [中文](2026-08-16-root-build-and-start-scripts.zh.md)

## Problem

The root `package.json` exposed only `test`, so launching the desktop required knowing the per-package `pnpm --filter dsh-plugin-desktop start` incantation, and that `start` silently assumed `dsh-plugin-desktop-connection`'s esbuild client bundle (`lib/client.js`) already existed. There was no root-level way to compile a plugin; the compile steps lived only inside each package's own `build` script.

## Decision

The root `package.json` owns the launcher scripts. `pnpm build` runs `pnpm -r build`, compiling every workspace plugin that defines a `build` script, so any current or future plugin compiles from the root; `pnpm --filter <plugin> build` targets one. `pnpm start` builds the desktop-connection client bundle and then runs the desktop shell's `start` (`electron .`), so the renderer client is current whenever the window opens. `dsh-plugin-desktop` gained a `build` script that runs `node --check` over its ESM/CJS sources — it has no transform step, only parse verification, so `pnpm -r build` covers it too.

## Alternatives considered

**Keep per-package `start` only.** Leaves the stale-or-missing-bundle footgun and no root entry point, while the root is where the product is launched.

**Root `start` runs `pnpm build` (compile everything) first.** Broader and slower than needed; only the connection client bundle is a runtime prerequisite of the Electron window.

**A generic plugin-name dispatcher script.** More surface than the standard `pnpm --filter <plugin> build` idiom already provides.

## Consequences

The root is the single compile-and-launch entry point: `pnpm start` always serves a freshly built renderer bundle, and `pnpm build`/`pnpm --filter <plugin> build` compile any plugin from the root. The costs: `pnpm start` reruns the esbuild bundle on every launch (milliseconds), and `dsh-plugin-desktop`'s `build` is a pass/fail parse check rather than an artifact.
