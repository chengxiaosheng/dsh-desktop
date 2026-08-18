/**
 * Headless tests for the main-process WebSocket bridge (`websocket-bridge.ts`).
 *
 * Boots a minimal in-process host: a cordis context with the virtual
 * webserver service, a better-sidebar-style upgrade route backed by a real
 * `ws` `WebSocketServer({ noServer: true })` — no TCP socket anywhere — and
 * the bridge with a captured event sink. Verifies the full message-level
 * relay: open, server→client data, client→server data (masked frames),
 * server-initiated close with code/reason, client-initiated close, refusals,
 * and teardown.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { WebSocketServer, WebSocket } from 'ws'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { VirtualWebServer } from '../src/webserver.ts'
import { createWebSocketBridge, type DesktopWsEvent } from '../electron/websocket-bridge.ts'

/** Wait until `probe` is truthy, polling every 5 ms up to 1 s. */
async function waitFor(probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** One better-sidebar-style upgrade route over a noServer ws server. */
function mountTerminalRoute(webServer: VirtualWebServer): {
  wss: WebSocketServer
  attached: Array<WebSocket>
  received: string[]
} {
  const wss = new WebSocketServer({ noServer: true })
  const attached: WebSocket[] = []
  const received: string[] = []
  webServer.registerUpgrade({
    path: '/sidebar/ws/terminal',
    handler: (req, socket, head) => {
      // The plugin's trust fence reads req.url and destroys the socket on
      // refusal; the bridge must report it as a failed open.
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      if (url.searchParams.get('sessionId') === null) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(
        req as unknown as IncomingMessage,
        socket as unknown as Duplex,
        head as Buffer,
        (ws) => {
          attached.push(ws)
          ws.on('message', (data) => received.push(data.toString('utf8')))
          ws.send('welcome') // written synchronously, before the open reply
        },
      )
    },
  })
  return { wss, attached, received }
}

test('virtual-host upgrade routes dispatch in-process over the bridge', async () => {
  const ctx = new Context()
  const webServer = new VirtualWebServer(ctx, { host: '127.0.0.1', port: 0 })
  const { wss, attached, received } = mountTerminalRoute(webServer)
  const events: DesktopWsEvent[] = []
  const bridge = createWebSocketBridge(ctx, (event) => events.push(event))
  try {
    const result = await bridge.open({
      type: 'ws-open',
      socketId: 'sock-1',
      url: 'ws://dsh.internal/sidebar/ws/terminal?sessionId=s1&tab=terminal:1',
    })
    assert.equal(result.type, 'ws-opened')
    assert.equal(attached.length, 1, 'the ws instance upgraded in-process')

    // The handler's synchronous 'welcome' is relayed (the renderer shim
    // buffers pre-open messages, so the relay may precede the reply).
    await waitFor(() => events.some((event) => event.type === 'ws-message' && event.data === 'welcome'))

    // Client → server text and binary reach the plugin's message handler.
    bridge.send('sock-1', 'ls -la', false)
    await waitFor(() => received.length === 1)
    assert.equal(received[0], 'ls -la')
    bridge.send('sock-1', { b64: Buffer.from([0, 1, 2]).toString('base64') }, true)
    await waitFor(() => received.length === 2)
    assert.deepEqual(Buffer.from(received[1], 'binary'), Buffer.from([0, 1, 2]))

    // Server → client binary arrives as a base64 ws-message.
    attached[0].send(Buffer.from([9, 8, 7]), { binary: true })
    await waitFor(() => events.some((event) => event.type === 'ws-message' && typeof event.data === 'object'))
    const binary = events.find((event) => event.type === 'ws-message' && typeof event.data === 'object') as
      { type: 'ws-message'; data: { b64: string } }
    assert.deepEqual(Buffer.from(binary.data.b64, 'base64'), Buffer.from([9, 8, 7]))

    // A server-initiated close relays the real code and reason promptly (the
    // bridge echoes the close frame so the handshake completes immediately).
    attached[0].close(1011, 'pty deps missing')
    await waitFor(() => events.some((event) => event.type === 'ws-close' && event.code === 1011))
    const closed = events.find((event) => event.type === 'ws-close' && event.code === 1011) as
      { type: 'ws-close'; code: number; reason: string }
    assert.equal(closed.reason, 'pty deps missing')
    assert.equal(attached[0].readyState, WebSocket.CLOSED, 'server-side ws completed its close')
  } finally {
    bridge.dispose()
    wss.close()
    void ctx.fiber.dispose()
  }
})

test('a renderer-initiated close completes the handshake with its code', async () => {
  const ctx = new Context()
  const webServer = new VirtualWebServer(ctx, { host: '127.0.0.1', port: 0 })
  const { wss, attached } = mountTerminalRoute(webServer)
  const events: DesktopWsEvent[] = []
  const bridge = createWebSocketBridge(ctx, (event) => events.push(event))
  try {
    const result = await bridge.open({
      type: 'ws-open',
      socketId: 'sock-2',
      url: 'ws://dsh.internal/sidebar/ws/terminal?sessionId=s2&tab=terminal:2',
    })
    assert.equal(result.type, 'ws-opened')
    const closedCodes: number[] = []
    attached[0].on('close', (code) => closedCodes.push(code))

    bridge.close('sock-2', 1000, 'bye')
    await waitFor(() => attached[0].readyState === WebSocket.CLOSED)
    await waitFor(() => closedCodes.includes(1000))
    assert.ok(closedCodes.includes(1000), 'server-side ws saw the renderer close code')
  } finally {
    bridge.dispose()
    wss.close()
    void ctx.fiber.dispose()
  }
})

test('a close racing the open tears the socket down once it exists', async () => {
  const ctx = new Context()
  const webServer = new VirtualWebServer(ctx, { host: '127.0.0.1', port: 0 })
  const wss = new WebSocketServer({ noServer: true })
  const attached: WebSocket[] = []
  webServer.registerUpgrade({
    path: '/slow/ws',
    handler: (req, socket, head) => {
      // Defer the upgrade so the renderer's close lands before the open reply.
      setTimeout(() => {
        wss.handleUpgrade(
          req as unknown as IncomingMessage,
          socket as unknown as Duplex,
          head as Buffer,
          (ws) => { attached.push(ws) },
        )
      }, 20)
    },
  })
  const events: DesktopWsEvent[] = []
  const bridge = createWebSocketBridge(ctx, (event) => events.push(event))
  try {
    const opening = bridge.open({ type: 'ws-open', socketId: 'sock-3', url: 'ws://dsh.internal/slow/ws' })
    bridge.close('sock-3', 1000, '')
    const result = await opening
    assert.equal(result.type, 'ws-opened', 'the open itself still succeeds')
    await waitFor(() => attached.length === 1 && attached[0].readyState === WebSocket.CLOSED)
  } finally {
    bridge.dispose()
    wss.close()
    void ctx.fiber.dispose()
  }
})

test('missing routes, refusals, and invalid input fail the open', async () => {
  const ctx = new Context()
  const webServer = new VirtualWebServer(ctx, { host: '127.0.0.1', port: 0 })
  const { wss } = mountTerminalRoute(webServer)
  const events: DesktopWsEvent[] = []
  const bridge = createWebSocketBridge(ctx, (event) => events.push(event))
  try {
    const missing = await bridge.open({ type: 'ws-open', socketId: 'x1', url: 'ws://dsh.internal/nope' })
    assert.equal(missing.type, 'ws-failed')
    assert.match((missing as { message: string }).message, /no websocket upgrade route/)

    // The trust fence refuses by destroying the socket.
    const refused = await bridge.open({ type: 'ws-open', socketId: 'x2', url: 'ws://dsh.internal/sidebar/ws/terminal' })
    assert.equal(refused.type, 'ws-failed')

    const badScheme = await bridge.open({ type: 'ws-open', socketId: 'x3', url: 'http://dsh.internal/sidebar/ws/terminal' })
    assert.equal(badScheme.type, 'ws-failed')
    const badId = await bridge.open({ type: 'ws-open', socketId: '', url: 'ws://dsh.internal/nope' })
    assert.equal(badId.type, 'ws-failed')
    assert.equal(events.length, 0, 'no events pushed for failed opens')
  } finally {
    bridge.dispose()
    wss.close()
    void ctx.fiber.dispose()
  }
})

test('dispose terminates every open socket', async () => {
  const ctx = new Context()
  const webServer = new VirtualWebServer(ctx, { host: '127.0.0.1', port: 0 })
  const { wss, attached } = mountTerminalRoute(webServer)
  const events: DesktopWsEvent[] = []
  const bridge = createWebSocketBridge(ctx, (event) => events.push(event))
  const result = await bridge.open({
    type: 'ws-open',
    socketId: 'sock-4',
    url: 'ws://dsh.internal/sidebar/ws/terminal?sessionId=s4&tab=terminal:4',
  })
  assert.equal(result.type, 'ws-opened')
  bridge.dispose()
  await waitFor(() => attached[0].readyState === WebSocket.CLOSED)
  assert.ok(events.some((event) => event.type === 'ws-close' && event.socketId === 'sock-4'))
  wss.close()
  void ctx.fiber.dispose()
})
