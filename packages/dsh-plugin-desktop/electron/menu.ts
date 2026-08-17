/**
 * The application menu.
 *
 * macOS requires an application menu for the standard shortcuts (quit, copy,
 * paste, window management), so a role-based template installs there.
 * Windows and Linux ship no menu: the shell has no menu-driven features,
 * and `null` removes the platform menu bar entirely.
 */

import { Menu } from 'electron'

/**
 * Install the application menu for the running platform.
 * Call once per application, after `app.whenReady()`.
 */
export function installApplicationMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]))
}
