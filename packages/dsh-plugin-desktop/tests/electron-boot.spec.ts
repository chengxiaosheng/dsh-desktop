/**
 * Headless test for the desktop boot helper and `file://` manifest assembly.
 *
 * Boots the desktop profile (virtual webserver + desktop connection) and
 * composes the renderer manifest without Electron or a window.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { bootDesktop, composeDesktopManifest, dispatchHttpRequest } from '../electron/boot-desktop.ts'
import { readCloseBehavior } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const HOME = join(REPO_ROOT, '.tmp-home', 'electron-boot')

process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })

let ctx: Context | undefined

test('desktop boot helper composes the file:// manifest', async () => {
  ctx = await bootDesktop(HOME)

  // The interceptor + desktop connection are mounted.
  const webServer = ctx.get('webServer')
  assert.ok(webServer !== undefined, 'virtual webserver mounted')
  assert.equal(webServer.virtual, true, 'virtual webserver mounted')
  assert.equal(webServer.hasSocket(), false, 'no listening socket')
  assert.ok(ctx.get('connection') !== undefined, 'connection (HostConnectionService) mounted')
  const modules = ctx.get('clientModules')
  assert.ok(modules !== undefined, 'clientModules mounted')

  // The manifest rewrites every bundle URL to an absolute file:// path.
  const { graph, distIndex } = composeDesktopManifest(ctx)
  assert.ok(graph.entries.length > 0, 'graph has entries')
  assert.ok(existsSync(distIndex), 'dist index exists')
  for (const entry of graph.entries) {
    assert.match(entry.url, /^file:\/\//, `entry ${entry.id} url is file://`)
    assert.ok(!entry.url.includes('/plugins/'), `entry ${entry.id} url no longer server-relative`)
  }
  const desktop = graph.entries.find((entry) => entry.id === 'dsh-plugin-desktop-connection')
  assert.ok(desktop !== undefined, 'desktop connection bundle in manifest')
  const shell = graph.entries.find((entry) => entry.id === 'dsh-plugin-desktop')
  assert.ok(shell !== undefined, 'desktop shell client bundle in manifest')
  const market = graph.entries.find((entry) => entry.id === 'dshmarket')
  assert.ok(market !== undefined, 'plugin market client bundle in manifest')

  // The desktop shell row registers the durable close-window namespace with
  // its schema default (close = quit, preserving the pre-tray behavior).
  const settings = ctx.get('settings')
  assert.ok(settings !== undefined, 'settings provider mounted')
  assert.deepEqual(
    settings.get(settingsNamespace('desktop')),
    { closeToTray: false },
    'desktop namespace resolves the schema default',
  )
  assert.deepEqual(readCloseBehavior(ctx), { closeToTray: false }, 'readCloseBehavior reads the default')

  // The desktop host services the plugin market reads are registered before
  // Loader entries mount: the active profile and the package manager.
  const profiles = ctx.get('desktopProfiles') as { current: { name: string; dir: string } } | undefined
  assert.ok(profiles !== undefined, 'desktopProfiles service present')
  assert.equal(profiles.current.name, 'desktop')
  assert.equal(profiles.current.dir, join(HOME, 'profiles', 'desktop'))
  const desktopPnpm = ctx.get('desktopPnpm') as { run?: unknown; runPlugin?: unknown } | undefined
  assert.ok(desktopPnpm !== undefined, 'desktopPnpm service present')
  assert.equal(typeof desktopPnpm.run, 'function', 'desktopPnpm.run provided')
  assert.equal(typeof desktopPnpm.runPlugin, 'function', 'desktopPnpm.runPlugin provided')
})

test('the desktop close-window preference persists and readCloseBehavior follows it', async () => {
  const settings = ctx!.get('settings')!
  await settings.update(settingsNamespace('desktop'), { closeToTray: true })
  assert.deepEqual(readCloseBehavior(ctx!), { closeToTray: true }, 'readCloseBehavior reads the stored preference')
  await settings.update(settingsNamespace('desktop'), { closeToTray: false })
  assert.deepEqual(readCloseBehavior(ctx!), { closeToTray: false }, 'readCloseBehavior reads the stored preference')
})

test('dispatchHttpRequest serves the session-log download surface in-process', async () => {
  // The host schema rejects a missing sessionId before any service check.
  const missing = await dispatchHttpRequest(ctx!, {
    type: 'http-request', method: 'HEAD', path: '/api/session.export', search: '',
  })
  assert.equal(missing.status, 400)
  assert.equal(Buffer.from(missing.bodyBase64, 'base64').toString(), 'missing or invalid sessionId query parameter')

  // An unknown session answers 404; HEAD carries no body, GET carries the text.
  const goneHead = await dispatchHttpRequest(ctx!, {
    type: 'http-request', method: 'HEAD', path: '/api/session.export', search: '?sessionId=no-such-session',
  })
  assert.equal(goneHead.status, 404)
  assert.equal(goneHead.bodyBase64, '')
  const goneGet = await dispatchHttpRequest(ctx!, {
    type: 'http-request', method: 'GET', path: '/api/session.export', search: '?sessionId=no-such-session',
  })
  assert.equal(goneGet.status, 404)
  assert.equal(Buffer.from(goneGet.bodyBase64, 'base64').toString(), 'session not found')
  assert.equal(goneGet.headers['content-type'], 'text/plain;charset=UTF-8')

  // Generic proxy: any plugin route dispatches through the webserver route
  // registry in-process — the market's exact routes — and unmatched GET/HEAD
  // hit the SPA fallback seat.
  const marketStatus = await dispatchHttpRequest(ctx!, { type: 'http-request', method: 'GET', path: '/dsh-market/status' })
  assert.equal(marketStatus.status, 200)
  assert.match(marketStatus.headers['content-type'] ?? '', /application\/json/)
  const statusBody = JSON.parse(Buffer.from(marketStatus.bodyBase64, 'base64').toString()) as { active?: unknown; restart?: unknown }
  assert.equal(typeof statusBody.active, 'boolean', 'market status dispatches through the route registry')
  assert.equal(statusBody.restart, false, 'the market runs in Desktop mode (the shell owns restart)')

  // A registered route honors its own method rejection.
  const wrongMarketMethod = await dispatchHttpRequest(ctx!, {
    type: 'http-request', method: 'POST', path: '/dsh-market/status', body: '{}', headers: { 'content-type': 'application/json' },
  })
  assert.equal(wrongMarketMethod.status, 405)

  // An exact route under `/api/*` (a plugin like dsh-usage-stats) beats the
  // connection's `/api` prefix fast path, exactly as the official server
  // resolves exact-over-prefix.
  const probe = await (ctx!.get('webServer') as { register(route: unknown): () => void }).register({
    kind: 'exact',
    path: '/api/probe-route',
    handler: (_req: unknown, res: { writeHead(s: number): void; end(b: string): void }) => {
      res.writeHead(200)
      res.end('probe-ok')
    },
  })
  try {
    const pluginApi = await dispatchHttpRequest(ctx!, { type: 'http-request', method: 'GET', path: '/api/probe-route' })
    assert.equal(pluginApi.status, 200)
    assert.equal(Buffer.from(pluginApi.bodyBase64, 'base64').toString(), 'probe-ok', 'exact /api route wins over the fast path')
  } finally {
    probe()
  }
  // A route-less `/api/*` path still falls to the composed apiProxy plane.
  const unknownApi = await dispatchHttpRequest(ctx!, { type: 'http-request', method: 'GET', path: '/api/no-such-route' })
  assert.equal(unknownApi.status, 404)

  // A generic connection channel (a plugin's `connection.rpc.handle('/chan',
  // …)` webServer prefix route) serves a POST envelope through the registry.
  // Its handler touches the connection `bridge` surface (`res.on('close')`,
  // `res.writableEnded`) that the synthesized response must carry.
  const channel = await (ctx!.get('webServer') as { register(route: unknown): () => void }).register({
    kind: 'prefix',
    path: '/chan',
    handler: (req: unknown, res: { on(e: string, fn: () => void): void; writableEnded: boolean; writeHead(s: number, h: Record<string, string>): void; end(b: string): void }) => {
      res.on('close', () => { /* the connection bridge registers a close listener */ })
      if (res.writableEnded) throw new Error('must not be ended before dispatch')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', result: { ok: true } }))
    },
  })
  try {
    const channelResponse = await dispatchHttpRequest(ctx!, {
      type: 'http-request', method: 'POST', path: '/chan/endpoint', search: '',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'endpoint', payload: {} }),
    })
    assert.equal(channelResponse.status, 200)
    const parsed = JSON.parse(Buffer.from(channelResponse.bodyBase64, 'base64').toString()) as { result?: { ok?: boolean } }
    assert.deepEqual(parsed.result, { ok: true }, 'generic channel dispatches through the registry')
  } finally {
    channel()
  }

  // Unmatched GET/HEAD serve the SPA index through the fallback seat.
  const spa = await dispatchHttpRequest(ctx!, { type: 'http-request', method: 'GET', path: '/not-api' })
  assert.equal(spa.status, 200)
  assert.match(spa.headers['content-type'] ?? '', /text\/html/)

  // A non-download method on the /api plane is refused by the controller
  // itself (415 — no JSON payload for the POST) rather than a bridge gate.
  const wrongMethod = await dispatchHttpRequest(ctx!, { type: 'http-request', method: 'POST', path: '/api/session.export' })
  assert.equal(wrongMethod.status, 415)
})

after(async () => {
  if (ctx !== undefined) await ctx.fiber.dispose()
  rmSync(HOME, { recursive: true, force: true })
})
