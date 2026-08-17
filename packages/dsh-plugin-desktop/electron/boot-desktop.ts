/**
 * Desktop boot helper, shared by the Electron main and the headless boot test.
 *
 * Boots the real published `web` profile (dsh-base + dsh-web-app) through
 * `@deepseek-ai/dsh-app-boot` with the desktop patch layer applied, then
 * composes the `file://` boot manifest. Importing this module does not require
 * Electron; the Electron main opens the window and installs the IPC bridge
 * around the returned context.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  initProfile,
  loadOverlayPatches,
  loadProfile,
  PROFILE_TEMPLATES,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { API_PATH } from '@deepseek-ai/dsh-client-connection'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Context } from '@deepseek-ai/cordis'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'

// The module lives at different depths per layout — electron/ in the source
// tree and the packaged host, lib/electron/ in the compiled workspace runtime —
// so the package root is the nearest ancestor carrying package.json, never a
// fixed relative hop.
/**
 * The package root this module runs from: the nearest ancestor directory
 * carrying `package.json` - `electron/` in the source tree, `lib/electron/`
 * in the compiled workspace runtime, `resources/host/electron/` in the
 * packaged app.
 * @returns absolute package-root directory.
 * @throws when no `package.json` exists above this module.
 */
export function resolvePackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`dsh-desktop: no package.json above ${import.meta.url}`)
    dir = parent
  }
}
const PKG_ROOT = resolvePackageRoot()
const INSTALL_ANCHOR = join(PKG_ROOT, 'package.json')
const DESKTOP_PATCH = join(PKG_ROOT, 'cordis.patch.yml')

/** Profile the desktop launcher composes. */
export const DESKTOP_PROFILE_NAME = 'desktop'

/**
 * Shipped agent-preset root: the `@deepseek-ai/dsh` package's own
 * `config/agent-presets` tree (the same roster the official `dsh` CLI ships).
 * Resolved from the install anchor's closure so the desktop launcher composes
 * the identical system-trust presets `dsh web` offers.
 */
const SHIPPED_PRESET_ROOT = (() => {
  const require = createRequire(INSTALL_ANCHOR)
  const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
  return join(dirname(dshManifest), 'config', 'agent-presets')
})()

/**
 * Compose the desktop patch stack: profile bundles, the desktop patch layer,
 * the profile's own layer, then the shipped agent-preset root overlay.
 *
 * The SHIPPED root is the part of the roster only the launcher can resolve: it
 * ships beside the `@deepseek-ai/dsh` package, so `composeProfile` in the
 * official CLI patches it in. A desktop composition that skips this patch
 * leaves the roster with only the writable user root and reports every preset
 * missing. The writable root itself stays `dsh-agent-presets`' own.
 * @param profile - the loaded desktop profile.
 * @param desktopPatches - the desktop overlay patch layer.
 * @param shippedPresetRoot - the system-trust preset root; defaults to the
 *   `@deepseek-ai/dsh` package's own `config/agent-presets` tree.
 * @returns the patch stack, in application order.
 */
export function composeDesktopPatches(profile: Profile, desktopPatches: PatchOptions[], shippedPresetRoot = SHIPPED_PRESET_ROOT): PatchOptions[] {
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const patches = [...bundlePatches, ...desktopPatches, ...profile.patches]
  const rows = new Map<string, PatchOptions>()
  for (const row of composeEntries([bundlePatches, desktopPatches, profile.patches])) {
    if (typeof row.id === 'string') rows.set(row.id, row as PatchOptions)
  }
  if (rows.has('agent-presets')) {
    patches.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config as object | undefined),
        roots: [{ path: shippedPresetRoot, trust: 'system' }],
      },
    })
  }
  return patches
}

/**
 * Boot the desktop profile over a (re)initialized Harness home.
 * @param home - the Harness home; defaults to the resolved home.
 * @returns the booted context with the desktop rows mounted.
 */
export async function bootDesktop(home = resolveDshHome()): Promise<Context> {
  const profileDir = join(home, 'profiles', DESKTOP_PROFILE_NAME)
  initProfile(profileDir, PROFILE_TEMPLATES.web)
  healProfilesModuleFallback(INSTALL_ANCHOR, home)
  const profile = loadProfile('dsh-desktop', DESKTOP_PROFILE_NAME, INSTALL_ANCHOR, home)
  const rootConfig = join(profileDir, 'cordis.yml')
  writeFileSync(rootConfig, '[]\n')
  const desktopPatches = loadOverlayPatches('dsh-desktop', DESKTOP_PATCH)
  const patches = composeDesktopPatches(profile, desktopPatches)
  const bareModuleBaseUrl = pathToFileURL(join(profileDir, 'package.json')).href
  return boot(
    'dsh-desktop',
    rootConfig,
    patches,
    async (host) => {
      provideCmdline(host, { args: ['--host', '127.0.0.1', '--port', '0'], exit: () => {} })
    },
    bareModuleBaseUrl,
  )
}

