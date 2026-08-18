/**
 * Headless tests for the host-side virtual-host transport (`host-bridge.ts`).
 *
 * Boots the real desktop profile (`bootDesktop`, which installs the bridge in
 * its prepare hook — the exact production path) and verifies the general
 * compatibility surface: the reported virtual port, the virtual-host URL match
 * rule, host-side `fetch` to the virtual host dispatching the full `/api` RPC
 * envelope in-process (dsh-im's transport), non-matching URLs passing through
 * to the real fetch, and a host-side `WebSocket` to a registered upgrade route
 * served by the in-process shim. The bridge keys on the virtual-host identity
 * alone, so the tests exercise it through a plugin-shaped client, never through
 * dsh-im-specific code.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { bootDesktop, dispatchHttpRequest } from '../electron/boot-desktop.ts'
import { matchesVirtualHost } from '../electron/host-bridge.ts'
import { VIRTUAL_HOST_PORT, type VirtualWebServer } from '../src/webserver.ts'
import type { Context } from '@deepseek-ai/cordis'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const HOME = join(REPO_ROOT, '.tmp-home', 'host-bridge')

process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })

// The originals the bridge patches away; the after hook asserts restoration.
const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket

let ctx: Context | undefined

/** Wait until `probe` is truthy, polling every 5 ms up to 1 s. */
async function waitFor(probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A plugin-style upgrade route over a noServer ws server (no TCP socket). */
function mountUpgradeRoute(webServer: VirtualWebServer): {
  wss: WebSocketServer
  attached: WsWebSocket[]
  received: string[]
} {
  const wss = new WebSocketServer({ noServer: true })
  const attached: WsWebSocket[] = []
  const received: string[] = []
  webServer.registerUpgrade({
    path: '/host-bridge/ws',
    handler: (req, socket, head) => {
      wss.handleUpgrade(
        req as unknown as IncomingMessage,
        socket as unknown as Duplex,
        head as Buffer,
        (ws) => {
          attached.push(ws)
          ws.on('message', (data) => received.push(data.toString('utf8')))
          ws.send('server-hello')
        },
      )
    },
  })
  return { wss, attached, received }
}

test('host-side virtual-host transport serves the harness to host-side clients', async () => {
  ctx = await bootDesktop(HOME)
  const webServer = ctx.get('webServer') as VirtualWebServer
  assert.ok(webServer !== undefined, 'virtual webserver mounted')
  assert.equal(webServer.port, VIRTUAL_HOST_PORT, 'config port 0 reports the stable virtual port')

  // The bridge patched the process globals.
  assert.notEqual(globalThis.fetch, originalFetch, 'fetch patched for the host side')
  assert.notEqual(globalThis.WebSocket, originalWebSocket, 'WebSocket patched for the host side')

  // The virtual-host match rule: the reported port and the dsh.internal name
  // match; other hosts, schemes, and ports pass through.
  const base = `http://127.0.0.1:${VIRTUAL_HOST_PORT}`
  assert.equal(matchesVirtualHost(ctx, `${base}/api/host.describe`), true, 'loopback on the virtual port matches')
  assert.equal(matchesVirtualHost(ctx, `ws://127.0.0.1:${VIRTUAL_HOST_PORT}/api/events.mux`), true, 'ws loopback on the virtual port matches')
  assert.equal(matchesVirtualHost(ctx, 'http://dsh.internal/api/host.describe'), true, 'the dsh.internal name matches')
  assert.equal(matchesVirtualHost(ctx, `http://127.0.0.1:${VIRTUAL_HOST_PORT + 1}/`), false, 'a foreign loopback port does not match')
  assert.equal(matchesVirtualHost(ctx, 'http://example.com/'), false, 'a foreign host does not match')
  assert.equal(matchesVirtualHost(ctx, 'not-a-url'), false, 'an unparseable url does not match')

  // Host-side fetch to the virtual host dispatches the full /api RPC envelope
  // in-process — dsh-im's HarnessClient transport, unmodified.
  const envelope = JSON.stringify({ type: 'client-request', rpcId: 'host-bridge-1', method: 'host.describe', payload: {} })
  const response = await fetch(`${base}/api/host.describe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: envelope,
  })
  assert.equal(response.status, 200, 'host-side /api RPC answered in-process')
  const parsed = await response.json() as { type: string; rpcId: string; result: { ok: boolean } }
  assert.equal(parsed.type, 'server-response', 'server-response envelope')
  assert.equal(parsed.rpcId, 'host-bridge-1', 'rpcId echoed')
  assert.equal(parsed.result.ok, true, 'host.describe succeeded through the host-side bridge')

  // The same envelope through dispatchHttpRequest directly (the raw bridge
  // path) now forwards the body too.
  const direct = await dispatchHttpRequest(ctx, {
    type: 'http-request', method: 'POST', path: '/api/host.describe', search: '',
    headers: { 'content-type': 'application/json' }, body: envelope,
  })
  assert.equal(direct.status, 200, 'raw dispatchHttpRequest forwards the /api envelope body')

  // A non-matching URL passes through to the real fetch: a loopback port that
  // is not the virtual port cannot be served in-process, so the real fetch
  // rejects with a network error instead of returning the SPA index.
  await assert.rejects(
    fetch(`http://127.0.0.1:${VIRTUAL_HOST_PORT + 1}/`),
    (error: unknown) => error instanceof TypeError,
    'a foreign port reaches the real fetch, not the in-process dispatch',
  )
})

test('a host-side WebSocket to the virtual host is served by the in-process upgrade route', async () => {
  const webServer = ctx!.get('webServer') as VirtualWebServer
  const { wss, attached, received } = mountUpgradeRoute(webServer)
  const socket = new WebSocket(`ws://127.0.0.1:${VIRTUAL_HOST_PORT}/host-bridge/ws`)
  const messages: string[] = []
  const closed: Array<{ code: number; reason: string }> = []
  socket.addEventListener('message', (event) => messages.push((event as { data: string }).data))
  socket.addEventListener('close', (event) => closed.push({ code: (event as { code: number }).code, reason: (event as { reason: string }).reason }))
  try {
    await waitFor(() => messages.includes('server-hello'))
    await waitFor(() => socket.readyState === 1) // OPEN: the upgrade completed
    assert.ok(messages.includes('server-hello'), 'the server frame reached the host-side shim')

    // Client → server reaches the route's ws message handler.
    socket.send('ls -la')
    await waitFor(() => received.includes('ls -la'))
    assert.ok(received.includes('ls -la'), 'host-side send reached the upgrade route')

    // A server-initiated close relays the real code/reason promptly.
    attached[0]?.close(1011, 'done')
    await waitFor(() => closed.length > 0)
    assert.deepEqual(closed[0], { code: 1011, reason: 'done' })
  } finally {
    wss.close()
    socket.close()
  }
})

after(async () => {
  if (ctx !== undefined) await ctx.fiber.dispose()
  assert.equal(globalThis.fetch, originalFetch, 'fetch restored after fiber dispose')
  assert.equal(globalThis.WebSocket, originalWebSocket, 'WebSocket restored after fiber dispose')
  rmSync(HOME, { recursive: true, force: true })
})
