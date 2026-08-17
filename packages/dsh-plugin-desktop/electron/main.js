/**
 * Electron main for DSH Desktop.
 *
 * Boots the desktop profile in-process (virtual webserver + desktop connection
 * row), rewrites the SPA index and boot graph to `file://`, opens one window,
 * and fronts the renderer↔host transport over Electron IPC: unary/respond
 * dispatch in-process through the composed `/api` surface, and the two downlink
 * streams pump `apiProxy.events.mux`/`host` to the renderer. No Node HTTP
 * server and no port exist on the desktop path.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { API_PATH } from '@deepseek-ai/dsh-client-connection'
import { bootDesktop, composeDesktopManifest, dispatchHttpRequest } from './boot-desktop.js'

const PRELOAD_PATH = new URL('./preload.cjs', import.meta.url).pathname

/** Rewrite server-relative SPA assets to absolute file:// URLs under the dist dir. */
function rewriteAssetUrls(html, distDir) {
  return html.replace(/(src|href)="\/(assets\/[^"]+|[^"]*\.(?:webmanifest|svg))"/g, (_m, attr, path) => {
    return `${attr}="${pathToFileURL(join(distDir, path)).href}"`
  })
}

async function main() {
  let ctx
  let win
  try {
    ctx = await bootDesktop()
    const { graph, distIndex } = composeDesktopManifest(ctx)

    const distDir = dirname(distIndex)
    const html = rewriteAssetUrls(readFileSync(distIndex, 'utf8'), distDir)
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-desktop-page-'))
    const pagePath = join(tmp, 'index.html')
    writeFileSync(pagePath, html)

    win = new BrowserWindow({
      width: 1280,
      height: 800,
      webPreferences: {
        preload: PRELOAD_PATH,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    installIpc(ctx, () => win?.webContents)
    win.on('closed', () => {
      rmSync(tmp, { recursive: true, force: true })
      app.quit()
    })
    await win.loadFile(pagePath)
  } catch (error) {
    console.error('dsh-desktop: failed to start:', error)
    if (ctx !== undefined) await ctx.fiber.dispose()
    if (win !== undefined) win.destroy()
    app.exit(1)
  }
}

/**
 * Install the Electron IPC bridge against the booted host context.
 * @param ctx - the booted desktop context.
 * @param getWebContents - renderer resolution for downlink pushes (resolved per
 *   send so a reload keeps working).
 */
function installIpc(ctx, getWebContents) {
  const connection = ctx.get('connection')
  const apiProxy = ctx.get('apiProxy')
  if (connection === undefined) {
    throw new Error('dsh-desktop: connection service missing from the booted tree')
  }
  const apiFetchHandler = connection.createSharedFetchHandler(API_PATH, {
    fetch: (request) => {
      if (apiProxy === undefined) return Promise.resolve(new Response('not found', { status: 404 }))
      return toFetchHandler(apiProxy).fetch(request)
    },
  })

  // sendSync: the preload reads the rewritten boot graph synchronously.
  const { graph } = composeDesktopManifest(ctx)
  ipcMain.on('dsh:boot-manifest', (event) => {
    event.returnValue = graph
  })

  ipcMain.handle('dsh:invoke', async (_event, request) => {
    // Raw virtual-host HTTP requests (the session-log download surface) dispatch
    // through the in-process host; the envelope types below stay unchanged.
    if (request?.type === 'http-request') {
      return dispatchHttpRequest(ctx, request)
    }
    const body = request?.body
    if (typeof body !== 'object' || body === null) return errorResult('missing body')
    if (body.type === 'client-request') {
      const path = typeof request.path === 'string' ? request.path : ''
      if (path.startsWith(`${API_PATH}/`)) {
        const fetchRequest = new Request(new URL(path, 'http://dsh-desktop.invalid'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const response = await apiFetchHandler.fetch(fetchRequest)
        if (!response.ok) {
          return {
            type: 'server-response',
            rpcId: body.rpcId,
            result: { ok: false, error: { code: 'internal', message: `dsh-desktop: transport error HTTP ${response.status}`, details: {} } },
          }
        }
        return response.json()
      }
      // Generic connection channels: the gateway's claimed set, else not-found.
      const result = await connection.dispatch(body.method, body.payload, new AbortController().signal)
      return { type: 'server-response', rpcId: body.rpcId, result }
    }
    if (body.type === 'client-response' && apiProxy !== undefined) {
      return apiProxy.respond(body)
    }
    return errorResult('unsupported message type')
  })

  const DOWNLINK_CHANNELS = new Set(['mux', 'host'])
  const pumps = new Map()
  ipcMain.on('dsh:subscribe', (_event, channel) => {
    if (typeof channel !== 'string' || !DOWNLINK_CHANNELS.has(channel)) return
    if (pumps.has(channel) || apiProxy === undefined) return
    const abort = new AbortController()
    pumps.set(channel, abort)
    const frames = channel === 'mux'
      ? apiProxy.events.mux({ rpcId: randomUUID(), payload: {} }, abort.signal)
      : apiProxy.events.host({ rpcId: randomUUID(), payload: {} }, abort.signal)
    void (async () => {
      try {
        for await (const frame of frames) {
          getWebContents()?.send('dsh:frame', channel, {
            type: 'server-request',
            rpcId: frame.rpcId,
            method: frame.payload.type,
            payload: frame.payload,
          })
        }
      } finally {
        getWebContents()?.send('dsh:frame', channel, { type: 'stream/end' })
        pumps.delete(channel)
      }
    })()
  })
  ipcMain.on('dsh:unsubscribe', (_event, channel) => {
    if (typeof channel !== 'string' || !DOWNLINK_CHANNELS.has(channel)) return
    pumps.get(channel)?.abort()
    pumps.delete(channel)
  })
}

function errorResult(message) {
  return {
    type: 'server-response',
    rpcId: 'invalid-request',
    result: { ok: false, error: { code: 'bad-request', message, details: {} } },
  }
}

app.whenReady().then(main).catch((error) => {
  console.error('dsh-desktop: fatal:', error)
  app.exit(1)
})