/**
 * Compose the `file://` boot manifest and the SPA index path for the renderer.
 *
 * The graph's server-relative bundle URLs (`/plugins/<id>/client.js?rev=…`)
 * are rewritten to absolute `file://` paths so the client module loader's
 * `<script src>` fetches work over `file://`. The SPA index is resolved from
 * the published `@deepseek-ai/dsh-web-frontend` dist.
 * @param ctx - the booted desktop context.
 * @returns the rewritten graph and the absolute dist index path.
 */
export function composeDesktopManifest(ctx: Context): { graph: WebBootGraph; distIndex: string } {
  const modules = ctx.get('clientModules')
  if (modules === undefined) throw new Error('dsh-desktop: clientModules missing from the booted tree')
  const graph = modules.graph()
  const entries = graph.entries.map((entry) => {
    const clientPath = modules.clientPath(entry.id)
    if (clientPath === undefined) {
      throw new Error(`dsh-desktop: no client bundle for graph entry ${entry.id}`)
    }
    return {
      ...entry,
      url: `${pathToFileURL(clientPath).href}?rev=${entry.rev}`,
    }
  })
  const distIndex = resolveDistIndex()
  return { graph: { rev: graph.rev, entries }, distIndex }
}

/** Resolve the published SPA dist index.html through the frontend package exports. */
function resolveDistIndex(): string {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('@deepseek-ai/dsh-web-frontend/package.json')
  const dist = join(dirname(entry), 'dist', 'index.html')
  return dist
}

/** A fetch-shaped handler (the connection node half's `FetchHandler` shape). */
export interface FetchHandler {
  fetch(request: Request): Promise<Response>
}

/**
 * The host `connection` runtime surface the desktop transport reads. The
 * published `HostConnectionHandle` type only declares the `rpc` registry; the
 * node half's `HostConnectionService` additionally exposes
 * `createSharedFetchHandler`. The `dispatch` leg serves generic (non-`/api`)
 * channels over IPC: the rc.6 runtime does not implement it, so reaching it
 * rejects the invoke — preserved from the JS original.
 */
export interface DesktopHostConnection {
  createSharedFetchHandler(channel: '/api', fallback: FetchHandler): FetchHandler
  dispatch(method: string, payload: unknown, signal: AbortSignal): Promise<RpcResult<unknown>>
}

/** One raw virtual-host HTTP request the renderer bridge sends. */
export interface HttpRequestMessage {
  type: 'http-request'
  method?: string
  path?: string
  search?: string
}

/** The raw host HTTP response envelope traveling back over the bridge. */
export interface HttpResponseEnvelope {
  status: number
  headers: Record<string, string>
  bodyBase64: string
}

/**
 * Dispatch one raw virtual-host HTTP request against the booted desktop host.
 *
 * The renderer's native host-origin requests (`http://dsh.internal`, the base
 * the official connection client falls back to on a null-origin `file://`
 * page) arrive here over the preload bridge as `{ type: 'http-request', method,
 * path, search }`. Only the no-envelope GET/HEAD download surface under `/api/`
 * is served — the host's `toFetchHandler` answers `/api/session.export` — and
 * the response travels back as `{ status, headers, bodyBase64 }`. Anything else
 * is refused so the bridge cannot reach beyond the composed `/api` plane.
 * @param ctx - booted desktop context.
 * @param request - the bridge request message.
 * @returns the response envelope.
 */
export async function dispatchHttpRequest(ctx: Context, request: HttpRequestMessage): Promise<HttpResponseEnvelope> {
  const connection = ctx.get('connection') as DesktopHostConnection | undefined
  const apiProxy = ctx.get('apiProxy')
  if (connection === undefined || apiProxy === undefined) {
    return { status: 503, headers: {}, bodyBase64: '' }
  }
  const method = typeof request?.method === 'string' ? request.method.toUpperCase() : 'GET'
  const path = typeof request?.path === 'string' ? request.path : ''
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: {}, bodyBase64: '' }
  }
  if (!path.startsWith('/api/')) {
    return { status: 404, headers: {}, bodyBase64: '' }
  }
  const search = typeof request?.search === 'string' && request.search !== '' ? request.search : ''
  const target = new URL(`${path}${search}`, 'http://dsh-desktop.invalid')
  const apiFetchHandler = connection.createSharedFetchHandler(API_PATH, {
    fetch: (req) => toFetchHandler(apiProxy).fetch(req),
  })
  const response = await apiFetchHandler.fetch(new Request(target, { method }))
  const headers = Object.fromEntries(response.headers.entries())
  const body = Buffer.from(await response.arrayBuffer())
  return { status: response.status, headers, bodyBase64: body.toString('base64') }
}
