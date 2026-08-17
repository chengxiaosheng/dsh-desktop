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
import { RpcId, serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'

/**
 * The preload bridge the Electron main process exposes to the renderer
 * (`window.dshDesktop`). Implemented by the Electron main over IPC; the carrier
 * is the only desktop-specific dependency this package knows.
 */
/** @typedef {object} DshDesktopBridge
 * @property {(request: { path: string, body?: object }) => Promise<unknown>} invoke
 *   Perform one unary/respond RPC against the in-process host. Returns the wire
 *   response envelope.
 * @property {(channel: 'mux' | 'host', listener: (message: object | { type: 'stream/end' }) => void) => () => void} subscribe
 *   Subscribe to one host downlink event stream; `{ type: 'stream/end' }`
 *   closes the stream. Returns the unsubscribe function.
 */

const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Desktop carrier over the preload bridge. `doFetch` maps the unary/respond
 * POST onto `bridge.invoke` and returns a constructed `Response` carrying the
 * returned envelope; `openMux`/`openHost` iterate frames pushed through
 * `bridge.subscribe`.
 */
export class IpcApiClient extends AbstractApiClient {
  /** @param {DshDesktopBridge} bridge - the preload-exposed desktop bridge. */
  constructor(bridge) {
    super()
    this.bridge = bridge
  }

  /** Transport leg: forward the POST to the host over IPC and wrap the returned envelope. */
  doFetch(input, init) {
    const body = init?.body === undefined
      ? undefined
      : JSON.parse(init.body)
    const request = { path: new URL(input).pathname }
    if (body !== undefined) request.body = body
    return this.bridge.invoke(request)
      .then((value) => new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
  }

  /** Mux stream opener: frames arrive through the preload bridge subscription. */
  openMux(_payload, signal, onOpen) {
    return this.readStream('mux', muxFrameSchema, signal, onOpen)
  }

  /** Host stream opener: frames arrive through the preload bridge subscription. */
  openHost(_payload, signal, onOpen) {
    return this.readStream('host', hostFrameSchema, signal, onOpen)
  }

  async *readStream(channel, frameSchema, signal, onOpen) {
    const inbox = []
    let wake
    const enqueue = (item) => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleMessage = (message) => {
      if (message.type === 'stream/end') {
        enqueue({ kind: 'end' })
        return
      }
      let frame
      try {
        frame = frameSchema.parse(message.payload)
      } catch (error) {
        console.error(`[client-connection] dropping malformed IPC frame on ${channel}:`, error)
        return
      }
      this.onEnvelope(message)
      enqueue({ kind: 'frame', envelope: { rpcId: message.rpcId, payload: frame } })
    }
    const unsubscribe = this.bridge.subscribe(channel, handleMessage)
    onOpen?.()
    const handleAbort = () => {
      unsubscribe()
      enqueue({ kind: 'end' })
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift()
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise((resolve) => { wake = resolve })
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
 * @param {DshDesktopBridge} bridge - the preload-exposed desktop bridge.
 * @returns caller that owns request correlation and response-envelope validation.
 */
export function createDesktopConnectionRpc(bridge) {
  return {
    async call(channel, endpoint, payload, _signal) {
      assertTarget(channel, endpoint)
      const rpcId = RpcId(randomUuid())
      const message = {
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload,
      }
      const response = await bridge.invoke({ path: `${channel}/${endpoint}`, body: message })
      const full = serverResponseSchema.parse(response)
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      return full.result
    },
  }
}

/** @returns a random UUID string for RPC correlation. */
function randomUuid() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}

function assertTarget(channel, endpoint) {
  const segments = endpoint.split('/')
  if (!CHANNEL_PATTERN.test(channel)
    || segments.some((segment) =>
      segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}
