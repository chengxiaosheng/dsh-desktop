/**
 * Headless boot proof for the virtual-webserver interceptor + IPC renderer
 * connection.
 *
 * Boots the real published `web` profile (dsh-base + dsh-web-app) through
 * `@deepseek-ai/dsh-app-boot` with the desktop patch layer applied, then
 * asserts:
 *   1. `webServer` is the socketless virtual provider (interceptor).
 *   2. The `connection` node half mounted against it — now the desktop
 *      replacement (`dsh-plugin-desktop-connection`) re-exporting the official
 *      apply, so `HostConnectionService` behaves unchanged.
 *   3. The official `modules` node half mounted unchanged against it.
 *   4. An in-process `/api` dispatch (no socket) returns a real host RPC result.
 *   5. The client graph emits the desktop connection carrier bundle exactly once.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  boot,
  healProfilesModuleFallback,
  initProfile,
  loadOverlayPatches,
  loadProfile,
  PROFILE_TEMPLATES,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { API_PATH } from '@deepseek-ai/dsh-client-connection'
import { composeDesktopPatches } from '../electron/boot-desktop.js'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url))
const INSTALL_ANCHOR = join(PKG_ROOT, 'package.json')
const DESKTOP_PATCH = join(PKG_ROOT, 'cordis.patch.yml')
const HOME = join(REPO_ROOT, '.tmp-home', 'boot')
const PROFILE_NAME = 'desktop'
const BIN_NAME = 'dsh-desktop-smoke'
const DESKTOP_CONNECTION = 'dsh-plugin-desktop-connection'

process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })

let ctx

test('virtual webserver interceptor + desktop connection: connection/modules mount and /api dispatches in-process', async () => {
  const profileDir = join(HOME, 'profiles', PROFILE_NAME)
  initProfile(profileDir, PROFILE_TEMPLATES.web)
  healProfilesModuleFallback(INSTALL_ANCHOR, HOME)
  const profile = loadProfile(BIN_NAME, PROFILE_NAME, INSTALL_ANCHOR, HOME)
  const rootConfig = join(profileDir, 'cordis.yml')
  writeFileSync(rootConfig, '[]\n')

  const desktopPatches = loadOverlayPatches(BIN_NAME, DESKTOP_PATCH)
  const patches = composeDesktopPatches(profile, desktopPatches)

  const bareModuleBaseUrl = pathToFileURL(join(profileDir, 'package.json')).href
  ctx = await boot(
    BIN_NAME,
    rootConfig,
    patches,
    async (host) => {
      provideCmdline(host, {
        args: ['--host', '127.0.0.1', '--port', '0'],
        exit: () => {},
      })
    },
    bareModuleBaseUrl,
  )

  // 1. The interceptor replaced the official socket webserver.
  const webServer = ctx.get('webServer')
  assert.ok(webServer !== undefined, 'webServer service present')
  assert.equal(webServer.virtual, true, 'webServer is the virtual provider')
  assert.equal(webServer.hasSocket(), false, 'no listening socket')
  assert.equal(webServer.host, '127.0.0.1', 'reports loopback host for web-runtime trust')

  // 2. The connection node half mounted against it — the desktop replacement
  //    (`dsh-plugin-desktop-connection`) re-exporting the official apply.
  const connection = ctx.get('connection')
  assert.ok(connection !== undefined, 'connection (HostConnectionService) present')
  assert.equal(typeof connection.createSharedFetchHandler, 'function', 'shared /api seam available')
  assert.ok(webServer.prefixes.has(API_PATH), '/api prefix route registered by connection')
  assert.ok(webServer.upgrades.size >= 2, 'two downlink upgrade routes registered by connection')

  // 2b. The connection loader entry is the desktop package, not the official one.
  const connectionEntry = [...ctx.loader.entries()].find((entry) => entry.options.name === DESKTOP_CONNECTION)
  assert.ok(connectionEntry !== undefined, 'connection row present')
  assert.equal(connectionEntry.options.name, DESKTOP_CONNECTION, 'connection row replaced by the desktop package')

  // 3. The official modules node half mounted unchanged against it.
  const modules = ctx.get('clientModules')
  assert.ok(modules !== undefined, 'clientModules present')
  assert.ok(webServer.prefixes.has('/plugins'), '/plugins bundle route registered by modules')
  assert.ok(webServer.indexTaps.length >= 2, 'boot-manifest + theme index taps registered')

  // 5. The client graph emits the desktop connection carrier bundle exactly once.
  const graph = modules.graph()
  const desktopEntries = graph.entries.filter((entry) => entry.id === DESKTOP_CONNECTION)
  assert.equal(desktopEntries.length, 1, 'desktop connection bundle emitted exactly once')
  assert.match(desktopEntries[0].url, new RegExp(`^/plugins/${DESKTOP_CONNECTION}/client\\.js\\?rev=`))

  // 4b. The shipped agent-preset root reached the roster: the desktop launcher
  //     must offer the same system presets `dsh web` does, or every session
  //     start (model selection) fails with `preset "cordis" not found`.
  const agentPresets = ctx.get('agentPresets')
  assert.ok(agentPresets !== undefined, 'agentPresets service present')
  assert.ok(
    agentPresets.resolvedRoots.some(root => root.trust === 'system'),
    'a system-trust preset root is configured',
  )
  const roster = await agentPresets.list()
  const rosterIds = roster.map(preset => preset.id)
  for (const id of ['standard', 'code', 'minimal', 'cordis']) {
    assert.ok(rosterIds.includes(id), `shipped preset ${id} present`)
  }

  // 4. In-process /api dispatch returns a real host RPC result (no socket).
  const apiProxy = ctx.get('apiProxy')
  assert.ok(apiProxy !== undefined, 'apiProxy present')
  const handler = connection.createSharedFetchHandler(API_PATH, {
    fetch: (request) => toFetchHandler(apiProxy).fetch(request),
  })
  const response = await handler.fetch(new Request('http://dsh-desktop.invalid/api/host.describe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'desktop-smoke-1',
      method: 'host.describe',
      payload: {},
    }),
  }))
  assert.equal(response.status, 200, 'in-process /api response status')
  const envelope = await response.json()
  assert.equal(envelope.type, 'server-response', 'server-response envelope')
  assert.equal(envelope.rpcId, 'desktop-smoke-1', 'rpcId echoed')
  assert.ok(envelope.result.ok, 'host.describe succeeded in-process')
})

after(async () => {
  if (ctx !== undefined) await ctx.fiber.dispose()
  rmSync(HOME, { recursive: true, force: true })
})
