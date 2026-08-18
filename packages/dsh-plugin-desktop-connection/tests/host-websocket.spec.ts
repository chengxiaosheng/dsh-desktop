/**
 * Tests for the desktop virtual-host WebSocket bridge (`host-websocket.ts`).
 *
 * Runs in plain Node with a fake preload bridge, matching the client-half test
 * style: the shim only touches fetch-free globals (URL, Blob, btoa, crypto,
 * DOMException, TextEncoder), all Node globals. A fake native WebSocket class
 * stands in for the captured browser constructor so the passthrough path is
 * observable without a browser.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DesktopWebSocket,
  DesktopWebSocketHost,
  resolveWebSocketUrl,
  patchWebSocket,
} from '../src/client/host-websocket.ts'
import type { DshDesktopBridge, DesktopWsEvent } from '../src/client/ipc-api-client.ts'

/** A fake preload bridge: records ws calls and can push ws events. */
function fakeBridge(openResult: () => Promise<{ type: 'ws-opened'; socketId: string } | { type: 'ws-failed'; message: string }>) {
  const events: DesktopWsEvent[] = []
  const sent: Array<{ socketId: string; data: unknown; binary: boolean }> = []
  const closed: Array<{ socketId: string; code: number; reason: string }> = []
  let listener: ((event: DesktopWsEvent) => void) | undefined
  const bridge: DshDesktopBridge = {
    invoke: async () => { throw new Error('not exercised') },
    subscribe: () => () => {},
    wsOpen: async (request) => {
      if (request.url.includes('fail')) return { type: 'ws-failed', message: 'no upgrade route' }
      return openResult()
    },
    wsSend: (socketId, data, binary) => { sent.push({ socketId, data, binary }) },
    wsClose: (socketId, code, reason) => { closed.push({ socketId, code, reason }) },
    onWsEvent: (cb) => { listener = cb; return () => { listener = undefined } },
  }
  return {
    bridge,
    push(event: DesktopWsEvent): void { listener?.(event) },
    events,
    sent,
    closed,
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

test('resolveWebSocketUrl maps file:// targets to the virtual host', () => {
  const url = resolveWebSocketUrl('file:///sidebar/ws/terminal?sessionId=s1&tab=terminal:1')
  assert.equal(url?.toString(), 'ws://dsh.internal/sidebar/ws/terminal?sessionId=s1&tab=terminal:1')
  // The exact URL dsh-better-sidebar builds on the desktop's file:// page.
  assert.equal(resolveWebSocketUrl('/sidebar/ws/terminal', 'file:///app/index.html')?.toString(), 'ws://dsh.internal/sidebar/ws/terminal')
  assert.equal(resolveWebSocketUrl('file:///sidebar/ws/agent-terminals')?.pathname, '/sidebar/ws/agent-terminals')
})

test('resolveWebSocketUrl passes virtual-host and foreign URLs through', () => {
  assert.equal(resolveWebSocketUrl('ws://dsh.internal/sidebar/ws/terminal')?.toString(), 'ws://dsh.internal/sidebar/ws/terminal')
  assert.equal(resolveWebSocketUrl('wss://dsh.internal/x')?.hostname, 'dsh.internal')
  // Foreign endpoints and unresolvable inputs keep the native constructor.
  assert.equal(resolveWebSocketUrl('ws://example.com/socket'), undefined)
  assert.equal(resolveWebSocketUrl('https://example.com/socket'), undefined)
  assert.equal(resolveWebSocketUrl('not a url'), undefined)
})

test('DesktopWebSocket opens, delivers messages, and closes over the bridge', async () => {
  const fake = fakeBridge(async () => ({ type: 'ws-opened', socketId: 's1' }))
  const host = new DesktopWebSocketHost(fake.bridge)
  const opened: unknown[] = []
  const messages: unknown[] = []
  const closes: unknown[] = []
  const socket = new DesktopWebSocket(host, 'ws://dsh.internal/sidebar/ws/terminal')
  socket.onopen = (event) => opened.push(event)
  socket.onmessage = (event) => messages.push(event.data)
  socket.onclose = (event) => closes.push(event)
  assert.equal(socket.readyState, DesktopWebSocket.CONNECTING)
  await tick()
  assert.equal(socket.readyState, DesktopWebSocket.OPEN)
  assert.equal(opened.length, 1)

  fake.push({ type: 'ws-message', socketId: socket.socketId, data: 'hello', binary: false })
  await tick()
  assert.deepEqual(messages, ['hello'])

  fake.push({ type: 'ws-close', socketId: socket.socketId, code: 1011, reason: 'pty deps missing' })
  await tick()
  assert.equal(socket.readyState, DesktopWebSocket.CLOSED)
  assert.equal(closes.length, 1)
  const closeEvent = closes[0] as { code: number; reason: string }
  assert.equal(closeEvent.code, 1011)
  assert.equal(closeEvent.reason, 'pty deps missing')
})

test('DesktopWebSocket buffers messages pushed before the open reply lands', async () => {
  let resolveOpen: ((result: { type: 'ws-opened'; socketId: string }) => void) | undefined
  const fake = fakeBridge(() => new Promise((resolve) => { resolveOpen = resolve }))
  const host = new DesktopWebSocketHost(fake.bridge)
  const messages: unknown[] = []
  const socket = new DesktopWebSocket(host, 'ws://dsh.internal/sidebar/ws/x')
  socket.onmessage = (event) => messages.push(event.data)
  // The host's transcript replay arrives before the open reply (the main
  // writes during the upgrade handler, ahead of the invoke reply).
  fake.push({ type: 'ws-message', socketId: socket.socketId, data: 'transcript', binary: false })
  await tick()
  assert.equal(messages.length, 0, 'message buffered while connecting')
  resolveOpen?.({ type: 'ws-opened', socketId: socket.socketId })
  await tick()
  assert.deepEqual(messages, ['transcript'], 'buffered message flushed on open')
})

test('DesktopWebSocket reports a refused open as error then close(1006)', async () => {
  const fake = fakeBridge(async () => ({ type: 'ws-failed', message: 'no upgrade route' }))
  const host = new DesktopWebSocketHost(fake.bridge)
  const events: string[] = []
  const socket = new DesktopWebSocket(host, 'ws://dsh.internal/nope')
  socket.onerror = () => events.push('error')
  socket.onclose = (event) => events.push(`close:${event.code}`)
  await tick()
  assert.deepEqual(events, ['error', 'close:1006'])
  assert.equal(socket.readyState, DesktopWebSocket.CLOSED)
})

test('DesktopWebSocket.send delivers text and binary over the bridge', async () => {
  const fake = fakeBridge(async () => ({ type: 'ws-opened', socketId: 's1' }))
  const host = new DesktopWebSocketHost(fake.bridge)
  const socket = new DesktopWebSocket(host, 'ws://dsh.internal/x')
  await tick()
  assert.equal(socket.readyState, DesktopWebSocket.OPEN)

  socket.send('resize {"cols":80}')
  assert.deepEqual(fake.sent, [{ socketId: socket.socketId, data: 'resize {"cols":80}', binary: false }])

  socket.send(new Uint8Array([1, 2, 3]).buffer)
  assert.equal(fake.sent.length, 2)
  assert.equal(fake.sent[1].binary, true)
  const b64 = (fake.sent[1].data as unknown as { b64: string }).b64
  assert.deepEqual(Buffer.from(b64, 'base64'), Buffer.from([1, 2, 3]))
})

test('DesktopWebSocket.send throws while connecting and no-ops after close', async () => {
  const fake = fakeBridge(async () => ({ type: 'ws-opened', socketId: 's1' }))
  const host = new DesktopWebSocketHost(fake.bridge)
  const socket = new DesktopWebSocket(host, 'ws://dsh.internal/x')
  assert.throws(() => socket.send('early'), { name: 'InvalidStateError' })
  await tick()
  socket.close()
  assert.equal(socket.readyState, DesktopWebSocket.CLOSED)
  socket.send('late') // silent no-op, like the native socket
  assert.equal(fake.sent.length, 0)
})

test('DesktopWebSocket.close sends the close frame and fires onclose', async () => {
  const fake = fakeBridge(async () => ({ type: 'ws-opened', socketId: 's1' }))
  const host = new DesktopWebSocketHost(fake.bridge)
  const closes: unknown[] = []
  const socket = new DesktopWebSocket(host, 'ws://dsh.internal/x')
  socket.onclose = (event) => closes.push(event)
  await tick()
  socket.close(1000, 'bye')
  assert.deepEqual(fake.closed, [{ socketId: socket.socketId, code: 1000, reason: 'bye' }])
  await tick()
  assert.equal(socket.readyState, DesktopWebSocket.CLOSED)
  assert.equal((closes[0] as { code: number }).code, 1000)
  // A server close arriving after the client closed is ignored.
  fake.push({ type: 'ws-close', socketId: socket.socketId, code: 1006, reason: '' })
  await tick()
  assert.equal(closes.length, 1)
})

test('DesktopWebSocket.close while connecting aborts with code 1006', async () => {
  const fake = fakeBridge(async () => ({ type: 'ws-opened', socketId: 's1' }))
  const host = new DesktopWebSocketHost(fake.bridge)
  const closes: unknown[] = []
  const socket = new DesktopWebSocket(host, 'ws://dsh.internal/x')
  socket.onclose = (event) => closes.push(event)
  socket.close()
  await tick()
  assert.equal(socket.readyState, DesktopWebSocket.CLOSED)
  assert.equal((closes[0] as { code: number }).code, 1006)
  // The pending open reply is discarded once the socket is closed.
  await tick()
  assert.equal(closes.length, 1)
})

test('DesktopWebSocket validates close codes and reasons', async () => {
  const fake = fakeBridge(async () => ({ type: 'ws-opened', socketId: 's1' }))
  const host = new DesktopWebSocketHost(fake.bridge)
  const socket = new DesktopWebSocket(host, 'ws://dsh.internal/x')
  await tick()
  assert.throws(() => socket.close(999), { name: 'InvalidAccessError' })
  assert.throws(() => socket.close(1006), { name: 'InvalidAccessError' })
  assert.throws(() => socket.close(1000, 'x'.repeat(124)), { name: 'SyntaxError' })
  socket.close(1000, 'x'.repeat(123)) // 123 bytes is the limit
})

test('patchWebSocket routes desktop-host URLs to the shim and restores the original', async () => {
  const nativeCalls: unknown[] = []
  class FakeNativeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    constructor(url: string | URL, protocols?: string | string[]) {
      nativeCalls.push({ url: String(url), protocols })
    }
  }
  const original = globalThis.WebSocket
  globalThis.WebSocket = FakeNativeWebSocket as unknown as typeof WebSocket
  const fake = fakeBridge(async () => ({ type: 'ws-opened', socketId: 's1' }))
  const restore = patchWebSocket(fake.bridge)
  try {
    assert.notEqual(globalThis.WebSocket, FakeNativeWebSocket, 'WebSocket patched')
    // Desktop-host URLs produce the shim.
    const socket = new globalThis.WebSocket('file:///sidebar/ws/terminal')
    assert.ok(socket instanceof DesktopWebSocket)
    assert.equal(socket.url, 'ws://dsh.internal/sidebar/ws/terminal')
    assert.equal((globalThis.WebSocket as unknown as { OPEN: number }).OPEN, 1, 'static constants exposed')
    // Foreign URLs keep the captured constructor.
    const native = new globalThis.WebSocket('wss://example.com/socket', ['chat'])
    assert.ok(native instanceof FakeNativeWebSocket)
    assert.deepEqual(nativeCalls, [{ url: 'wss://example.com/socket', protocols: ['chat'] }])
  } finally {
    restore()
    globalThis.WebSocket = original
  }
  assert.equal(globalThis.WebSocket, original, 'WebSocket restored')
})

test('patchWebSocket rejects a non-constructor call like the native API', async () => {
  const original = globalThis.WebSocket
  const fake = fakeBridge(async () => ({ type: 'ws-opened', socketId: 's1' }))
  const restore = patchWebSocket(fake.bridge)
  try {
    assert.throws(() => { (globalThis.WebSocket as unknown as { call: (thisArg: unknown, ...args: unknown[]) => void }).call(null, 'file:///x') }, TypeError)
  } finally {
    restore()
    globalThis.WebSocket = original
  }
})
