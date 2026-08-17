/**
 * Client-half tests for the desktop IPC connection carrier.
 *
 * Runs in plain Node with a fake `window.dshDesktop` bridge (no jsdom): the
 * carrier only touches `Response`/`Request`/`URL`/`crypto`, all Node globals,
 * and the bridge contract. Covers unary/respond, both downlink streams, generic
 * RPC correlation, the `ctx.connection` handle, and the built bundle's
 * `__ModuleLoader__` registration.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { IpcApiClient, createDesktopConnectionRpc, type DshDesktopBridge, type DshDesktopFrame } from '../src/client/ipc-api-client.ts'
import { apply } from '../src/client/plugin.ts'
import type { HostDescription } from '../src/client/controller.ts'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

/** A fake preload bridge: invoke answers RPCs, subscribe collects listeners. */
function fakeBridge(handlers: { invoke?: (request: { path: string; body?: unknown }) => Promise<unknown> } = {}) {
  const listeners = new Map<string, (frame: DshDesktopFrame) => void>()
  const bridge: DshDesktopBridge & { listeners: Map<string, (frame: DshDesktopFrame) => void> } = {
    listeners,
    invoke: async (request) => {
      if (handlers.invoke !== undefined) return handlers.invoke(request)
      const body = request.body as { type?: string; rpcId?: string } | undefined
      if (body?.type === 'client-request') {
        return {
          type: 'server-response',
          rpcId: body.rpcId,
          result: { ok: true, value: { version: 'fake', cwd: '/', attachedSessions: 0, canOpenPath: false } },
        }
      }
      return { type: 'server-response', rpcId: 'x', result: { ok: false, error: { code: 'bad-request', message: 'unknown', details: {} } } }
    },
    subscribe: (channel, listener) => {
      listeners.set(channel, listener)
      return () => { listeners.delete(channel) }
    },
  }
  return bridge
}

test('IpcApiClient.doFetch maps a unary POST onto bridge.invoke and wraps the envelope', async () => {
  const bridge = fakeBridge({
    invoke: async (request) => {
      assert.equal(request.path, '/api/host.describe')
      const body = request.body as { type: string; rpcId: string }
      assert.equal(body.type, 'client-request')
      return { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { name: 'dsh' } } }
    },
  })
  const client = new IpcApiClient(bridge)
  const response = await client.doFetch(new URL('http://x/api/host.describe'), {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'abc', method: 'host.describe', payload: {} }),
  })
  assert.equal(response.status, 200)
  const envelope = await response.json()
  assert.equal(envelope.type, 'server-response')
  assert.equal(envelope.rpcId, 'abc')
})

test('openMux/openHost pump frames pushed through bridge.subscribe and close on stream/end', async () => {
  const bridge = fakeBridge()
  const client = new IpcApiClient(bridge)
  const signal = new AbortController()
  const frames: string[] = []
  const pump = (async () => {
    for await (const envelope of client.events.mux({}, signal.signal)) frames.push(envelope.payload.type)
  })()
  const listener = bridge.listeners.get('mux')
  assert.ok(listener !== undefined, 'mux subscribed')
  listener({ type: 'server-request', rpcId: 'r1', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 } })
  listener({ type: 'stream/end' })
  await pump
  assert.deepEqual(frames, ['session/subscribed'])
})

test('aborting the stream unsubscribes the bridge', async () => {
  const bridge = fakeBridge()
  const client = new IpcApiClient(bridge)
  const ac = new AbortController()
  const pump = (async () => {
    for await (const _ of client.events.host({}, ac.signal)) { /* drain */ }
  })()
  assert.ok(bridge.listeners.has('host'))
  ac.abort()
  await pump
  assert.ok(!bridge.listeners.has('host'), 'host unsubscribed after abort')
})

test('createDesktopConnectionRpc correlates rpcId and validates the envelope', async () => {
  const bridge = fakeBridge({
    invoke: async (request) => {
      const body = request.body as { rpcId: string }
      return {
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: 42 },
      }
    },
  })
  const rpc = createDesktopConnectionRpc(bridge)
  const result = await rpc.call('/generic', 'echo', { n: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.value, 42)
})

test('apply provides ctx.connection with the IPC carrier and the controller reaches connected', async () => {
  const bridge = fakeBridge()
  const originalFetch = globalThis.fetch
  globalThis.dshDesktop = bridge
  try {
    const ctx = new Context()
    apply(ctx)
    assert.notEqual(globalThis.fetch, originalFetch, 'virtual-host fetch bridge installed by apply')
    // The official node-half types declare `ctx.connection` as the host
    // `HostConnectionHandle`; on the client side the provided handle is the
    // `ConnectionHandle` shape, so the test reads it through that interface.
    const connection = ctx.connection as unknown as ConnectionHandle
    assert.ok(connection !== undefined, 'connection provided')
    assert.equal(connection.isLoopback, true, 'desktop caller is trusted')
    assert.equal(typeof (connection.api as IpcApiClient).doFetch, 'function', 'ipc carrier')
    assert.equal(typeof connection.rpc.call, 'function')

    const states: string[] = []
    let description: HostDescription | undefined
    let connectionHandle: { stop(): void } | undefined
    await new Promise<void>((resolve, reject) => {
      connectionHandle = connection.start({
        onStateChange: (state) => states.push(state),
        onConnected: (next) => { description = next },
      })
      // The controller handshake is async; poll for the connected state.
      const deadline = Date.now() + 2000
      const poll = (): void => {
        if (description !== undefined) return resolve()
        if (Date.now() > deadline) return reject(new Error('connection never reached connected'))
        setTimeout(poll, 10)
      }
      poll()
    })
    assert.ok(description !== undefined, 'connected description published')
    assert.equal(description.version, 'fake')
    assert.ok(states.includes('connected'))
    connectionHandle?.stop()
  } finally {
    globalThis.dshDesktop = undefined
    globalThis.fetch = originalFetch
  }
})

test('built bundle registers with __ModuleLoader__ and materializes the plugin', async () => {
  const registered: Array<{ id: string; factory: () => unknown }> = []
  globalThis.window = globalThis as typeof window
  globalThis.__ModuleLoader__ = { load: (handoff) => registered.push(handoff) }
  try {
    await import('../lib/client.js')
    assert.equal(registered.length, 1, 'one bundle registration')
    assert.equal(registered[0].id, 'dsh-plugin-desktop-connection')
    const exports = registered[0].factory() as { apply: unknown; inject: unknown }
    assert.equal(typeof exports.apply, 'function')
    assert.deepEqual(exports.inject, [])
  } finally {
    globalThis.__ModuleLoader__ = undefined
    ;(globalThis as { window?: unknown }).window = undefined
  }
})
