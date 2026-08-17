/**
 * @module dsh-plugin-desktop
 *
 * Desktop shell row. This spike only validates the virtual-webserver
 * interceptor; the Electron shell row (window, tray, terminal, updates,
 * profiles) grows here later, mirroring the deepseek-harness-desktop product.
 */

/** No hard dependencies. */
export const inject = []

/**
 * Mount the desktop shell row. Currently a no-op placeholder reserved for the
 * native lifecycle plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  // Reserved for the Electron native shell (window/tray/terminal/updates).
}
