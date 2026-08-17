# DSH Desktop repository rules

This repository builds a desktop product around the **unmodified** published DeepSeek Harness packages: a socketless `webServer` interceptor plugin, a desktop-owned renderer `connection` plugin over Electron IPC, and an Electron shell. Documentation and decisions follow the DeepSeek Harness conventions (this root file, [`docs/AGENTS.md`](docs/AGENTS.md), and [Agent Notes](.agents/notes/README.md)).

- `packages/dsh-plugin-desktop/` and `packages/dsh-plugin-desktop-connection/` own the desktop plugin rows and the boot proof.
- Every `@deepseek-ai/*` runtime package comes from the npm registry at the version pinned in `packages/dsh-plugin-desktop/package.json` and recorded in [`upstream.json`](upstream.json); never depend on, vendor, or edit upstream source from this repository.
- The outer repository and all owned packages use the root pnpm workspace.
- Headless boot proof must run without a browser or a listening socket.
- **Every non-trivial change adds or updates an Agent Note** in the same change (rules in [`.agents/notes/README.md`](.agents/notes/README.md#when-to-write-one)); only mechanical/local edits are exempt.
- **Document current state, not change history**, one physical line per paragraph, one home per fact ([`docs/AGENTS.md`](docs/AGENTS.md)).
- **Comments and JSDoc state complete contracts, not reasoning transcripts.**
- Read [`docs/architecture.md`](docs/architecture.md) before changing the desktop packages.
- Registrations are effects: every contribution goes through `ctx.effect()` / `ctx.on()` so stop/update/unload unwinds it.
- Package READMEs document config, semantics, limitations, and the [Model Experience](README.md#model-experience) format.
