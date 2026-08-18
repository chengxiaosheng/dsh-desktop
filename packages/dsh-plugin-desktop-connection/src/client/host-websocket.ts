/**
 * Desktop virtual-host WebSocket bridge (renderer half).
 *
 * The official browser WebSocket is only usable against a real server, and a
 * plugin that builds host WebSockets from `location.origin` (the pattern the
 * harness's own downlink uses) produces `file:///…` URLs on the desktop's
 * `file://` page — the `file:` → `ws:` protocol swap the plugin performs is a
 * silent no-op in the URL parser, so `new WebSocket('file:///sidebar/ws/…')`
 * throws the scheme error. Even a correctly-schemed URL would find no server:
 * the zero-socket desktop has none.
 *
 * This module patches `window.WebSocket` so constructions targeting the
 * desktop host surface (any `file:`-derived URL, or a `ws(s)://dsh.internal`
 * virtual-host URL) ride the IPC bridge instead: the shim implements the
 * browser WebSocket interface (readyState, on* handlers, `send`, `close`,
 * addEventListener) over the preload bridge, and the Electron main runs the
 * registered upgrade route in-process. Only desktop-host URLs are diverted;
 * every other construction keeps the native WebSocket.
 */

import type { DshDesktopBridge, DesktopWsEvent, DesktopWsOpenResult } from './ipc-api-client.ts'
import { decodeBase64 } from './host-http.ts'

/** The virtual host upgrade targets resolve to (mirrors `host-http`'s `VIRTUAL_HOST`). */
export const VIRTUAL_WS_HOST = 'dsh.internal'

/** Browser WebSocket ready states (the same numeric values as the native constructor). */
export const WS_CONNECTING = 0
export const WS_OPEN = 1
export const WS_CLOSING = 2
export const WS_CLOSED = 3

/**
 * Resolve a `new WebSocket` input against the page and decide whether it
 * targets the desktop host surface.
 * @param input - the URL passed to `new WebSocket`.
 * @param base - resolution base; defaults to the page URL.
 * @returns the normalized virtual-host URL for desktop-host targets, or
 *   `undefined` for anything the native WebSocket should see.
 */
export function resolveWebSocketUrl(input: string | URL, base?: string): URL | undefined {
  let url: URL
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input, base ?? globalThis.location?.href)
  } catch {
    return undefined
  }
  if (url.protocol === 'file:') {
    // A plugin's host WebSocket built from `location.origin` on the desktop's
    // `file://` page lands here. The desktop's only server surface is the
    // virtual host, so every `file:` WebSocket target is host work.
    const virtual = new URL(`ws://${VIRTUAL_WS_HOST}`)
    virtual.pathname = url.pathname
    virtual.search = url.search
    return virtual
  }
  if ((url.protocol === 'ws:' || url.protocol === 'wss:') && url.hostname === VIRTUAL_WS_HOST) {
    return url
  }
  return undefined
}

/**
 * The renderer WebSocket shim: the browser `WebSocket` interface over the
 * preload bridge. Instances are minted by `patchWebSocket` for desktop-host
 * URLs and driven by `DesktopWebSocketHost`, which routes the main's events by
 * socket id.
 */
export class DesktopWebSocket {
  static readonly CONNECTING = WS_CONNECTING
  static readonly OPEN = WS_OPEN
  static readonly CLOSING = WS_CLOSING
  static readonly CLOSED = WS_CLOSED

  /** The normalized virtual-host URL the socket targets. */
  readonly url: string
  /** Blob or ArrayBuffer delivery for binary messages, as on the native socket. */
  binaryType: 'blob' | 'arraybuffer' = 'blob'
  readonly bufferedAmount = 0
  readonly extensions = ''
  readonly protocol = ''
  readyState = DesktopWebSocket.CONNECTING
  onopen: ((event: { type: 'open' }) => void) | null = null
  onmessage: ((event: { type: 'message'; data: unknown }) => void) | null = null
  onclose: ((event: { type: 'close'; code: number; reason: string; wasClean: boolean }) => void) | null = null
  onerror: ((event: { type: 'error' }) => void) | null = null

