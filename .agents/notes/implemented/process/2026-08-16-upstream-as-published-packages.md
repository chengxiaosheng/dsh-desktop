# Agent Note: Upstream consumed as published npm packages

Status: implemented

English | [中文](2026-08-16-upstream-as-published-packages.zh.md)

## Problem

The repository kept `deepseek-harness/` as a pinned upstream Git submodule while the desktop runtime already depended on published `@deepseek-ai/*` npm packages at the family recorded in `packages/dsh-plugin-desktop/package.json`. The submodule was not a member of the pnpm workspace, no source imported it, and its pinned commit was stale relative to the runtime family, so it bought only a local read-only reference at the cost of a `git submodule update --init` on every clone, a second `node_modules` and pnpm workspace inside it, a gitlink that could drift, and an extra standing rule never to run pnpm inside it.

## Decision

The repository consumes upstream as published npm packages only. Every `@deepseek-ai/*` dependency resolves from the dist-tags recorded in [`upstream.json`](../../../../upstream.json) at install time (`next` for the dsh family, `latest` for the cordis framework; no committed lockfile — see [Upstream resolved from dist-tags](2026-08-17-upstream-dist-tag-floating.md)), and `upstream.json` records the upstream provenance independently: the pinned source commit, the runtime package family, and `sourcePath` — the upstream file the pinned `ConnectionController` copy in `dsh-plugin-desktop-connection` is re-applied from. The submodule gitlink, `.gitmodules`, and the submodule working tree were removed.

## Alternatives considered

**Keep the submodule and build from its source.** Workspace-link the submodule's packages so the desktop runs upstream source directly; couples the desktop to building and pinning upstream, contradicting the published-packages-only boundary.

**Keep the submodule as a pure reference.** Retains the clone step, the second workspace, and the drift risk for no runtime benefit; `upstream.json` plus the raw GitHub URL at the recorded commit covers the only reapply workflow (fetching `packages/client/connection/src/client/connection.ts`).

## Consequences

The clone and install lose the submodule step and the second workspace, the repository no longer holds a large upstream checkout, and no gitlink can drift. The costs: there is no local upstream source checkout, so re-applying the pinned `ConnectionController` copy (and any future pinned file) fetches from the upstream repository at the recorded commit; the two provenance records (commit vs. family) are independent and both must be updated on a bump; and the "never edit upstream" boundary now rests on consuming published packages rather than a filesystem boundary.
