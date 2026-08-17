/**
 * The system tray: one always-visible seat to restore the hidden main window
 * and to quit the application. The tray exists on every platform regardless
 * of the close-window preference — a hidden window must always have a
 * restore path, so the tray cannot be conditional on the setting that hides
 * it.
 *
 * Menu labels come from the renderer: the shell client half publishes the
 * localized show/quit copy (the `settings.desktop` locale dictionaries)
 * whenever the active locale changes, and the main process applies it to the
 * tray. Until the first publication arrives, English labels stand.
 */

import { Menu, Tray, app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { resolvePackageRoot } from './boot-desktop.js'

/** Tooltip text; the application identity is not localized. */
const TOOLTIP = 'DSH Desktop'

/** The tray menu labels the renderer publishes (fallback while absent). */
export interface TrayLabels {
  show: string
  quit: string
}

const FALLBACK_TRAY_LABELS: TrayLabels = { show: 'Open DSH Desktop', quit: 'Quit' }

/** The latest labels the renderer published; undefined before the first send. */
let trayLabelsState: TrayLabels | undefined

/**
 * Install the `dsh:locale` channel: accept the tray labels the renderer
 * publishes for the active locale. Called before the window is created so the
 * renderer's first publication is never lost.
 */
export function installTrayLocaleChannel(): void {
  ipcMain.on('dsh:locale', (_event, labels: unknown) => {
    const candidate = labels as { show?: unknown; quit?: unknown } | undefined
    if (typeof candidate?.show === 'string' && typeof candidate?.quit === 'string') {
      trayLabelsState = { show: candidate.show, quit: candidate.quit }
    }
  })
}

/** The labels the tray should currently display. */
export function currentTrayLabels(): TrayLabels {
  return trayLabelsState ?? FALLBACK_TRAY_LABELS
}

/**
 * Create and show the tray for the running application.
 *
 * The tray owns no window state of its own: the current main window is
 * resolved per interaction, so recreation and reloads keep working. The menu
 * is rebuilt at every open so a locale change applies without a restart.
 * @param getWindow - resolution of the current main window, per interaction.
 * @returns the tray instance; destroy it on quit.
 */
export function installTray(getWindow: () => BrowserWindow | undefined): Tray {
  const tray = new Tray(join(resolvePackageRoot(), 'build', 'icon.png'))
  tray.setToolTip(TOOLTIP)
  const show = (): void => {
    const win = getWindow()
    if (win === undefined) return
    if (!win.isVisible()) win.show()
    if (win.isMinimized()) win.restore()
    win.focus()
  }
  const refreshMenu = (): void => {
    const labels = currentTrayLabels()
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: labels.show, click: show },
      { type: 'separator' },
      { label: labels.quit, click: () => app.quit() },
    ]))
  }
  tray.on('click', () => { refreshMenu(); show() })
  tray.on('right-click', refreshMenu)
  refreshMenu()
  return tray
}
