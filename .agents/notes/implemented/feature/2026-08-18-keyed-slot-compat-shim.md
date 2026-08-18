# Agent Note: Keyed-slot compatibility shim for rc.6-era client plugins

Status: implemented

## Problem

DSH 0.1.0-rc.7 tightened the client slot contract: keyed slots (`settings.plugin.item`, `tool.call.toolview`, …) now require `options.key`, and `@deepseek-ai/dsh-client-ui-slots` throws `keyed slot "<name>" requires options.key` when a plugin registers without one — failing that plugin's client entry. Third-party plugins written against rc.6 register into these slots with only `id` (dsh-free-search 0.4.5 is the shipped example). In the desktop composition a failed client entry surfaces as "Failed to load plugins / <name>", so one stale market plugin takes down an otherwise-fine rc.7 boot. Upstream is never vendored or edited, so the desktop — the composition owner — absorbs the change.

## Decision

The desktop connection carrier (`dsh-plugin-desktop-connection`'s client half, the first client entry, `immediately: true`) installs a keyed-slot compatibility shim (`src/client/slots-compat.ts`) at apply time: it subscribes to Cordis's `internal/service` event and wraps the `slots` service's `register` the instant the service is provided — synchronously, inside the provide's notification pass, ahead of every deferred entry apply, so no slot declaration or plugin registration can precede the wrap.

The wrapper synthesizes a key for a registration that targets a keyed slot and omits `key`. The key is normalized to the settings-namespace convention first (`dsh-free-search` → `free-search`, stripping a leading `dsh-` or scoped `@scope/dsh-`), because in rc.7 the configurable-plugins tab dispatches `settings.plugin.item` **per served namespace** — a card renders only when its key is a namespace the host serves (`settings.describe`). An asynchronous repair pass then re-reads the served namespaces through `ctx.connection.api.settings.describe` (bounded retries while the host settles) and re-registers any keyless entry whose key missed under the first served candidate (convention form, then raw name) — covering plugins whose namespace keeps the package prefix (dsh-remote serves `dsh-remote`, not `remote`). The repair is idempotent (a served key is never re-repaired), and each repaired entry's disposer is chained onto the plugin-facing disposer so plugin unload cleans both entries.

The patch is precise, not blanket: only slots whose declared kind is `keyed` are touched (`service.spec(name)?.kind === 'keyed'`); an unresolvable kind is patched conservatively, because adding a key is the load-preserving direction. rc.7 ignores `key` for single/list slots, so non-keyed registrations pass through with no injected key. The wrap is idempotent (a WeakSet allows one wrap per service instance) and self-disarming: once upstream plugins pass a real, served `key`, it is forwarded untouched.

## Alternatives considered

**Host-side bundle rewriting.** Rejected — the Electron main controls the client manifest but rewriting market plugins' bundled `client.js` text (regex over minified JS) to inject keys is fragile and per-plugin; the renderer wrap fixes the whole class of keyed slots in one place.

**Wrapping `ctx.slots.register` inside a desktop client entry's apply.** Rejected — client entries mount concurrently (`Promise.all`) and `ctx.slots` is provided by a non-immediate entry, so the wrap would race market-plugin registrations. The `internal/service` event fires synchronously at provide time, before any deferred apply, which removes the race.

**Weakening the slot declaration (keyed → non-keyed).** Rejected — the declaration lives in the upstream `dsh-client-ui-settings-plugins` children table; the desktop cannot edit upstream, and changing the kind would alter rendering semantics for every plugin.

## Consequences

rc.6-era market plugins that register into keyed slots load on rc.7 instead of failing the boot, and — when their namespace follows a discoverable convention or is served by the host — their `settings.plugin.item` card renders in Settings → Plugins instead of disappearing. Costs: the shim is a compatibility layer that masks upstream contract drift, so it stays small, documented, and idempotent; the card rendering depends on the host serving the namespace the card's key resolves to, which the asynchronous repair derives by convention rather than from a per-plugin contract, so a plugin whose namespace follows neither the `dsh-`-stripped nor the raw-name form loads but may not render its card. When upstream plugins add a real, served `key` themselves, the wrapper and repair are no-ops. The connection client suite covers key synthesis, normalization, the served-namespace repair, precision (list/single untouched), the unknown-kind fallback, idempotency, and the provide-time wiring.

## Related

The upstream breaking change is the same one reported for third-party plugins at [ysr666/dsh-vision-router#165](https://github.com/ysr666/dsh-vision-router/issues/165) (`keyed slot "settings.plugin.item" requires options.key` on 0.1.0-rc.7).
