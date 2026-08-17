/**
 * The desktop main window.
 *
 * Creation options, the staged `file://` page load, and the shell-level
 * web-contents guards: no window.open (http/https targets go to the desktop
 * browser), no navigation away from the staged page, and no privileged
 * permission grants - the SPA needs none.
 */

import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { resolvePackageRoot } from './boot-desktop.js'
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
  wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  await win.loadFile(page.path)
  return win
}
