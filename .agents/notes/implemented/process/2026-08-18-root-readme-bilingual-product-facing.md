# Agent Note: Root README — bilingual, product-facing

Status: implemented

English | [中文](2026-08-18-root-readme-bilingual-product-facing.zh.md)

## Problem

The root `README.md` was a single, English, engineering-oriented document: it opened with the zero-socket transport internals and the plugin-market wiring, its sections were written for contributors rather than users, and there was no Chinese counterpart. The user asked for a rewrite that leads with what the plugin does — features, runtime modes, and screenshots — and that names the plugin store and the upstream project, with the user supplying the screenshots later.

## Decision

The root README is now a bilingual pair: `README.md` (English) and `README-cn.md` (Chinese), cross-linked at the top and kept in sync. Both are product-facing: they lead with the feature set (zero-socket full Web UI, built-in plugin market, tray + close-to-tray, in-process host reboot, shipped agent presets, boot self-healing), then the runtime modes (from source, packaged app, headless boot proof), then a screenshots section that is a documented placeholder — the maintainer drops images into `docs/screenshots/` and updates the relative paths — and finally the references section that links the plugin store (`dshmarket`, the default market) and the upstream project (DeepSeek Harness, `upstream.json` provenance). The engineering content is condensed into a technical overview (the zero-socket transport table, the repository layout, the Model Experience contract, and the known limitations); the deep detail stays in `docs/architecture.md` and the per-package READMEs, which the overview links to by subject.

## Alternatives considered

**Keep a single English README.** Rejected — the user explicitly asked for a Chinese version (`README-cn.md`), and the project's own notes and locale dictionaries already follow the bilingual `en`/`zh` convention.

**Keep the README engineering-first with a Chinese translation appended.** Rejected — the user asked for a rewrite centered on features, runtime modes, and screenshots, not a translation of the contributor document.

**Embed the screenshots directly in the README at authoring time.** Rejected — the user will supply the screenshots later; the README carries placeholder blocks with stable relative paths (`docs/screenshots/*.png`) and a note to update them, so the section is ready to fill without another edit pass.

**Dump all technical content.** Rejected — the user chose to keep a condensed technical overview rather than remove it entirely, preserving the transport table and the Model Experience contract that the rest of the repository's documentation builds on.

## Consequences

The repository's front door now speaks to users in two languages and points to the plugin store and the upstream project from the first screen. Costs: the README is now a maintenance commitment across two files (the i18n consistency record tracks their blob hashes), the screenshots section renders as broken-image placeholders until the maintainer adds files, and the engineering depth lives one hop deeper in `docs/architecture.md` rather than in the README itself.
