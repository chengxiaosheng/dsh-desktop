/**
 * Renderer failure surfacing and debug tooling for the main window.
 *
 * Console messages, failed loads, and renderer crashes always log to the
 * main-process log so a blank window is diagnosable headlessly.
 * `DSH_DESKTOP_DEBUG_RENDERER=1` additionally dumps the DOM state at load
 * and 4s later, and writes a screenshot to `DSH_DEBUG_OUT` when set.
 * `DSH_DESKTOP_DEBUG=1` additionally opens detached developer tools.
 */

import type { BrowserWindow } from 'electron'

/**
 * Attach diagnostics to a window; call before the page loads.
 * @param win - the window whose web contents are monitored.
 */
export function installRendererDiagnostics(win: BrowserWindow): void {
  const wc = win.webContents
  wc.on('console-message', (event) => {
    console.error(`dsh-desktop: renderer console[${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
  })
  wc.on('did-fail-load', (_event, code, description, url) => {
    console.error(`dsh-desktop: did-fail-load ${code} ${description} ${url}`)
  })
  wc.on('render-process-gone', (_event, details) => {
    console.error(`dsh-desktop: render-process-gone ${JSON.stringify(details)}`)
  })
  if (process.env.DSH_DESKTOP_DEBUG === '1') {
    wc.once('did-finish-load', () => wc.openDevTools({ mode: 'detach' }))
  }
  if (process.env.DSH_DESKTOP_DEBUG_RENDERER === '1') {
    installStateDump(wc)
  }
}

/** Dump the renderer DOM state at load and 4s later, plus a screenshot when configured. */
function installStateDump(wc: Electron.WebContents): void {
  const dumpState = async (): Promise<void> => {
    try {
      const state = await wc.executeJavaScript(`({
        title: document.title,
        bootPresent: window.__DSH_BOOT__ !== undefined,
        scripts: document.scripts.length,
        bodyLength: (document.body?.innerText ?? '').length,
        rootChildren: document.getElementById('root')?.children.length ?? -1,
        innerText: (document.body?.innerText ?? '').slice(0, 500),
      })`)
      console.error(`dsh-desktop: renderer state ${JSON.stringify(state)}`)
      if (process.env.DSH_DEBUG_OUT !== undefined) {
        const image = await wc.capturePage()
        const { writeFileSync } = await import('node:fs')
        writeFileSync(process.env.DSH_DEBUG_OUT, image.toPNG())
        console.error(`dsh-desktop: renderer screenshot -> ${process.env.DSH_DEBUG_OUT}`)
      }
    } catch (error) {
      console.error('dsh-desktop: renderer state dump failed:', String(error))
    }
  }
  wc.once('did-finish-load', async () => {
    await dumpState()
    setTimeout(() => { void dumpState() }, 4000)
  })
}