  /** Renderer-minted socket id correlating every bridge message for this socket. */
  readonly socketId: string
  private readonly host: DesktopWebSocketHost
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  /** Messages pushed before the open reply landed; flushed on open. */
  private readonly buffered: DesktopWsEvent[] = []

  constructor(host: DesktopWebSocketHost, url: string, protocols?: string[]) {
    this.host = host
    this.url = url
    this.socketId = randomUuid()
    void host.open(this, url, protocols).then((result) => {
      if (this.readyState === DesktopWebSocket.CLOSED) return
      if (result.type === 'ws-failed') {
        this.readyState = DesktopWebSocket.CLOSED
        this.host.forget(this)
        this.fire('error', { type: 'error' })
        this.fire('close', { type: 'close', code: 1006, reason: result.message, wasClean: false })
        return
      }
      this.readyState = DesktopWebSocket.OPEN
      this.fire('open', { type: 'open' })
      const buffered = this.buffered.splice(0)
      for (const event of buffered) this.handleEvent(event)
    })
  }

  /** Route one main-side event for this socket into the state machine. */
  handleEvent(event: DesktopWsEvent): void {
    if (this.readyState === DesktopWebSocket.CLOSED) return
    if (event.type === 'ws-message') {
      if (this.readyState === DesktopWebSocket.CONNECTING) {
        this.buffered.push(event)
        return
      }
      this.fire('message', { type: 'message', data: this.decodeMessage(event) })
      return
    }
    // ws-close: the host closed (or refused) the socket.
    this.readyState = DesktopWebSocket.CLOSED
    this.buffered.length = 0
    this.host.forget(this)
    this.fire('close', { type: 'close', code: event.code, reason: event.reason, wasClean: event.code === 1000 })
  }

  /**
   * Send one message: a string (text), an ArrayBuffer/ArrayBufferView (binary),
   * or a Blob (binary, read asynchronously). Throws `InvalidStateError` while
   * connecting, like the native socket; sends after close are silent no-ops.
   */
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (this.readyState === DesktopWebSocket.CONNECTING) {
      throw new DOMException('WebSocket is not open: readyState 0 (CONNECTING)', 'InvalidStateError')
    }
    if (this.readyState !== DesktopWebSocket.OPEN) return
    if (typeof data === 'string') {
      this.host.send(this, data, false)
      return
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const bytes = new Uint8Array(
        data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      )
      this.host.send(this, { b64: bytesToBase64(bytes) }, true)
      return
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      void data.arrayBuffer().then((buffer) => {
        if (this.readyState === DesktopWebSocket.OPEN) {
          this.host.send(this, { b64: bytesToBase64(new Uint8Array(buffer)) }, true)
        }
      })
      return
    }
    throw new TypeError(`WebSocket.send: unsupported data type ${typeof data}`)
  }

  /**
   * Close the socket with an optional close code and reason. A close while
   * still connecting aborts the pending open (reported as code 1006, matching
   * the native socket); a close while open completes the handshake over the
   * bridge and reports the given code.
   */
  close(code?: number, reason?: string): void {
    if (this.readyState === DesktopWebSocket.CLOSED) return
    if (code !== undefined && !isValidCloseCode(code)) {
      throw new DOMException(`The provided close code (${code}) is invalid`, 'InvalidAccessError')
    }
    if (reason !== undefined && new TextEncoder().encode(reason).length > 123) {
      throw new DOMException('The reason must be at most 123 UTF-8 bytes', 'SyntaxError')
    }
    const connecting = this.readyState === DesktopWebSocket.CONNECTING
    const finalCode = connecting ? 1006 : (code ?? 1000)
    const finalReason = connecting ? '' : (reason ?? '')
    this.readyState = DesktopWebSocket.CLOSED
    this.host.close(this, finalCode, finalReason)
    this.host.forget(this)
    queueMicrotask(() => {
      this.fire('close', { type: 'close', code: finalCode, reason: finalReason, wasClean: !connecting })
    })
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

  dispatchEvent(event: { type: string }): boolean {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event)
    return true
  }

  private decodeMessage(event: Extract<DesktopWsEvent, { type: 'ws-message' }>): unknown {
    if (!event.binary) return event.data as string
    const bytes = decodeBase64((event.data as { b64: string }).b64)
    if (this.binaryType === 'arraybuffer') {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }
    return new Blob([bytes as unknown as BlobPart])
  }

  private fire(type: 'open' | 'message' | 'close' | 'error', event: { type: string } & Record<string, unknown>): void {
    queueMicrotask(() => {
      const handler = type === 'open' ? this.onopen : type === 'message' ? this.onmessage : type === 'close' ? this.onclose : this.onerror
      handler?.call(this, event as never)
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
    })
  }
}

