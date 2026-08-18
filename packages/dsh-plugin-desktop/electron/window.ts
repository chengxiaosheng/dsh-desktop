/**
 * The desktop main window.
 *
 * Creation options, the staged `file://` page load, and the shell-level
 * web-contents guards: no window.open (http/https targets go to the desktop
 * browser), no navigation away from the staged page, and a permission policy
 * that grants only the clipboard-write the SPA's copy buttons need.
 */

import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { isGrantedPermission } from './permissions.js'
import { resolvePackageRoot } from './package-root.js'
import { stageDesktopPage } from './page.js'

const PRELOAD_PATH = fileURLToPath(new URL('./preload.cjs', import.meta.url))

/** Window geometry in CSS pixels; the minimum keeps the SPA layout usable. */
const WINDOW_GEOMETRY = { width: 1280, height: 800, minWidth: 720, minHeight: 480 } as const

/** Deny every window.open; http(s) targets are handed to the desktop browser. */
function denyWindowOpen(details: Electron.HandlerDetails): { action: 'deny' } {
  if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
    void shell.openExternal(details.url)
  }
  return { action: 'deny' }
}

/**
 * Create and show the main window over the booted host: stages the `file://`
 * page, installs the guards, and shows on `ready-to-show` so no unpainted
 * window appears. The window disposes its staged page when it closes.
 * @param ctx - the booted desktop context.
 * @returns the shown window, once its page has loaded.
 * @throws when the manifest cannot be composed or the page cannot load.
 */
export async function createMainWindow(ctx: Context): Promise<BrowserWindow> {
  const page = stageDesktopPage(ctx)
  const win = new BrowserWindow({
    ...WINDOW_GEOMETRY,
    title: 'DSH Desktop',
    show: false,
    icon: process.platform === 'linux' ? join(resolvePackageRoot(), 'build', 'icon.png') : undefined,
    webPreferences: {
      preload: PRELOAD_PATH,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => page.dispose())
  const wc = win.webContents
  wc.setWindowOpenHandler(denyWindowOpen)
  wc.on('will-navigate', (event, url) => {
    if (url !== page.url) event.preventDefault()
  })
  wc.session.setPermissionRequestHandler((_wc, permission, callback) => {
    // The chat copy buttons write the system clipboard through
    // navigator.clipboard, whose sanitized-write request must be granted;
    // every other permission request is denied.
    callback(isGrantedPermission(permission))
  })
  await win.loadFile(page.path)
  return win
}
