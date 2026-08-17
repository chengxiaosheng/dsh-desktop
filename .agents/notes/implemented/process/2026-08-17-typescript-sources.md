# Agent Note: TypeScript sources, tsc emit, Node type-stripped tests

Status: implemented

English | [中文](2026-08-17-typescript-sources.zh.md)

## Problem

All owned code was plain JavaScript: `dsh-plugin-desktop` "built" with `node --check` syntax checks, the renderer carrier and the packaging scripts were hand-typed JS with JSDoc contracts, and the pinned `ConnectionController` was a manual port of the upstream TypeScript file that could drift in translation. No desktop package had type checking.

## Decision

All owned sources are TypeScript, checked strictly and compiled by `tsc`: `dsh-plugin-desktop` emits `src/` + `electron/` to `lib/` (tsc `rootDir` is the package root, so `lib/src/*.js` and `lib/electron/*.js` mirror the sources; `electron/preload.cts` emits the CJS `preload.cjs` Electron's preload contract requires). `dsh-plugin-desktop-connection` emits its node half (`src/index.ts`) to `dist/src/` and bundles the client half with esbuild to the self-contained `lib/client.js` (the build also writes `lib/client.d.ts` so the bundle test can import it typed). Tests and packaging scripts run through Node's built-in type stripping (`node --test tests/*.spec.ts`, `node scripts/*.mts`) — the engines floor (Node ≥ 22.19) enables it by default — and `erasableSyntaxOnly` keeps every source strip-compatible. Per-package `tsconfig.json` (noEmit, `strict`, `verbatimModuleSyntax`, `isolatedModules`, `allowImportingTsExtensions`, `skipLibCheck` over the published `@deepseek-ai/*` declarations) and `tsconfig.build.json` (emit) drive `pnpm check` = typecheck + tests and `pnpm build` = emit. The pinned `ConnectionController` is now the upstream TypeScript file restored verbatim at the recorded commit with two documented mechanical adaptations: the `./api.ts` type import rewritten to `@deepseek-ai/dsh-host-apiproxy/api` (with `HostDescription` declared locally — the rc.6 published types do not ship it), and the constructor's parameter properties spelled as explicit fields (parameter properties are not erasable syntax). `verify:upstream` still gates the connection build. Packaging compiles before materializing: `scripts/materialize.mts` stages `lib/electron` + `lib/src` and the self-package closure copy is `lib/`, so `package:dir`/`dist:*` run the desktop build first. The desktop package emits to `lib/` rather than `dist/` because electron-builder's output directory is `dist/`.

## Alternatives considered

**Keep JavaScript + JSDoc.** No type checking and the controller stays a manual port; rejected because the rewrite is the point.

**Compile tests with tsc too.** Adds a build-before-test step and duplicate import-extension handling; Node type stripping runs the same sources directly with no extra tooling.

**tsx/vitest/jsdom test runners.** Extra runtime dependencies and toolchain surface; the plain-Node fake-bridge test style already covers the carrier without a browser.

**Desktop tsc output in `dist/`.** Collides with electron-builder's output directory (installers and compiled runtime would share a tree); `lib/` is already gitignored and keeps the two artifacts separate.

**Restore the controller as a re-typed JS port.** Keeps a translation step in the reapply workflow; rejected because the upstream file itself is TypeScript, so the reapply is now a verbatim copy.

## Consequences

Type errors are caught by `pnpm check` instead of at boot, and `node --check` is gone. `pnpm start` and packaging require a build first — the compiled artifacts are real now, not source passthrough. Tests and scripts import sources with `.ts` extensions while shipped code keeps `.js` specifiers (Node type stripping does not rewrite specifiers; tsc emits `.js`), so the two import styles are intentional and documented. The published rc.6 types lag some runtime surfaces (`HostConnectionHandle` omits `createSharedFetchHandler`/`dispatch`; the desktop's generic-channel `dispatch` leg is not implemented by the rc.6 runtime and still rejects when reached — preserved from the JS original), so small local surfaces with casts sit at the IPC boundary. `erasableSyntaxOnly` bans enums, namespaces, and parameter properties in owned code. The connection bundle is rebuilt after every source change because tests exercise the built `lib/client.js`.
