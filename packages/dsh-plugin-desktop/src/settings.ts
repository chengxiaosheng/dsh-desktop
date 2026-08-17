/**
 * Shared desktop-shell contract between the node half (`src/index.ts`) and
 * the browser half (`src/client/`). Plain constants only — the durable schema
 * stays in the node half so the client bundle never pulls in schemastery.
 */

/** Durable settings namespace owned by the desktop shell row. */
export const DESKTOP_SETTINGS_NAMESPACE = 'desktop'

/** Field carrying the close-window behavior; absence resolves to the schema default. */
export const CLOSE_TO_TRAY_FIELD = 'closeToTray'

/** Durable close-window preference section (wire shape). */
export interface DesktopSettings {
  /** Whether closing the main window hides it to the tray instead of quitting. */
  closeToTray: boolean
}
