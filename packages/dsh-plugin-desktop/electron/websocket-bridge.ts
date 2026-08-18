/**
 * Main-process WebSocket-over-IPC bridge (the virtual-host upgrade dispatch).
 *
 * The desktop's `webServer` interceptor mirrors the official
 * `registerUpgrade` contract but, having no socket, never dispatches it — a
 * plugin WebSocket (dsh-better-sidebar's `/sidebar/ws/*` terminals) therefore
 * has no server to reach. This module closes the gap for the renderer the same
 * way the HTTP bridge does: the renderer's patched `WebSocket` sends `ws-open`
 * over the preload bridge, and this bridge runs the registered upgrade route
 * in-process against a synthesized request and a bridge-backed `Duplex`
 * socket, then relays message-level events to the renderer.
 *
 * The socket-level mechanics (frame decode/mask/close-echo, the synthesized
 * upgrade request, and the in-process upgrade dispatch) live in
 * `virtual-host-socket.ts`, shared with the host-side `WebSocket` shim; this
 * module owns only the IPC wiring: the `ws-open` invoke, the `ws-send` /
 * `ws-close` one-way relays, the main→renderer event push, and per-socket
 * lifecycle bound to the renderer context that opened it.
 */

import type { Context } from '@deepseek-ai/cordis'
import { openVirtualHostSocket, WS_OPEN_STATE, type BridgeSocket, type WsLike } from './virtual-host-socket.ts'

// Wire shapes mirrored from dsh-plugin-desktop-connection's
// src/client/ipc-api-client.ts (the repo convention: each end declares its own
// copy of the bridge contract).

/** One renderer→main ws-open request (mirrors `DesktopWsOpenRequest`). */
export interface DesktopWsOpenRequest {
  type: 'ws-open'
  socketId: string
  url: string
  protocols?: string[]
}

/** The ws-open invoke reply (mirrors `DesktopWsOpenResult`). */
export type DesktopWsOpenResult =
  | { type: 'ws-opened'; socketId: string }
  | { type: 'ws-failed'; message: string }

/** One main→renderer WebSocket event (mirrors `DesktopWsEvent`). */
export type DesktopWsEvent =
  | { type: 'ws-message'; socketId: string; data: string | { b64: string }; binary: boolean }
  | { type: 'ws-close'; socketId: string; code: number; reason: string }

/** Renderer-minted socket ids are bounded to keep the map keys sane. */
const MAX_SOCKET_ID_LENGTH = 64

/** One open bridge socket: the duplex plus the discovered ws instance. */
interface BridgeEntry {
  socket: BridgeSocket
  ws: WsLike
}

/** The bridge surface the IPC layer installs. */
export interface WebSocketBridge {
  open(request: DesktopWsOpenRequest): Promise<DesktopWsOpenResult>
  send(socketId: string, data: string | { b64: string }, binary: boolean): void
  close(socketId: string, code: number, reason: string): void
  terminate(socketId: string): void
  dispose(): void
  onSocketClosed(listener: (socketId: string) => void): () => void
}

/**
 * Create the WebSocket bridge for one booted host generation.
 * @param ctx - booted desktop context (its `webServer` registry holds the upgrade routes).
 * @param emit - the main→renderer event sink (the IPC layer's webContents push).
 * @returns the bridge surface.
 */
export function createWebSocketBridge(ctx: Context, emit: (event: DesktopWsEvent) => void): WebSocketBridge {
  const entries = new Map<string, BridgeEntry>()
  const pendingClose = new Set<string>()
  const closedListeners = new Set<(socketId: string) => void>()

  async function open(request: DesktopWsOpenRequest): Promise<DesktopWsOpenResult> {
    if (typeof request?.socketId !== 'string' || request.socketId.length === 0 || request.socketId.length > MAX_SOCKET_ID_LENGTH) {
      return { type: 'ws-failed', message: 'invalid socket id' }
    }
    let target: URL
    try {
      target = new URL(request.url)
    } catch {
      return { type: 'ws-failed', message: 'invalid websocket url' }
    }
    if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
      return { type: 'ws-failed', message: 'websocket url must use the ws or wss scheme' }
    }
    // Relay decoded server→client frames immediately — the handler may write
    // (e.g. a terminal transcript replay) before the open reply reaches the
    // renderer, and the shim buffers messages until the open lands. A frame
    // relayed for a socket the renderer never opened is dropped by the shim's
    // socket-id routing.
    const opened = await openVirtualHostSocket(ctx, target, {
      protocols: request.protocols,
      onServerMessage: (opcode: number, payload: Buffer) => {
        const binary = opcode === 0x2
        safeEmit({ type: 'ws-message', socketId: request.socketId, data: binary ? { b64: payload.toString('base64') } : payload.toString('utf8'), binary })
      },
    })
    if (opened === undefined) {
      const webServer = ctx.get('webServer')
      const route = webServer?.upgrades.get(target.pathname)
      return { type: 'ws-failed', message: route === undefined ? `no websocket upgrade route for ${target.pathname}` : 'websocket upgrade did not complete' }
    }

    const { socket, ws } = opened
    const entry: BridgeEntry = { socket, ws }
    entries.set(request.socketId, entry)
    if (pendingClose.has(request.socketId)) {
      pendingClose.delete(request.socketId)
      ws.terminate()
    }
    attachRelays(request.socketId, entry)
    return { type: 'ws-opened', socketId: request.socketId }
  }

  function attachRelays(socketId: string, entry: BridgeEntry): void {
    const { ws } = entry
    const onClose = (code: number, reason: Buffer): void => {
      safeEmit({ type: 'ws-close', socketId, code, reason: reason.toString('utf8') })
      cleanup()
    }
    const onError = (error: Error): void => {
      console.warn(`dsh-desktop: websocket ${socketId} error: ${error.message}`)
    }
    const cleanup = (): void => {
      if (!entries.has(socketId)) return
      entries.delete(socketId)
      for (const listener of [...closedListeners]) listener(socketId)
    }
    ws.on('close', onClose)
    ws.on('error', onError)
  }

  /** Push an event without letting a throwing sink wedge the socket's write path. */
  function safeEmit(event: DesktopWsEvent): void {
    try {
      emit(event)
    } catch (error) {
      console.warn(`dsh-desktop: websocket event relay failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function send(socketId: string, data: string | { b64: string }, binary: boolean): void {
    const entry = entries.get(socketId)
    if (entry === undefined || entry.ws.readyState !== WS_OPEN_STATE) return
    entry.socket.pushClientData(binary ? Buffer.from((data as { b64: string }).b64, 'base64') : Buffer.from(data as string, 'utf8'), binary)
  }

  function close(socketId: string, code: number, reason: string): void {
    const entry = entries.get(socketId)
    if (entry === undefined) {
      // The close raced the open: remember it so the socket is torn down the
      // moment it exists.
      pendingClose.add(socketId)
      return
    }
    const codeBytes = [((code >> 8) & 0xff), code & 0xff]
    const payload = Buffer.concat([Buffer.from(codeBytes), Buffer.from(reason, 'utf8')])
    entry.socket.pushClientClose(payload)
  }

  function terminate(socketId: string): void {
    entries.get(socketId)?.ws.terminate()
  }

  function dispose(): void {
    for (const entry of entries.values()) entry.ws.terminate()
    entries.clear()
    pendingClose.clear()
    closedListeners.clear()
  }

  function onSocketClosed(listener: (socketId: string) => void): () => void {
    closedListeners.add(listener)
    return () => { closedListeners.delete(listener) }
  }

  return { open, send, close, terminate, dispose, onSocketClosed }
}
