/**
 * The in-process upgrade-dispatch core shared by every virtual-host WebSocket
 * consumer (the renderer IPC bridge and the host-side `WebSocket` shim).
 *
 * The desktop's `webServer` interceptor mirrors the official `registerUpgrade`
 * contract but, having no socket, never dispatches it. This module runs a
 * registered upgrade route in-process against a synthesized request and a
 * bridge-backed `Duplex` socket — the socketless half of the official contract.
 *
 * The `ws` library owns the WebSocket protocol inside the process: the route's
 * `handleUpgrade` performs the handshake and yields a real `WebSocket` instance
 * bound to the bridge socket. The socket core then relays message-level events:
 * server→client frames are decoded (partial frames buffered across writes) and
 * re-emitted as `message` events; a server close frame is echoed as a masked
 * close frame so the closing handshake completes immediately; and client→server
 * data/close frames are pushed back as masked frames into the socket's readable
 * side, feeding the `ws` receiver exactly like a real client. No socket, port,
 * or network exists anywhere on this path.
 *
 * Consumers own the two ends: which events to emit for decoded server frames,
 * and where client data/close pushes originate.
 */

import { randomBytes } from 'node:crypto'
import { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { VirtualWebServer } from '../src/webserver.ts'

/** The loopback identity synthesized for upgrade requests. */
export const LOOPBACK_HOST = '127.0.0.1'

/** `ws`'s WebSocket.OPEN ready state. */
export const WS_OPEN_STATE = 1

/** The `ws` library's `kWebSocket` symbol description, set on the socket by `setSocket`. */
export const WEBSOCKET_SYMBOL_DESCRIPTION = 'websocket'

/** The structural `ws` instance surface consumers relay on. */
export interface WsLike {
  readonly readyState: number
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  terminate(): void
}

/** One decoded server→client frame (with its total byte length). */
interface DecodedFrame {
  opcode: number
  fin: boolean
  payload: Buffer
  bytes: number
}

/**
 * The socket an upgrade handler sees. A `Duplex` whose readable side is fed
 * only by the caller (masked client→server frames) and whose writable side
 * carries the server's own output (the 101 handshake plus unmasked
 * server→client frames), which the socket decodes and re-emits.
 */
export class BridgeSocket extends Duplex {
  /** Whether a client→server close frame has been sent; server close frames are echoed only once. */
  private closeEchoed = false
  /** Partial-fragment payload while a hand-crafted fragmented message is in flight. */
  private fragmentOpcode = 0
  private fragments: Buffer[] | undefined
  /** Incomplete frame bytes awaiting the rest of the frame. */
  private pending: Buffer = Buffer.alloc(0)

  constructor() {
    super()
    // Complete the connection when the ws instance ends its side: ending the
    // readable side lets the Duplex emit 'close', which drives the ws
    // instance's own teardown and the plugin's `close` listeners.
    this.on('finish', () => { if (!this.destroyed) this.push(null) })
  }

  _read(): void {
    // The caller pushes client frames explicitly; nothing to read on demand.
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.onServerChunk(buf)
    callback()
  }

  /** Push one client→server data frame (masked per RFC 6455 §5.3). */
  pushClientData(payload: Buffer, binary: boolean): void {
    this.push(maskedFrame(binary ? 0x2 : 0x1, payload))
  }

  /** Push one client→server close frame (masked per RFC 6455 §5.3). */
  pushClientClose(payload: Buffer): void {
    this.closeEchoed = true
    this.push(maskedFrame(0x8, payload))
  }

  /**
   * Decode one server→client chunk (the 101 handshake or frame bytes) and
   * route it. Frames can arrive split across writes, so partial frames are
   * buffered until complete.
   */
  private onServerChunk(buf: Buffer): void {
    // The 101 handshake is the first write and is not a frame. `ws` writes it
    // whole (single `socket.write`), so a chunk starting with the status line
    // is consumed wholesale.
    if (this.pending.length === 0 && buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === 'HTTP/') return
    this.pending = this.pending.length === 0 ? buf : Buffer.concat([this.pending, buf])
    while (true) {
      const frame = parseFrame(this.pending)
      if (frame === undefined) break
      this.pending = frame.bytes < this.pending.length ? this.pending.subarray(frame.bytes) : Buffer.alloc(0)
      this.onFrame(frame)
    }
  }

  private onFrame(frame: DecodedFrame): void {
    if (frame.opcode === 0x8) {
      // Close frame: echo a masked close frame so the receiver concludes and
      // the `close` event fires with the server's real code/reason instead of
      // after the closeTimeout.
      if (!this.closeEchoed) {
        this.closeEchoed = true
        this.push(maskedFrame(0x8, frame.payload))
      }
      return
    }
    if (frame.opcode === 0x9 || frame.opcode === 0xa) return // ping/pong: no peer to answer
    if (frame.opcode !== 0x0) this.fragmentOpcode = frame.opcode
    if (frame.fin) {
      const payload = this.fragments === undefined
        ? frame.payload
        : Buffer.concat([...this.fragments, frame.payload])
      const opcode = frame.opcode === 0x0 ? this.fragmentOpcode : frame.opcode
      this.fragments = undefined
      this.fragmentOpcode = 0
      this.emit('message', opcode, payload)
      return
    }
    this.fragments ??= []
    this.fragments.push(frame.payload)
  }
}

/**
 * Parse one complete server→client frame off the front of a buffer (unmasked,
 * possibly extended length). Returns undefined while the buffer holds only a
 * partial frame.
 */
function parseFrame(buf: Buffer): DecodedFrame | undefined {
  if (buf.length < 2 || (buf[1] & 0x80) !== 0) return undefined
  const b0 = buf[0]
  let offset = 2
  let length = buf[1] & 0x7f
  if (length === 126) {
    if (buf.length < 4) return undefined
    length = buf.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buf.length < 10) return undefined
    length = buf.readUInt32BE(2) * 2 ** 32 + buf.readUInt32BE(6)
    offset = 10
  }
  if (buf.length < offset + length) return undefined
  return {
    opcode: b0 & 0x0f,
    fin: (b0 & 0x80) !== 0,
    payload: buf.subarray(offset, offset + length),
    bytes: offset + length,
  }
}

