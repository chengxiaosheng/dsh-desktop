/**
 * The renderer↔host IPC bridge.
 *
 * Installs the channel groups the preload exposes, once per application: the
 * synchronous boot manifest (`sendSync`, read by the preload before page
 * scripts run), the unary/respond `dsh:invoke` channel (RPC envelopes
 * dispatched in-process against the composed `/api` surface, plus raw
 * virtual-host `http-request` download dispatch), the two downlink stream
 * pumps (`mux`/`host`) pushing host frames to the renderer, and the shell
 * preference channel (`dsh:close-behavior`) serving the close-window
 * preference to the settings row. The renderer handle is resolved per send,
 * so reloads and window recreation keep working without reinstalling
 * handlers.
 */

import { ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { toFetchHandler, type ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { API_PATH } from '@deepseek-ai/dsh-client-connection'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import { readCloseBehavior } from '../src/index.js'
import { CLOSE_TO_TRAY_FIELD, DESKTOP_SETTINGS_NAMESPACE } from '../src/settings.js'
import { readMarketVersion, rollbackMarketVersion, updateMarketVersion } from './market-version.js'
import { composeDesktopManifest, dispatchHttpRequest, type DesktopHostConnection, type FetchHandler, type HttpRequestMessage } from './boot-desktop.js'

/** One client->host RPC envelope the renderer carrier sends over the bridge. */
interface ClientRequest {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

/** One host->client response envelope traveling back over the bridge. */
interface ClientResponse {
  type: 'client-response'
  rpcId: string
  result: unknown
}

/** The RPC body envelopes the renderer carrier sends over the bridge. */
type ClientRequestBody = ClientRequest | ClientResponse

/** One bridge invoke: a raw virtual-host request, or an RPC envelope. */
type InvokeRequest = HttpRequestMessage | { type?: never; path: string; body?: unknown }

/** A `server-response` envelope carrying an error for a malformed invoke. */
interface ErrorResponse {
  type: 'server-response'
  rpcId: string
  result: { ok: false; error: { code: string; message: string; details: object } }
}

/**
 * Install the IPC bridge against the booted host context.
 * @param ctx - the booted desktop context.
 * @param getWebContents - renderer resolution for downlink pushes, invoked
 *   per send so a reload or window recreation keeps receiving frames.
 * @returns a disposer removing every registered handler, so the bridge can be
 *   re-installed against a fresh context after an in-process host re-boot.
 * @throws when the booted tree provides no `connection` service.
 */
export function installIpc(ctx: Context, getWebContents: () => WebContents | undefined): () => void {
  const connection = ctx.get('connection') as DesktopHostConnection | undefined
  if (connection === undefined) {
    throw new Error('dsh-desktop: connection service missing from the booted tree')
  }
  const disposers = [
    installBootManifestChannel(ctx),
    installInvokeChannel(ctx, connection),
    installStreamPumps(ctx, getWebContents),
    installCloseBehaviorChannel(ctx),
    installMarketVersionChannel(ctx),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Install the `dsh:reboot-host` channel: the shell client asks the main to
 * dispose the host generation, boot a fresh one over the updated profile, and
 * reload the renderer — applying pending plugin changes without restarting the
 * application. App-level, not context-scoped: installed once alongside the
 * tray and menu.
 * @param onReboot - the main's reboot routine.
 * @returns a disposer removing the handler.
 */
export function installRebootChannel(onReboot: () => void | Promise<void>): () => void {
  const handler = (): unknown => onReboot()
  ipcMain.handle('dsh:reboot-host', handler)
  return () => { ipcMain.removeHandler('dsh:reboot-host') }
}

/**
 * The shell preference channel: the settings row reads and writes the
 * close-window behavior through the bridge. The settings WIRE does not serve
 * the `desktop` namespace — the host ApiProxy's configuration-client
 * allowlist covers the shipped web preferences only — so the write goes
 * through the in-process provider, which is not gated by that allowlist.
 */
function installCloseBehaviorChannel(ctx: Context): () => void {
  const handler = async (_event: Electron.IpcMainInvokeEvent, request: unknown): Promise<{ closeToTray: boolean }> => {
    if (typeof request === 'object' && request !== null) {
      const body = request as { type?: unknown; value?: unknown }
      if (body.type === 'write' && typeof body.value === 'boolean') {
        const settings = ctx.get('settings')
        if (settings !== undefined) {
          await settings.update(settingsNamespace(DESKTOP_SETTINGS_NAMESPACE), {
            [CLOSE_TO_TRAY_FIELD]: body.value,
          })
        }
      }
    }
    return readCloseBehavior(ctx)
  }
  ipcMain.handle('dsh:close-behavior', handler)
  return () => { ipcMain.removeHandler('dsh:close-behavior') }
}

/**
 * The market-version channel: the shell settings row reads the market's
 * version states (bundled / override / registry) and triggers a controlled
 * update or rollback through the desktop-owned service. The shell owns this
 * surface rather than the market itself, so it works even when the market is
 * broken or outdated, and a market-managed install can never compose a
 * duplicate row.
 */
function installMarketVersionChannel(ctx: Context): () => void {
  const handler = async (_event: Electron.IpcMainInvokeEvent, request: unknown): Promise<unknown> => {
    const body = (typeof request === 'object' && request !== null ? request : {}) as { type?: unknown; version?: unknown }
    switch (body.type) {
      case 'read':
        return readMarketVersion(ctx)
      case 'update':
        return updateMarketVersion(ctx, typeof body.version === 'string' ? body.version : '')
      case 'rollback':
        return rollbackMarketVersion(ctx)
      default:
        return { ok: false, message: 'dsh-desktop: unknown market-version request' }
    }
  }
  ipcMain.handle('dsh:market-version', handler)
  return () => { ipcMain.removeHandler('dsh:market-version') }
}

/** sendSync channel: the preload reads the rewritten boot graph synchronously before page scripts run. */
function installBootManifestChannel(ctx: Context): () => void {
  const { graph } = composeDesktopManifest(ctx)
  const listener = (event: Electron.IpcMainEvent): void => {
    event.returnValue = graph
  }
  ipcMain.on('dsh:boot-manifest', listener)
  return () => { ipcMain.removeListener('dsh:boot-manifest', listener) }
}

/**
 * The unary/respond channel. Raw virtual-host HTTP requests (the
 * session-log download surface) dispatch through the in-process host; RPC
 * envelopes route either through the composed `/api` fetch surface or, for
 * generic connection channels, through the gateway's claimed set.
 */
function installInvokeChannel(ctx: Context, connection: DesktopHostConnection): () => void {
  const apiProxy = ctx.get('apiProxy')
  const apiFetchHandler = connection.createSharedFetchHandler(API_PATH, {
    fetch: (request) => {
      if (apiProxy === undefined) return Promise.resolve(new Response('not found', { status: 404 }))
      return toFetchHandler(apiProxy).fetch(request)
    },
  })
  const handler = async (_event: Electron.IpcMainInvokeEvent, request: InvokeRequest): Promise<unknown> => {
    if (request?.type === 'http-request') {
      return dispatchHttpRequest(ctx, request)
    }
    const body = request?.body
    if (typeof body !== 'object' || body === null) return errorResult('missing body')
    const rpcBody = body as ClientRequestBody
    if (rpcBody.type === 'client-request') {
      const path = typeof request.path === 'string' ? request.path : ''
      if (path.startsWith(`${API_PATH}/`)) {
        return dispatchApiRpc(apiFetchHandler, path, rpcBody)
      }
      // Generic connection channel (e.g. a plugin's `/mineru-api/...`): the
      // channel's webServer prefix route serves it — the official flow POSTs
      // the envelope to the channel path, and the host's rpcFetchHandler
      // answers with the server-response envelope. Dispatch through the full
      // registry like any plugin route.
      const envelope = await dispatchHttpRequest(ctx, {
        type: 'http-request',
        method: 'POST',
        path,
        search: '',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rpcBody),
      })
      if (envelope.status < 200 || envelope.status >= 300) {
        return {
          type: 'server-response',
          rpcId: rpcBody.rpcId,
          result: { ok: false, error: { code: 'internal', message: `dsh-desktop: channel answered HTTP ${envelope.status}`, details: {} } },
        }
      }
      try {
        return JSON.parse(Buffer.from(envelope.bodyBase64, 'base64').toString())
      } catch {
        return {
          type: 'server-response',
          rpcId: rpcBody.rpcId,
          result: { ok: false, error: { code: 'internal', message: 'dsh-desktop: channel answered a non-JSON response', details: {} } },
        }
      }
    }
    if (rpcBody.type === 'client-response' && apiProxy !== undefined) {
      return apiProxy.respond(rpcBody as Parameters<ApiProxy['respond']>[0])
    }
    return errorResult('unsupported message type')
  }
  ipcMain.handle('dsh:invoke', handler)
  return () => { ipcMain.removeHandler('dsh:invoke') }
}

/** One `/api` RPC envelope through the composed fetch surface, mapped to a response envelope. */
async function dispatchApiRpc(apiFetchHandler: FetchHandler, path: string, rpcBody: ClientRequest): Promise<unknown> {
  const fetchRequest = new Request(new URL(path, 'http://dsh-desktop.invalid'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rpcBody),
  })
  const response = await apiFetchHandler.fetch(fetchRequest)
  if (!response.ok) {
    return {
      type: 'server-response',
      rpcId: rpcBody.rpcId,
      result: { ok: false, error: { code: 'internal', message: `dsh-desktop: transport error HTTP ${response.status}`, details: {} } },
    }
  }
  return response.json()
}

/**
 * The downlink stream channels: one pump per channel (`mux`, `host`)
 * forwarding `apiProxy.events` frames to the renderer until unsubscribed.
 */
function installStreamPumps(ctx: Context, getWebContents: () => WebContents | undefined): () => void {
  const apiProxy = ctx.get('apiProxy') as ApiProxy | undefined
  const DOWNLINK_CHANNELS = new Set(['mux', 'host'] as const)
  const pumps = new Map<string, AbortController>()
  const onSubscribe = (_event: Electron.IpcMainEvent, channel: unknown): void => {
    if (typeof channel !== 'string' || !DOWNLINK_CHANNELS.has(channel as 'mux' | 'host')) return
    if (pumps.has(channel) || apiProxy === undefined) return
    const abort = new AbortController()
    pumps.set(channel, abort)
    startPump(apiProxy, channel as 'mux' | 'host', abort, pumps, getWebContents)
  }
  const onUnsubscribe = (_event: Electron.IpcMainEvent, channel: unknown): void => {
    if (typeof channel !== 'string' || !DOWNLINK_CHANNELS.has(channel as 'mux' | 'host')) return
    pumps.get(channel)?.abort()
    pumps.delete(channel)
  }
  ipcMain.on('dsh:subscribe', onSubscribe)
  ipcMain.on('dsh:unsubscribe', onUnsubscribe)
  return () => {
    for (const abort of pumps.values()) abort.abort()
    pumps.clear()
    ipcMain.removeListener('dsh:subscribe', onSubscribe)
    ipcMain.removeListener('dsh:unsubscribe', onUnsubscribe)
  }
}

/** Pump one downlink channel until its abort fires, then emit `stream/end`. */
function startPump(
  apiProxy: ApiProxy,
  channel: 'mux' | 'host',
  abort: AbortController,
  pumps: Map<string, AbortController>,
  getWebContents: () => WebContents | undefined,
): void {
  const frames = channel === 'mux'
    ? apiProxy.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal)
    : apiProxy.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal)
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
}

function errorResult(message: string): ErrorResponse {
  return {
    type: 'server-response',
    rpcId: 'invalid-request',
    result: { ok: false, error: { code: 'bad-request', message, details: {} } },
  }
}
