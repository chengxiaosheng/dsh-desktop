/**
 * Desktop IPC carrier: the renderer half of the Electron desktop surface. It
 * satisfies the same `AbstractApiClient` two-stream abstraction as the browser
 * HTTP/WebSocket carrier — unary/respond route through the preload bridge's
 * `invoke`, and the two downlink event streams arrive through the bridge's
 * `subscribe` — so the ConnectionController, the runtime object layer, and
 * every client plugin run unchanged when `window.dshDesktop` is present. No
 * HTTP server, port, or WebSocket exists on the desktop path.
 */

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { RpcId, serverResponseSchema, type RpcMessage, type RpcResult, type RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import type { ApiProxy, HostFrame, MuxFrame, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'

/** One downlink message the main pushes through the bridge's `subscribe`. */
export type DshDesktopFrame =
  | { type: 'stream/end' }
  | { type: 'server-request'; rpcId: string; method: string; payload: unknown }

/**
 * One main→renderer WebSocket event. Mirrored by the desktop package's
 * `electron/websocket-bridge.ts` (`DesktopWsEvent`).
 */
export type DesktopWsEvent =
  | { type: 'ws-message'; socketId: string; data: string | { b64: string }; binary: boolean }
  | { type: 'ws-close'; socketId: string; code: number; reason: string }

/**
 * The ws-open invoke reply. Mirrored by the desktop package's
 * `electron/websocket-bridge.ts` (`DesktopWsOpenResult`).
 */
export type DesktopWsOpenResult =
  | { type: 'ws-opened'; socketId: string }
  | { type: 'ws-failed'; message: string }

/**
 * One renderer→main ws-open request. Mirrored by the desktop package's
 * `electron/websocket-bridge.ts` (`DesktopWsOpenRequest`).
 */
export interface DesktopWsOpenRequest {
  type: 'ws-open'
  /** Renderer-minted socket id; every later message correlates on it. */
  socketId: string
  /** Absolute virtual-host WebSocket URL (scheme ws/wss, host `dsh.internal`). */
  url: string
  /** Subprotocols as passed to `new WebSocket`, when any. */
  protocols?: string[]
}

/**
 * The preload bridge the Electron main process exposes to the renderer
 * (`window.dshDesktop`). Implemented by the Electron main over IPC; the carrier
 * is the only desktop-specific dependency this package knows.
 */
export interface DshDesktopBridge {
  /**
   * Perform one unary/respond RPC against the in-process host. Returns the wire
   * response envelope (`ServerResponse` for RPC calls, `HttpBridgeResponse`
   * for raw virtual-host requests).
   */
  invoke(request: { path: string; body?: unknown }): Promise<unknown>
  /**
   * Subscribe to one host downlink event stream; `{ type: 'stream/end' }`
   * closes the stream. Returns the unsubscribe function.
   */
  subscribe(channel: 'mux' | 'host', listener: (frame: DshDesktopFrame) => void): () => void
  /**
   * Open one WebSocket against the in-process host's upgrade routes. The main
   * runs the registered upgrade handler in-process and answers `ws-opened`
   * once the socket is established. Messages pushed through `onWsEvent` may
   * arrive before this resolves — the shim buffers them until the open lands.
   */
  wsOpen(request: DesktopWsOpenRequest): Promise<DesktopWsOpenResult>
  /**
   * Send one message frame on an open socket: a UTF-8 string (text) or a
   * base64 payload (binary). No-op for unknown or non-open sockets.
   */
  wsSend(socketId: string, data: string | { b64: string }, binary: boolean): void
  /**
   * Close a socket with a WebSocket close code and reason. No-op for unknown
   * sockets; a close sent while the open is still in flight is honored once
   * the socket exists.
   */
  wsClose(socketId: string, code: number, reason: string): void
  /** Subscribe to the host's WebSocket events; returns the unsubscribe function. */
  onWsEvent(listener: (event: DesktopWsEvent) => void): () => void
}

const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Desktop carrier over the preload bridge. `doFetch` maps the unary/respond
 * POST onto `bridge.invoke` and returns a constructed `Response` carrying the
 * returned envelope; `openMux`/`openHost` iterate frames pushed through
 * `bridge.subscribe`.
 */
export class IpcApiClient extends AbstractApiClient {
  readonly bridge: DshDesktopBridge

  constructor(bridge: DshDesktopBridge) {
    super()
    this.bridge = bridge
  }

  /** Transport leg: forward the POST to the host over IPC and wrap the returned envelope. */
  doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const body = init?.body === undefined
      ? undefined
      : JSON.parse(init.body as string)
    const request: { path: string; body?: unknown } = { path: new URL(input).pathname }
    if (body !== undefined) request.body = body
    return this.bridge.invoke(request)
      .then((value) => new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
  }

  /** Mux stream opener: frames arrive through the preload bridge subscription. */
  protected openMux(_payload: Parameters<ApiProxy['events']['mux']>[0]['payload'], signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readStream('mux', muxFrameSchema, signal, onOpen)
  }

  /** Host stream opener: frames arrive through the preload bridge subscription. */
  protected openHost(_payload: Parameters<ApiProxy['events']['host']>[0]['payload'], signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readStream('host', hostFrameSchema, signal, onOpen)
  }

  private async *readStream<F extends MuxFrame | HostFrame>(
    channel: 'mux' | 'host',
    frameSchema: { parse(data: unknown): F },
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const inbox: Array<{ kind: 'end' } | { kind: 'frame'; envelope: RpcRequest<F> }> = []
    let wake: (() => void) | undefined
    const enqueue = (item: { kind: 'end' } | { kind: 'frame'; envelope: RpcRequest<F> }): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleMessage = (message: DshDesktopFrame): void => {
      if (message.type === 'stream/end') {
        enqueue({ kind: 'end' })
        return
      }
      let frame: F
      try {
        frame = frameSchema.parse(message.payload)
      } catch (error) {
        console.error(`[client-connection] dropping malformed IPC frame on ${channel}:`, error)
        return
      }
      // The bridge frame carries the server-request wire shape; feed the
      // observation buffer with the host-minted rpcId re-branded (zero runtime cost).
      this.onEnvelope(message as unknown as ServerRequest)
      enqueue({ kind: 'frame', envelope: { rpcId: RpcId(message.rpcId), payload: frame } })
    }
    const unsubscribe = this.bridge.subscribe(channel, handleMessage)
    onOpen?.()
    const handleAbort = (): void => {
      unsubscribe()
      enqueue({ kind: 'end' })
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift()
          if (item === undefined) continue
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      unsubscribe()
    }
  }
}

/**
 * Desktop generic RPC caller over the preload bridge, mirroring the browser
 * `createWebConnectionRpc` transport leg. Generic channels route through
 * `bridge.invoke` instead of `globalThis.fetch`.
 * @param bridge - the preload-exposed desktop bridge.
 * @returns caller that owns request correlation and response-envelope validation.
 */
export function createDesktopConnectionRpc(bridge: DshDesktopBridge): ClientConnectionRpc {
  return {
    async call(channel, endpoint, payload, _signal) {
      assertTarget(channel, endpoint)
      const rpcId = RpcId(randomUuid())
      const message = {
        type: 'client-request' as const,
        rpcId,
        method: endpoint,
        payload,
      }
      const response = await bridge.invoke({ path: `${channel}/${endpoint}`, body: message })
      const full = serverResponseSchema.parse(response)
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      return full.result as RpcResult<unknown>
    },
  }
}

/** @returns a random UUID string for RPC correlation. */
function randomUuid(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}

function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/')
  if (!CHANNEL_PATTERN.test(channel)
    || segments.some((segment) =>
      segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}