/**
 * The bridge dispatcher behind `patchWebSocket`: one `onWsEvent` subscription
 * routing the main's events to the shim instance holding each socket id.
 */
export class DesktopWebSocketHost {
  private readonly instances = new Map<string, DesktopWebSocket>()
  private readonly unsubscribe: () => void
  private readonly bridge: DshDesktopBridge

  constructor(bridge: DshDesktopBridge) {
    this.bridge = bridge
    this.unsubscribe = bridge.onWsEvent((event) => {
      this.instances.get(event.socketId)?.handleEvent(event)
    })
  }

  open(instance: DesktopWebSocket, url: string, protocols?: string[]): Promise<DesktopWsOpenResult> {
    this.instances.set(instance.socketId, instance)
    return this.bridge.wsOpen({ type: 'ws-open', socketId: instance.socketId, url, protocols })
  }

  send(instance: DesktopWebSocket, data: string | { b64: string }, binary: boolean): void {
    this.bridge.wsSend(instance.socketId, data, binary)
  }

  close(instance: DesktopWebSocket, code: number, reason: string): void {
    this.bridge.wsClose(instance.socketId, code, reason)
  }

  forget(instance: DesktopWebSocket): void {
    this.instances.delete(instance.socketId)
  }

  dispose(): void {
    this.instances.clear()
    this.unsubscribe()
  }
}

/**
 * Patch `globalThis.WebSocket` so desktop-host URL constructions ride the
 * bridge; every other construction keeps the captured native constructor.
 * @param bridge - preload bridge.
 * @returns disposer restoring the original constructor.
 */
export function patchWebSocket(bridge: DshDesktopBridge): () => void {
  const original = globalThis.WebSocket
  if (typeof original !== 'function') return () => {}
  const host = new DesktopWebSocketHost(bridge)
  const Wrapper = function DesktopWebSocketWrapper(this: unknown, url: string | URL, protocols?: string | readonly string[]): WebSocket {
    if (!(this instanceof Wrapper)) {
      throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator")
    }
    const target = resolveWebSocketUrl(url)
    if (target === undefined) {
      return new original(url as string | URL, protocols as string | string[] | undefined) as unknown as WebSocket
    }
    return new DesktopWebSocket(host, target.toString(), normalizeProtocols(protocols)) as unknown as WebSocket
  } as unknown as typeof WebSocket
  Object.defineProperties(Wrapper, {
    CONNECTING: { value: WS_CONNECTING, enumerable: true },
    OPEN: { value: WS_OPEN, enumerable: true },
    CLOSING: { value: WS_CLOSING, enumerable: true },
    CLOSED: { value: WS_CLOSED, enumerable: true },
  })
  globalThis.WebSocket = Wrapper
  return () => { globalThis.WebSocket = original }
}

/** Normalize the protocols argument the way the native constructor accepts it. */
function normalizeProtocols(protocols: string | readonly string[] | undefined): string[] | undefined {
  if (protocols === undefined) return undefined
  const list = typeof protocols === 'string' ? [protocols] : [...protocols]
  for (const protocol of list) {
    if (protocol === '' || !/^[\x21-\x7e]+$/.test(protocol) || protocol.includes(',')) {
      throw new DOMException(`The subprotocol '${protocol}' is invalid`, 'SyntaxError')
    }
  }
  return list
}

/** Close codes the browser WebSocket constructor accepts (RFC 6455 §7.4). */
function isValidCloseCode(code: number): boolean {
  return Number.isInteger(code) && code >= 1000 && code <= 4999
    && code !== 1004 && code !== 1005 && code !== 1006 && code !== 1015
}

/** Base64-encode bytes without the stack limits of a single big `fromCharCode`. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** @returns a random UUID string for socket correlation. */
function randomUuid(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}
