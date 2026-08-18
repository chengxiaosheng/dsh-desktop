/**
 * Electron main composition root for DSH Desktop.
 *
 * Owns application lifecycle only: the single-instance lock, the in-process
 * host boot (delegated to boot-desktop - no Node HTTP server, no port), the
 * once-per-application IPC install, the main window's lifetime (including
 * the close-to-tray interception), the tray, and the graceful fiber dispose
 * on quit. Window creation (`window`), the renderer bridge (`ipc`), the menu
 * (`menu`), the tray (`tray`), renderer diagnostics (`diagnostics`), and
 * boot-failure formatting (`errors`) each live in their own module; future
 * shell capabilities (updates, terminal) mount alongside them here.
 */

import { app, dialog, type BrowserWindow, type Tray } from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import { bootDesktop } from './boot-desktop.js'
import { installRendererDiagnostics } from './diagnostics.js'
import { formatBootError } from './errors.js'
import { installIpc, installRebootChannel } from './ipc.js'
import { installApplicationMenu } from './menu.js'
import { installTray, installTrayLocaleChannel } from './tray.js'
import { createMainWindow } from './window.js'
import { readCloseBehavior } from '../src/index.js'

/** Application identity; matches `appId` in electron-builder.yml. */
const APP_ID = 'ai.deepseek.dsh.desktop'

let ctx: Context | undefined
let win: BrowserWindow | undefined
let tray: Tray | undefined
let opening: Promise<void> | undefined
let isDisposing = false
/** Set once a real quit begins, so the close-to-tray interception lets the window go. */
let isQuitting = false
/** Disposer for the current host generation's IPC handlers; re-installed on reboot. */
let disposeIpc: (() => void) | undefined

if (!app.requestSingleInstanceLock()) {
  // A running instance owns this profile home; quit without touching it.
  app.quit()
} else {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
  app.on('before-quit', () => { isQuitting = true })
  app.on('second-instance', focusOrReopen)
  app.on('activate', focusOrReopen)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('will-quit', (event) => {
    // Dispose the host fiber before exit so profile writes unwind cleanly;
    // app.exit below terminates without re-emitting this event.
    if (ctx === undefined || isDisposing) return
    isDisposing = true
    event.preventDefault()
    tray?.destroy()
    tray = undefined
    const disposing = ctx
    ctx = undefined
    void disposing.fiber.dispose()
      .catch((error) => console.error('dsh-desktop: host dispose failed:', error))
      .finally(() => app.exit(0))
  })
  app.whenReady().then(bootShell).catch((error) => { void fatal(error) })
}

/** Boot the host once, install the per-application surfaces, then open the window. */
async function bootShell(): Promise<void> {
  ctx = await bootDesktop()
  disposeIpc = installIpc(ctx, () => win?.webContents)
  installRebootChannel(() => rebootHost())
  // The tray-label channel must precede the window: the renderer publishes
  // its locale copy during boot, and the first send must not be lost.
  installTrayLocaleChannel()
  installApplicationMenu()
  await ensureMainWindow()
  tray = installTray(() => win, () => rebootHost())
}

/**
 * Reboot the host in-process: dispose the current Cordis generation, boot a
 * fresh one over the updated profile (new plugin bundles compose on the next
 * boot), re-install the IPC bridge, and reload the renderer. The Electron
 * process, window, and tray stay up — pending plugin changes apply without
 * restarting the application. The shell owns this restart (the plugin market's
 * own restart route is disabled in Desktop mode).
 */
async function rebootHost(): Promise<void> {
  if (isQuitting || isDisposing) return
  const previous = ctx
  if (previous === undefined) return
  ctx = undefined
  try {
    await previous.fiber.dispose()
  } catch (error) {
    console.error('dsh-desktop: host dispose failed during reboot:', error)
  }
  disposeIpc?.()
  disposeIpc = undefined
  try {
    ctx = await bootDesktop()
  } catch (error) {
    void fatal(error)
    return
  }
  disposeIpc = installIpc(ctx, () => win?.webContents)
  win?.webContents.reload()
}

/** Open the main window unless one exists or an open is already in flight. */
function ensureMainWindow(): Promise<void> {
  if (win !== undefined || opening !== undefined) return opening ?? Promise.resolve()
  opening = openMainWindow().finally(() => { opening = undefined })
  return opening
}

async function openMainWindow(): Promise<void> {
  const host = ctx
  if (host === undefined) return
  const window = await createMainWindow(host)
  window.on('closed', () => { if (win === window) win = undefined })
  window.on('close', (event) => {
    // Close-to-tray: hide instead of destroying unless a real quit is
    // underway (tray quit, Cmd+Q, or quit while the preference is off).
    if (!isQuitting && readCloseBehavior(host).closeToTray) {
      event.preventDefault()
      window.hide()
    }
  })
  installRendererDiagnostics(window)
  win = window
}

/** Focus the running instance's window; recreate or reveal it when none is visible. */
function focusOrReopen(): void {
  if (win === undefined) {
    void ensureMainWindow()
    return
  }
  if (!win.isVisible()) win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
}

/**
 * Report a boot failure and exit non-zero: one console line per underlying
 * error always, plus a native dialog when packaged (a headless failure on a
 * shipped build would otherwise look like a silently dead app).
 */
async function fatal(error: unknown): Promise<void> {
  const lines = formatBootError(error)
  for (const line of lines) console.error('dsh-desktop: failed to start:', line)
  if (app.isPackaged) dialog.showErrorBox('DSH Desktop', lines.join('\n'))
  if (ctx !== undefined) {
    const disposing = ctx
    ctx = undefined
    await disposing.fiber.dispose().catch((err) => console.error('dsh-desktop: host dispose failed:', err))
  }
  app.exit(1)
}
