/**
 * @module dsh-plugin-desktop
 *
 * Desktop shell row. This spike only validates the virtual-webserver
 * interceptor; the Electron shell row (window, tray, terminal, updates,
 * profiles) grows here later, mirroring the deepseek-harness-desktop product.
 */

import type { Context } from '@deepseek-ai/cordis'

/** No hard dependencies. */
export const inject: string[] = []

/**
 * Mount the desktop shell row. Currently a no-op placeholder reserved for the
 * native lifecycle plugin.
 * @param ctx - plugin context.
 */
export function apply(_ctx: Context): void {
  // Reserved for the Electron native shell (window/tray/terminal/updates).
}
