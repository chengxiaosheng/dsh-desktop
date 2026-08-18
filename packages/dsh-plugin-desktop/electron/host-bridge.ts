/**
 * Host-side virtual-host transport — the general compatibility surface for
 * plugins that reach the harness over the reported webServer host/port.
 *
 * The desktop runs the full Web UI with no Node HTTP server and no port; its
 * in-process dispatch only ever serves the renderer's patched `fetch`/`WebSocket`
 * over IPC. A third-party plugin (dsh-im, or any plugin that reads
 * `webServer.port` to build a harness base URL) makes those calls on the HOST
 * side — from the Electron main process — where the renderer bridge never sees
 * them. This module closes that gap the same way the renderer bridge works, but
 * in-process: it patches `globalThis.fetch` and `globalThis.WebSocket` so that
 * every request whose URL is the desktop's virtual host identity
 * (`http(s)://127.0.0.1:<webServer.port>`, `ws(s)://…`, or the `dsh.internal`
 * name) dispatches through the existing in-process machinery —
 * `dispatchHttpRequest` for HTTP, `openVirtualHostSocket` for WebSocket —
 * and every other URL passes through to the real implementation untouched.
 *
 * The mechanism keys on the virtual-host identity alone, never on a plugin:
 * any host-side client that talks to `webServer.port` over the standard web
 * APIs works. The patch must be installed before Loader entries apply (a
 * plugin's `fetch`/`WebSocket` reference is captured at construction time), so
 * `bootDesktop` installs it in its `prepare` hook and registers the disposer as
 * a context effect, unwinding on fiber dispose (including the in-process reboot).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { VirtualWebServer } from '../src/webserver.ts'
import { dispatchHttpRequest, VIRTUAL_HOST, type HttpRequestMessage } from './boot-desktop.ts'
import { openVirtualHostSocket, type BridgeSocket, type WsLike } from './virtual-host-socket.ts'

/** Loopback hostnames the virtual host identity accepts. */
function isLoopbackHostname(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/**
 * Whether a URL targets the desktop's virtual host identity: the `dsh.internal`
 * name (desktop-owned, any port) or a loopback host on the reported
 * `webServer.port`. The port comparison uses the webServer's reported value, so
 * a plugin that reads `webServer.port` to build its base URL always lands here.
 * @param ctx - booted desktop context (its `webServer` reports the virtual port).
 * @param url - the request URL.
 */
export function matchesVirtualHost(ctx: Context, url: string): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:' && target.protocol !== 'ws:' && target.protocol !== 'wss:') return false
  const host = target.hostname.toLowerCase()
  if (host === VIRTUAL_HOST || host.endsWith(`.${VIRTUAL_HOST}`)) return true
  const webServer = ctx.get('webServer') as VirtualWebServer | undefined
  if (webServer === undefined || !isLoopbackHostname(host)) return false
  const port = target.port === '' ? (target.protocol === 'https:' || target.protocol === 'wss:' ? 443 : 80) : Number(target.port)
  return port === webServer.port
}

/**
 * Serve one host-side HTTP request against the booted desktop host. The full
 * request (method, path, headers, body) becomes a virtual-host `http-request`
 * and dispatches through `dispatchHttpRequest`, whose `/api` plane forwards the
 * envelope body so a host-side RPC client (dsh-im's HarnessClient) receives the
 * same `server-response` the renderer's carrier does.
 * @param ctx - booted desktop context.
 * @param request - the intercepted fetch Request.
 * @returns the in-process response.
 */
export async function handleHostFetch(ctx: Context, request: Request): Promise<Response> {
  const target = new URL(request.url)
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => { headers[key] = value })
  const message: HttpRequestMessage = {
    type: 'http-request',
    method: request.method,
    path: target.pathname,
    search: target.search,
    headers,
    body: await request.text(),
  }
  const envelope = await dispatchHttpRequest(ctx, message)
  return new Response(Buffer.from(envelope.bodyBase64, 'base64'), {
    status: envelope.status,
    headers: envelope.headers,
  })
}

/**
 * A WebSocket-compatible host-side shim bound to one virtual-host upgrade route.
 * Construction kicks off the in-process upgrade; listeners attached immediately
 * (the plugin's `addEventListener("open"|"message"|"close"|"error")`) fire as
 * the route's real `ws` instance drives the bridge socket. `send`/`close` push
 * masked client frames into the socket exactly like the renderer shim.
 */
export class HostVirtualSocket {
  readonly url: string
  readonly protocols: string
  extensions = ''
  binaryType: 'blob' | 'arraybuffer' = 'blob'
  bufferedAmount = 0
  /** CONNECTING until the upgrade completes. */
  readyState = 0
  onopen: ((event: { type: 'open' }) => void) | null = null
  onmessage: ((event: { type: 'message'; data: string | ArrayBuffer | Blob }) => void) | null = null
  onclose: ((event: { type: 'close'; code: number; reason: string }) => void) | null = null
  onerror: ((event: { type: 'error'; error?: Error }) => void) | null = null

  /** CONNECTING */
  static readonly CONNECTING = 0
  /** OPEN */
  static readonly OPEN = 1
  /** CLOSING */
  static readonly CLOSING = 2
  /** CLOSED */
  static readonly CLOSED = 3

  private readonly ctx: Context
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  private socket: BridgeSocket | undefined
  private ws: WsLike | undefined
  private opened = false
  /** Server frames that arrived before the open event; flushed once open. */
  private readonly pending: Array<{ type: 'message'; data: string | ArrayBuffer | Blob }> = []
  private pendingClose: { code: number; reason: string } | undefined