/** Build one masked client→server frame (close payloads are always ≤ 125 bytes). */
function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const masked = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4]
  const header: number[] = [0x80 | opcode]
  if (payload.length <= 125) {
    header.push(0x80 | payload.length)
  } else if (payload.length <= 0xffff) {
    header.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff)
  } else {
    const lengthBytes = Buffer.alloc(8)
    lengthBytes.writeBigUInt64BE(BigInt(payload.length))
    header.push(0x80 | 127, ...lengthBytes)
  }
  return Buffer.concat([Buffer.from(header), mask, masked])
}

/** Minimal Node-http request stand-in for an upgrade route handler. */
export class VirtualUpgradeRequest {
  readonly method = 'GET'
  readonly url: string
  readonly headers: Record<string, string>
  readonly socket = { remoteAddress: LOOPBACK_HOST, authorized: false, encrypted: false }

  constructor(target: URL, protocols?: string[]) {
    this.url = `${target.pathname}${target.search}`
    const headers: Record<string, string> = {
      // The loopback identity the plugin trust fences demand (host + origin
      // match), mirroring the HTTP bridge's synthesized headers.
      host: LOOPBACK_HOST,
      origin: `http://${LOOPBACK_HOST}`,
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': randomBytes(16).toString('base64'),
      'sec-websocket-version': '13',
    }
    if (protocols !== undefined && protocols.length > 0) {
      headers['sec-websocket-protocol'] = protocols.join(', ')
    }
    this.headers = headers
  }

  destroy(): void {
    // In-process stand-in: nothing to tear down.
  }
}

/** One open bridge socket: the duplex plus the discovered ws instance. */
export interface OpenUpgrade {
  socket: BridgeSocket
  ws: WsLike
}

