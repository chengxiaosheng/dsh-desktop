/**
 * Desktop shell row, browser half: registers the close-behavior dictionaries,
 * the General-section preference row, and the tray-label feed. The row exists
 * only in the desktop composition — this package mounts nowhere else — so the
 * option is desktop-mode-only by construction.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { CloseBehaviorPolicy, type CloseBehaviorBridge } from './close-behavior-policy.ts'
import { CloseToTrayRow } from './CloseToTrayRow.tsx'
import { MarketVersionRow, type MarketVersionInfo, type MarketVersionResult } from './MarketVersionRow.tsx'
import { RestartHostRow } from './RestartHostRow.tsx'
import { en, zh } from './locales.ts'

// Type-only references pull the cordis Context augmentations for the
// `locale` service and the settings slot declarations into this compilation
// (the ui-settings root entry is a host stub).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** The desktop bridge surface the shell half consumes (exposed by the preload). */
export interface DesktopBridge extends CloseBehaviorBridge {
  /** Publish the tray menu labels for the active locale to the main process. */
  sendLocale(labels: { show: string; restart: string; quit: string }): void
  /** Ask the main process to reboot the host in-process (apply pending plugin changes). */
  rebootHost(): Promise<void>
  /** Read the market's bundled/override/registry versions. */
  getMarketVersion(): Promise<MarketVersionInfo>
  /** Update the market to an exact version (dependency-only; restart applies). */
  updateMarket(version: string): Promise<MarketVersionResult>
  /** Remove the market override, falling back to the bundled copy. */
  rollbackMarket(): Promise<MarketVersionResult>
}

/** Required services: slot registration and the locale registry. */
export const inject = ['slots', 'locale']

/** Locale dictionary namespace owning this feature's copy. */
export const SETTINGS_NS = 'settings.desktop'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop shell settings-row and tray copy. */
    'settings.desktop': import('./locales.ts').DesktopSettingsKey
  }
}

/**
 * Register the `settings.desktop` dictionaries, the close-behavior row into
 * the settings General section's item slot, and the tray-label feed, each
 * once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const bridge = (globalThis as { dshDesktop?: DesktopBridge }).dshDesktop
  if (bridge === undefined) {
    throw new Error('dsh-plugin-desktop: window.dshDesktop is missing from a desktop composition')
  }
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'dsh-plugin-desktop: dictionaries')
  const policy = new CloseBehaviorPolicy(bridge)
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'desktop-close-behavior',
    order: 30,
    locale: SETTINGS_NS,
    inject: () => ({
      hooks: { closeToTray: policy.state },
      setCloseToTray: (value: boolean) => policy.setCloseToTray(value),
    }),
  }, CloseToTrayRow))

  // Plugin-market version row: the desktop-owned update/rollback control for
  // the built-in market (the shell owns this, not the market itself).
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'desktop-market-version',
    order: 35,
    locale: SETTINGS_NS,
    inject: () => ({
      getMarketVersion: () => bridge.getMarketVersion(),
      updateMarket: (version: string) => bridge.updateMarket(version),
      rollbackMarket: () => bridge.rollbackMarket(),
    }),
  }, MarketVersionRow))

  // Restart-host row: apply pending plugin changes (the market shows a
  // "needs restart" banner when a change cannot hot-load) by re-booting the
  // host in-process, never restarting the application.
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'desktop-restart-host',
    order: 40,
    locale: SETTINGS_NS,
    inject: () => ({
      restartHost: () => bridge.rebootHost(),
    }),
  }, RestartHostRow))

  // The tray menu lives in the main process; publish its labels whenever the
  // active locale changes (and once at boot), so the tray always matches the
  // language the renderer actually displays.
  const t = ctx.locale.bind(SETTINGS_NS)
  const publishTrayLabels = (): void => {
    bridge.sendLocale({
      show: t('settings.desktop.tray.show'),
      restart: t('settings.desktop.tray.restart'),
      quit: t('settings.desktop.tray.quit'),
    })
  }
  publishTrayLabels()
  ctx.on('locale/change', publishTrayLabels)
}
