# Agent Note: Desktop launcher composes the shipped agent-preset root

Status: implemented

English | [中文](2026-08-16-desktop-shipped-preset-root.zh.md)

## Problem

The desktop profile (dsh-base + dsh-web-app) mounts `@deepseek-ai/dsh-agent-presets`, which builds its roster from `config.roots` plus the writable `$DSH_HOME/.agent-presets` root. The shipped presets (`standard`, `code`, `minimal`, `cordis`) live in the `@deepseek-ai/dsh` package's `config/agent-presets` tree, and the official `dsh` CLI patches that root into the `agent-presets` row from its `composeProfile`. The desktop launcher's `bootDesktop` composed only the bundle layers, the desktop patch, and the profile layer, so `config.roots` stayed empty. The roster then reported no presets, every session start failed with `agent-presets: preset "cordis" not found (available: none)`, and no preset rows mounted — the desktop showed 135 plugin entries versus 160 for `dsh web`, the 25-row gap being the preset's own rows.

## Decision

`bootDesktop` now composes the full patch stack through an exported `composeDesktopPatches(profile, desktopPatches, shippedPresetRoot)` helper. It builds the id→row index with `composeEntries`, and when the composition carries the `agent-presets` row, appends an id-targeted overlay that merges `roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }]` into the row config — the same assembly the official CLI's `composeProfile` performs. `SHIPPED_PRESET_ROOT` resolves from the install anchor's closure: `require.resolve('@deepseek-ai/dsh/package.json')` → `config/agent-presets`. The headless boot proof imports `composeDesktopPatches` and asserts a system-trust root is configured and all four shipped presets resolve.

## Alternatives considered

**Patch `cordis.patch.yml` with a literal root path.** The shipped root is an assembly fact — a path beside an installed package — not user config. A literal path in the patch would break packaging and would not track the installed `dsh` package. The official CLI makes the same launcher-side choice.

**Ship presets into the writable user root instead.** That would relocate the read-only deployment presets into user space, change their trust from `system` to `user`, and still not match the official roster.

## Consequences

The desktop roster now matches `dsh web`: all four shipped presets resolve with `system` trust, session creation and model selection no longer fail with `available: none`, and a session start mounts the preset's own rows, closing the 135 versus 160 entry gap. The writable user root stays `dsh-agent-presets`' own, so a composition that never reaches this patch still finds a person's presets. Keeping the shipped-root resolution in the launcher means a future move of where `@deepseek-ai/dsh` ships its presets must update `composeDesktopPatches` alongside the official CLI.
