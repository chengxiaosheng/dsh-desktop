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

  // The bridge only serves the /api/ GET/HEAD download surface.
  const outside = await dispatchHttpRequest(ctx!, { type: 'http-request', method: 'GET', path: '/not-api' })
  assert.equal(outside.status, 404)
  const wrongMethod = await dispatchHttpRequest(ctx!, { type: 'http-request', method: 'POST', path: '/api/session.export' })
  assert.equal(wrongMethod.status, 405)
})

after(async () => {
  if (ctx !== undefined) await ctx.fiber.dispose()
  rmSync(HOME, { recursive: true, force: true })
})
