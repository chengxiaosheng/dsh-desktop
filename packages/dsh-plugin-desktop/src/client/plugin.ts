/**
 * Desktop shell row, browser half: registers the close-behavior dictionaries,
 * the General-section preference row, and the tray-label feed. The row exists
 * only in the desktop composition — this package mounts nowhere else — so the
 * option is desktop-mode-only by construction.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { CloseBehaviorPolicy, type CloseBehaviorBridge } from './close-behavior-policy.ts'
import { CloseToTrayRow } from './CloseToTrayRow.tsx'
import { en, zh } from './locales.ts'

// Type-only references pull the cordis Context augmentations for the
// `locale` service and the settings slot declarations into this compilation
// (the ui-settings root entry is a host stub).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** The desktop bridge surface the shell half consumes (exposed by the preload). */
export interface DesktopBridge extends CloseBehaviorBridge {
  /** Publish the tray menu labels for the active locale to the main process. */
  sendLocale(labels: { show: string; quit: string }): void
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

  // The tray menu lives in the main process; publish its labels whenever the
  // active locale changes (and once at boot), so the tray always matches the
  // language the renderer actually displays.
  const t = ctx.locale.bind(SETTINGS_NS)
  const publishTrayLabels = (): void => {
    bridge.sendLocale({
      show: t('settings.desktop.tray.show'),
      quit: t('settings.desktop.tray.quit'),
    })
  }
  publishTrayLabels()
  ctx.on('locale/change', publishTrayLabels)
}