/** Upgrade-open options: subprotocols plus the server-frame relay. */
export interface OpenUpgradeOptions {
  /** Optional subprotocols, passed to the synthesized request. */
  protocols?: string[]
  /**
   * Decoded server→client frame relay, attached before the route handler runs
   * so frames written during the handler (e.g. a terminal transcript replay)
   * are not lost.
   */
  onServerMessage?: (opcode: number, payload: Buffer) => void
}

/**
 * Run one registered upgrade route in-process against a synthesized request and
 * a fresh bridge socket, waiting for the handler to attach its `ws` instance.
 * @param ctx - booted desktop context (its `webServer` registry holds the
 *   upgrade routes).
 * @param target - the parsed ws(s) URL (its pathname selects the route).
 * @param options - subprotocols and the server-frame relay.
 * @returns the open socket + ws instance, or undefined when there is no route
 *   for the pathname or the upgrade did not complete.
 */
export async function openVirtualHostSocket(
  ctx: Context,
  target: URL,
  options?: OpenUpgradeOptions,
): Promise<OpenUpgrade | undefined> {
  if (target.protocol !== 'ws:' && target.protocol !== 'wss:') return undefined
  const webServer = ctx.get('webServer') as VirtualWebServer | undefined
  const route = webServer?.upgrades.get(target.pathname)
  if (route === undefined) return undefined

  const socket = new BridgeSocket()
  const holder: { failure?: string } = {}
  socket.on('close', () => {
    if (holder.failure === undefined) holder.failure = 'connection closed before upgrade'
  })
  if (options?.onServerMessage !== undefined) {
    socket.on('message', options.onServerMessage)
  }

  const handler = route.handler as unknown as (req: VirtualUpgradeRequest, socket: BridgeSocket, head: Buffer) => void | Promise<void>
  try {
    await handler(new VirtualUpgradeRequest(target, options?.protocols), socket, Buffer.alloc(0))
  } catch (error) {
    socket.destroy()
    return undefined
  }
  // The upgraded ws instance lands when the handler's handleUpgrade runs —
  // synchronously for the harness's own upgrade routes, but possibly after the
  // handler returns. Wait for it (or the socket dying) before deciding the
  // open failed.
  const ws = await awaitWebSocket(socket)
  if (ws === undefined) {
    socket.destroy()
    return undefined
  }
  return { socket, ws }
}

/**
 * Read the upgraded `ws` instance off the bridge socket. `ws`'s `setSocket`
 * assigns the instance to the socket under its private `kWebSocket` symbol;
 * the symbol is not exported, so it is located by description. If a future ws
 * renames it, the open fails — degraded but visible.
 */
function findAttachedWebSocket(socket: BridgeSocket): WsLike | undefined {
  const symbol = Object.getOwnPropertySymbols(socket).find((s) => s.description === WEBSOCKET_SYMBOL_DESCRIPTION)
  if (symbol === undefined) return undefined
  return (socket as unknown as Record<symbol, unknown>)[symbol] as WsLike | undefined
}

/** How long an upgrade may take before the open is declared failed. */
const UPGRADE_WAIT_MS = 1000

/**
 * Wait for the upgrade handler to attach its `ws` instance to the socket,
 * resolving early when the socket dies (a refusal or a handler that never
 * upgrades). The harness's own handlers upgrade synchronously; the wait covers
 * handlers that defer `handleUpgrade` to a later tick.
 */
function awaitWebSocket(socket: BridgeSocket): Promise<WsLike | undefined> {
  const attached = (): WsLike | undefined => findAttachedWebSocket(socket)
  if (attached() !== undefined) return Promise.resolve(attached())
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      const ws = attached()
      if (ws !== undefined) {
        cleanup()
        resolve(ws)
      }
    }, 5)
    const deadline = setTimeout(() => {
      cleanup()
      resolve(undefined)
    }, UPGRADE_WAIT_MS)
    const onClose = (): void => {
      cleanup()
      resolve(undefined)
    }
    socket.once('close', onClose)
    const cleanup = (): void => {
      clearInterval(poll)
      clearTimeout(deadline)
      socket.removeListener('close', onClose)
    }
  })
}
