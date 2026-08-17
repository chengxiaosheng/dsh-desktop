/**
 * @module dsh-plugin-desktop
 *
 * Desktop shell row. Owns the durable `desktop` settings namespace (the
 * close-window behavior preference) and mounts nothing else: the Electron
 * main lives in `electron/`, the browser half of the shell (the General
 * settings row) lives in `src/client/`, and the socketless webserver lives
 * in `src/webserver.ts`.
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { CLOSE_TO_TRAY_FIELD, DESKTOP_SETTINGS_NAMESPACE, type DesktopSettings } from './settings.ts'

/** The branded durable namespace the settings provider registers. */
const DESKTOP_NS: SettingsNamespace = settingsNamespace(DESKTOP_SETTINGS_NAMESPACE)

/** Durable desktop schema; also the wire envelope the browser scope validates against. */
export const DesktopSettingsSchema = z.object({
  [CLOSE_TO_TRAY_FIELD]: z.boolean().default(false),
})

/** Resolved section standing when the namespace is unregistered or unreadable. */
const FALLBACK_DESKTOP_SETTINGS: DesktopSettings = { closeToTray: false }

/** No hard dependencies; the settings provider is injected dynamically. */
export const inject: string[] = []

/**
 * Mount the desktop shell row: register the durable `desktop` settings
 * namespace when a settings provider exists.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(DESKTOP_NS, DesktopSettingsSchema, { applies: 'live' })
  })
}

/**
 * Read the resolved close-window behavior from the booted host context.
 *
 * Called by the Electron main at window-close time; the value is read on
 * every close so an edit made while the window is open applies immediately.
 * @param ctx - the booted desktop context.
 * @returns the resolved section; `{ closeToTray: false }` when the settings
 *   service or the namespace is unavailable, so a broken read never prevents
 *   the window from closing.
 */
export function readCloseBehavior(ctx: Context): DesktopSettings {
  try {
    const settings = ctx.get('settings')
    if (settings === undefined) return FALLBACK_DESKTOP_SETTINGS
    const value = settings.get(DESKTOP_NS) as Partial<DesktopSettings> | undefined
    return { closeToTray: value?.closeToTray === true }
  } catch {
    return FALLBACK_DESKTOP_SETTINGS
  }
}
