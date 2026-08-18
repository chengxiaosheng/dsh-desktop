# Agent Note: User-updatable plugin market with a bundled fallback

Status: implemented

English | [中文](2026-08-18-market-override-update.zh.md)

## Problem

The plugin market ships as a hard `dependencies` entry of the desktop package, mounted by the desktop patch's `dsh-market` row and resolved through the healed profile fallback. Two consequences follow: the market updates only when the desktop releases (the version is pinned to the app), and the market lists itself as "not installed" (its installed set is the profile's `package.json` `dependencies`, which never carries `dshmarket`). The user wants to update the market from inside the app, without a desktop release — but a naive "install it into the profile" breaks the desktop: the loader resolves in-box packages closure-first, `healProfilesModuleFallback` throws on a real directory where it manages a symlink, and a profile-bundle install composes a duplicate `dsh-market` row id (Cordis hard-fails the whole tree).

## Decision

The market stays built-in as the **bundled fallback**, and a user-installed **override** in the profile shadows it on the next boot. The pieces:

1. `dshmarket` moves to `optionalDependencies`. `healProfilesModuleFallback` walks only `dependencies` + `peerDependencies`, so it stops claiming `profiles/node_modules/dshmarket` — the path where an override must live for both the renderer's client-modules table (`createRequire(profile)`) and the loader to see it.
2. `bootDesktop` maintains that profile link itself (`ensureMarketFallback`): a symlink to the bundled copy by default, left alone when a real override exists, and a broken override (no loadable entry artifact) is removed, its profile dependency cleared, and the bundled copy re-linked. `normalizeMarketNotABundle` strips `dshmarket` from the profile's `dsh.profile.bundles` (persisted), so a market-managed install can never compose the duplicate row.
3. The loader resolves overridable packages — `dshmarket` (`OVERRIDABLE_PACKAGES`) — profile-first, closure-fallback (`createProfileLoaderInternal`), so the node half uses the override while every other in-box package keeps closure-first identity.
4. The desktop shell owns the update surface, not the market: a General-settings row (`MarketVersionRow`) over the preload bridge to a `dsh:market-version` IPC channel backed by `electron/market-version.ts`. It reads bundled/override/registry versions, gates a candidate against the closure's peer versions (a peer the closure lacks or cannot satisfy is rejected — a fresh `@deepseek-ai/*` peer would split the service identity), exempts the exact version from the profile's release-age check (pnpm's 24h default would refuse a same-day release), and installs dependency-only through `desktopPnpm.run` — never `dsh.profile.bundles`. A rollback removes the override, and the bundled copy serves on the next boot.

## Alternatives considered

**Move the market fully into the profile as a normal bundle with a first-boot bootstrap install.** Gives the market direct self-management but requires a mandatory network install at first boot (breaks the offline baseline and the headless no-socket boot proof), leaves a broken/freshly-published market with no version gate, lets users uninstall the market into nothing, and raises the peer-identity split risk. Rejected in favor of the bundled fallback + gated override.

**Route the update through the market's own manage flow.** The market's generic install reconciles the package into `dsh.profile.bundles`, which composes the duplicate `dsh-market` row; rejected — the shell owns the row and therefore the version.

## Consequences

Users update the built-in market from **Settings → 插件市场版本**, seeing bundled/override/latest, with a rollback to the bundled copy — no desktop release required. The bundled copy remains the offline, supply-chain-pinned fallback; a market version whose peers the desktop closure cannot satisfy is refused with a clear message. Costs: an update applies on the next host restart (never hot-mounted), the compat gate must be re-checked as the DSH kernel moves, and `dshmarket` is no longer a hard dependency, so a build-time install failure would be reported as "market unavailable" rather than failing the install.