  constructor(ctx: Context, url: string, protocols?: string | string[]) {
    this.ctx = ctx
    this.url = url
    this.protocols = Array.isArray(protocols) ? protocols.join(', ') : protocols ?? ''
    void this.open()
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  /** Push one server→client message out to the listeners (text frames as strings). */
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== HostVirtualSocket.OPEN) throw new Error('WebSocket is not open')
    const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data as ArrayBuffer)
    this.socket?.pushClientData(buf, typeof data !== 'string')
  }

  /** Initiate the closing handshake with a masked close frame. */
  close(code = 1000, reason = ''): void {
    if (this.readyState >= HostVirtualSocket.CLOSING) return
    this.readyState = HostVirtualSocket.CLOSING
    if (this.socket === undefined) {
      // The close raced the open: remember it and tear the socket down the
      // moment the upgrade completes.
      this.pendingClose = { code, reason }
      return
    }
    const codeBytes = [((code >> 8) & 0xff), code & 0xff]
    this.socket.pushClientClose(Buffer.concat([Buffer.from(codeBytes), Buffer.from(reason, 'utf8')]))
  }

  /** Force the connection down (the bridge teardown equivalent). */
  terminate(): void {
    this.ws?.terminate()
  }

  private async open(): Promise<void> {
    let target: URL
    try {
      target = new URL(this.url)
    } catch {
      this.fail(new Error('invalid websocket url'))
      return
    }
    const opened = await openVirtualHostSocket(this.ctx, target, {
      protocols: this.protocols === '' ? undefined : this.protocols.split(',').map((s) => s.trim()).filter((s) => s !== ''),
      onServerMessage: (opcode: number, payload: Buffer) => {
        const binary = opcode === 0x2
        const event = {
          type: 'message',
          data: binary
            ? (this.binaryType === 'arraybuffer' ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) : new Blob([payload as unknown as BlobPart]))
            : payload.toString('utf8'),
        } as { type: 'message'; data: string | ArrayBuffer | Blob }
        // A real WebSocket never delivers a message before 'open'; the upgrade
        // handler may write synchronously (during the constructor, before the
        // caller attaches listeners), so buffer until the open event fires.
        if (this.opened) this.dispatch(event)
        else this.pending.push(event)
      },
    })
    if (opened === undefined) {
      this.fail(new Error('websocket upgrade did not complete'))
      return
    }
    this.socket = opened.socket
    this.ws = opened.ws
    if (this.pendingClose !== undefined) {
      const { code, reason } = this.pendingClose
      this.pendingClose = undefined
      this.readyState = HostVirtualSocket.CLOSING
      this.close(code, reason)
      return
    }
    this.ws.on('close', (code: number, reason: Buffer) => {
      this.readyState = HostVirtualSocket.CLOSED
      this.dispatch({ type: 'close', code, reason: reason.toString('utf8') })
    })
    this.ws.on('error', (error: Error) => {
      this.dispatch({ type: 'error', error })
    })
    this.readyState = HostVirtualSocket.OPEN
    this.opened = true
    this.dispatch({ type: 'open' })
    for (const event of this.pending.splice(0)) this.dispatch(event)
  }

  /** An upgrade that failed or was refused surfaces as error + close, like a real socket. */
  private fail(error: Error): void {
    this.readyState = HostVirtualSocket.CLOSED
    this.dispatch({ type: 'error', error })
    this.dispatch({ type: 'close', code: 1006, reason: error.message })
  }

  private dispatch(event: { type: string; [key: string]: unknown }): void {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event)
    const handler = this[`on${event.type}` as 'onopen' | 'onmessage' | 'onclose' | 'onerror']
    if (typeof handler === 'function') (handler as (event: unknown) => void)(event)
  }
}

/**
 * Install the host-side virtual-host transport: patch `globalThis.fetch` and
 * `globalThis.WebSocket` so virtual-host URLs dispatch in-process and every
 * other URL passes through unchanged. Must run before Loader entries apply
 * (plugin transport references are captured at construction), so `bootDesktop`
 * calls it from its `prepare` hook.
 * @param host - the booting desktop context.
 * @returns a disposer restoring the originals and tearing down open sockets.
 */
export function installHostBridge(host: Context): () => void {
  const originalFetch = globalThis.fetch
  const originalWebSocket = globalThis.WebSocket
  const sockets = new Set<HostVirtualSocket>()

  const virtualHostFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    } catch {
      return originalFetch(input, init)
    }
    if (!matchesVirtualHost(host, url)) return originalFetch(input, init)
    return handleHostFetch(host, new Request(input, init))
  }

  const virtualHostWebSocket = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const urlString = url instanceof URL ? url.href : String(url)
    if (matchesVirtualHost(host, urlString)) {
      const socket = new HostVirtualSocket(host, urlString, protocols)
      sockets.add(socket)
      return socket
    }
    return new originalWebSocket(url, protocols)
  }

  globalThis.fetch = virtualHostFetch as typeof fetch
  if (typeof originalWebSocket === 'function') {
    const patched = virtualHostWebSocket as unknown as { CONNECTING: number; OPEN: number; CLOSING: number; CLOSED: number }
    patched.CONNECTING = 0
    patched.OPEN = 1
    patched.CLOSING = 2
    patched.CLOSED = 3
    globalThis.WebSocket = patched as unknown as typeof WebSocket
  }

  return () => {
    if (globalThis.fetch === virtualHostFetch) globalThis.fetch = originalFetch
    if (globalThis.WebSocket === (virtualHostWebSocket as unknown)) globalThis.WebSocket = originalWebSocket
    for (const socket of sockets) socket.terminate()
    sockets.clear()
  }
}
