# Agent Note: Upstream resolved from dist-tags, no committed lockfile

Status: implemented

English | [中文](2026-08-17-upstream-dist-tag-floating.zh.md)

## Problem

The previous decision pinned every `@deepseek-ai/*` dependency at an exact runtime family and fixed the resolutions in a committed `pnpm-lock.yaml`, so an upstream release required a manual dedicated change (bump the family in `package.json`, bump the commit in `upstream.json`, re-apply the pinned `ConnectionController`). The user wants a consumer-style workflow instead: `pnpm install` resolves the newest upstream published packages automatically. Two registry facts shape the mechanism: the `@deepseek-ai/dsh-*` family is published under the `next` dist-tag (its `latest` tag still points at the ancient `0.0.1-rc.1` for most packages, so `latest` would install a broken, stale family), while the cordis framework packages (`@deepseek-ai/cordis`, `@deepseek-ai/cordis-plugin-*`, `@deepseek-ai/schemastery`) publish stable versions under `latest` and only rc variants under `next`.

## Decision

`packages/dsh-plugin-desktop/package.json` and `packages/dsh-plugin-desktop-connection/package.json` declare the `@deepseek-ai/dsh-*` family at the `next` dist-tag and the cordis framework packages at the `latest` dist-tag, so `pnpm install` resolves the newest upstream releases each time. `pnpm-lock.yaml` is not committed (it is gitignored), so installs resolve the tags fresh. `upstream.json` records the dist-tag the family follows (`tag: "next"`), the version the pinned `ConnectionController` copy was taken from, the upstream commit for that version, and the upstream `sourcePath` to re-apply from. The pinned copy stays source-of-truth-bound by a new gate: `dsh-plugin-desktop-connection`'s `build` runs `scripts/verify-upstream.mts`, which compares the installed `@deepseek-ai/dsh-client-connection` version against the recorded version and fails with reapply instructions on mismatch, so a floating family cannot silently ship a stale copy.

## Alternatives considered

**Declare the family at the `latest` dist-tag.** The user's literal first choice; rejected on registry evidence — for most `@deepseek-ai/dsh-*` packages `latest` resolves to `0.0.1-rc.1` while the current family lives under `next`, so installs would break peer constraints (`^0.1.0-rc.6`) and the whole composition.

**Keep committed pins and add an update script.** Preserves reproducibility and the dedicated-change flow; rejected because the user wants install itself to float, not a manual script step.

**Commit the lockfile and re-resolve with `pnpm update`.** Keeps reproducible installs between updates; rejected because the user chose not to commit the lockfile at all, accepting fresh resolution on every install.

## Consequences

The desktop tracks the newest upstream releases automatically: an upstream release flows in on the next `pnpm install`, with no dedicated change. The costs: installs are not reproducible (two installs at different times can resolve different families); the pinned `ConnectionController` copy can drift silently, so `verify:upstream` must gate every build and the reapply workflow (fetch `sourcePath` at the recorded commit, copy it into `src/client/controller.ts` with the two documented mechanical adaptations, update `upstream.json` version/commit) is a manual step; and a future upstream release that changes peer requirements can break `pnpm install` until the desktop's own pins or copies catch up.
