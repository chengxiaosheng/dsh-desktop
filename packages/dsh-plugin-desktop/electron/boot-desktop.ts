/**
 * Desktop boot helper, shared by the Electron main and the headless boot test.
 *
 * Boots the real published `web` profile (dsh-base + dsh-web-app) through
 * `@deepseek-ai/dsh-app-boot` with the desktop patch layer applied, then
 * composes the `file://` boot manifest. Importing this module does not require
 * Electron; the Electron main opens the window and installs the IPC bridge
 * around the returned context.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  initProfile,
  loadOverlayPatches,
  loadProfile,
  PROFILE_TEMPLATES,
  writeProfileManifest,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { API_PATH } from '@deepseek-ai/dsh-client-connection'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Context } from '@deepseek-ai/cordis'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import type { VirtualWebServer, WebRoute } from '../src/webserver.ts'
import { resolvePackageRoot } from './package-root.ts'
import { createDesktopServices } from './desktop-services.ts'
import { createProfileLoaderInternal, canResolveBare, type ProfileLoaderInternal } from './loader-internal.ts'

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

/** One inserted row's package name from a patch list (the `insert` blocks only). */
function insertedRowNames(patches: PatchOptions[]): string[] {
  const names: string[] = []
  for (const patch of patches) {
    const rows = (patch as { insert?: Array<{ name?: unknown }> }).insert
    if (Array.isArray(rows)) {
      for (const row of rows) if (typeof row.name === 'string' && row.name !== '') names.push(row.name)
    }
  }
  return names
}

/**
 * Boot recovery, phase 1 (before `loadProfile`): drop bundles whose own
 * package is not resolvable from the profile, persisting the removal in
 * `dsh.profile.bundles`. `loadProfile` resolves every listed bundle two-anchored
 * and fails loud on a package without a bundle declaration, so a bundle whose
 * package vanished from node_modules would otherwise abort the boot.
 * @param profileDir - the active profile directory.
 */
function recoverMissingBundlePackages(profileDir: string): void {
  const manifestPath = join(profileDir, 'package.json')
  let manifest: { dsh?: { profile?: { bundles?: string[] } } }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
  } catch {
    return
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const profileUrl = pathToFileURL(manifestPath).href
  const removed = bundles.filter(bundle => !canResolveBare(profileUrl, bundle))
  if (removed.length === 0) return
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: bundles.filter(bundle => !removed.includes(bundle)) },
  }
  writeProfileManifest(profileDir, manifest)
  for (const bundle of removed) console.warn(`dsh-desktop: boot recovery removed missing bundle ${bundle} (package not installed)`)
}

/**
 * Boot recovery, phase 2 (after `loadProfile`): drop bundle layers that insert
 * rows referencing a package not resolvable from the profile, persisting the
 * removal. A bundle patch that references an unpublished/missing package (e.g.
 * dsh-web-search-pro's `@anweat/dsh-browser` row) would otherwise make the
 * loader hard-fail the whole tree and the app never open.
 * @param profile - the loaded profile; its `layers` are pruned in place.
 */
function recoverMissingBundleRows(profile: Profile): void {
  const profileUrl = pathToFileURL(join(profile.dir, 'package.json')).href
  const broken = new Map<string, string[]>() // bundle → unresolvable row specifiers
  for (const layer of profile.layers) {
    const missing = insertedRowNames(layer.patches).filter(name => !canResolveBare(profileUrl, name))
    if (missing.length > 0) broken.set(layer.packageName, missing)
  }
  if (broken.size === 0) return
  const removed = [...broken.keys()]
  profile.layers = profile.layers.filter(layer => !removed.includes(layer.packageName))
  const manifestPath = join(profile.dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const next = bundles.filter(bundle => !removed.includes(bundle))
  if (next.length !== bundles.length) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } }
    writeProfileManifest(profile.dir, manifest)
  }
  for (const [bundle, missing] of broken) {
    console.warn(`dsh-desktop: boot recovery removed unloadable bundle ${bundle} (missing: ${missing.join(', ')}) — install the missing package to re-enable it`)
  }
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
  // Boot recovery: drop profile bundles that cannot load, so one broken
  // install (a missing bundle package, or a bundle patch referencing a package
  // that is not installed) never hard-fails the whole tree and keeps the app
  // from opening. The package stays in dependencies/node_modules; the user can
  // uninstall it from the market now that the app boots.
  recoverMissingBundlePackages(profileDir)
  const profile = loadProfile('dsh-desktop', DESKTOP_PROFILE_NAME, INSTALL_ANCHOR, home)
  recoverMissingBundleRows(profile)
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
      // Desktop host services, registered before Loader entries mount: the
      // plugin market reads them to target the active profile and to run
      // package operations through the `dsh` CLI.
      const { desktopProfiles, desktopPnpm } = createDesktopServices(profileDir, DESKTOP_PROFILE_NAME)
      host.provide('desktopProfiles', desktopProfiles)
      host.provide('desktopPnpm', desktopPnpm)
      // Anchor bare plugin resolution to the profile. The loader's native
      // internal module loader (backed by node-addon-require-builtin) is
      // unavailable under Electron, so without this hook a plugin installed
      // into the profile's node_modules cannot be resolved at the next boot.
      // Bare names prefer the installation closure (installAnchorUrl) so
      // in-box singleton services stay on the app's module instance; the
      // profile remains the fallback for user-installed packages.
      const loader = host.get('loader') as { internal?: unknown } | undefined
      if (loader !== undefined) {
        loader.internal = createProfileLoaderInternal(
          bareModuleBaseUrl,
          pathToFileURL(INSTALL_ANCHOR).href,
          loader.internal as ProfileLoaderInternal | undefined,
        )
      }
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
 * `createSharedFetchHandler` (the `/api` shared fetch seam). Generic
 * (non-`/api`) connection channels are not dispatched here: the host registers
 * each channel as a webServer prefix route, and the renderer's generic-channel
 * RPC reaches it through the full-route dispatch.
 */
export interface DesktopHostConnection {
  createSharedFetchHandler(channel: '/api', fallback: FetchHandler): FetchHandler
}

/** The virtual-host identity the desktop transport reports to renderer code. */
const VIRTUAL_HOST = 'dsh.internal'

/**
 * The loopback host the synthesized Origin/Host headers carry. The official
 * server serves on a loopback address, so plugin trust fences that demand a
 * loopback Host (dsh-usage-stats) pass with this identity.
 */
const LOOPBACK_HOST = '127.0.0.1'

/** One raw virtual-host HTTP request the renderer bridge sends. */
export interface HttpRequestMessage {
  type: 'http-request'
  method?: string
  path?: string
  search?: string
  /** Request headers observed at the patched fetch, plus synthesized host headers. */
  headers?: Record<string, string>
  /** Raw UTF-8 request body (POST payloads), when one was supplied. */
  body?: string
}

/** The raw host HTTP response envelope traveling back over the bridge. */
export interface HttpResponseEnvelope {
  status: number
  headers: Record<string, string>
  bodyBase64: string
}

/**
 * Synthesized `IncomingMessage` for an in-process webServer route handler.
 *
 * The registry mounts Node-http-shaped handlers (`(request, response)`), so
 * the desktop builds a minimal stand-in: method, url, headers, the loopback
 * peer address (loopback trust checks pass), and an async iterator yielding
 * the request body so `readJsonBody`-style consumers work unchanged. Only the
 * `file://`/virtual-host plane reaches here — the caller already refused
 * everything else.
 */
class VirtualRequest {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly socket = { remoteAddress: '127.0.0.1' }
  private readonly body: Buffer

  constructor(method: string, url: string, headers: Record<string, string> | undefined, body: string | undefined) {
    this.method = method
    this.url = url
    this.headers = synthesizeHostHeaders(headers)
    this.body = Buffer.from(body ?? '', 'utf8')
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    const { body } = this
    let done = false
    return {
      next: async (): Promise<IteratorResult<Buffer>> => {
        if (done || body.length === 0) return { value: undefined as never, done: true }
        done = true
        return { value: body, done: false }
      },
    }
  }

  /** In-process stand-in for the socket teardown a real request would own. */
  destroy(): void {
    // Nothing to tear down — the request was fully buffered over the bridge.
  }
}

/**
 * Fill the host headers a same-origin check needs. The renderer's patched
 * fetch runs on a `file://` page where the browser never supplies `Origin`/
 * `Host`; the desktop is the sole trusted peer (its own renderer over IPC, no
 * network), so a loopback identity is synthesized when the caller supplied
 * neither. A loopback host (not the virtual-host name) is required: plugin
 * fences like dsh-usage-stats' `rejectForeignCaller` demand a loopback Host,
 * mirroring the official server's `127.0.0.1:<port>` requests.
 */
function synthesizeHostHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = { ...headers }
  if (out.origin === undefined) out.origin = `http://${LOOPBACK_HOST}`
  if (out.host === undefined) out.host = LOOPBACK_HOST
  return out
}

/**
 * Synthesized `ServerResponse` capturing a route handler's writes for the
 * bridge envelope. Extends `EventEmitter` and carries the writable-surface
 * members the connection's `bridge` helper touches (`on`/`once` listeners,
 * `writableEnded`, `destroy`); `write`/`end` chunks and the status line and
 * headers are buffered, and `envelope()` produces the wire response. Handlers
 * that hold a response open (SSE) are outside this surface — the bridge is
 * request/response.
 */
class VirtualResponse extends EventEmitter {
  statusCode = 200
  statusMessage = ''
  private readonly headerMap = new Map<string, string>()
  private readonly chunks: Buffer[] = []
  private ended = false

  get headersSent(): boolean {
    return this.ended
  }

  /** Whether the response has been ended (the `writableEnded` stream flag). */
  get writableEnded(): boolean {
    return this.ended
  }

  writeHead(
    status: number,
    statusMessageOrHeaders?: string | Record<string, string> | Array<[string, string]>,
    headers?: Record<string, string> | Array<[string, string]>,
  ): this {
    this.statusCode = status
    if (typeof statusMessageOrHeaders === 'string') {
      this.statusMessage = statusMessageOrHeaders
      statusMessageOrHeaders = headers
    }
    if (statusMessageOrHeaders !== undefined) {
      if (Array.isArray(statusMessageOrHeaders)) {
        for (const [name, value] of statusMessageOrHeaders) this.setHeader(name, value)
      } else {
        for (const [name, value] of Object.entries(statusMessageOrHeaders)) this.setHeader(name, value)
      }
    }
    return this
  }

  setHeader(name: string, value: string | string[] | number): void {
    this.headerMap.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value))
  }

  getHeader(name: string): string | undefined {
    return this.headerMap.get(name.toLowerCase())
  }

  removeHeader(name: string): void {
    this.headerMap.delete(name.toLowerCase())
  }

  write(chunk: string | Buffer | Uint8Array): boolean {
    if (this.ended) throw new Error('write after end')
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return true
  }

  end(chunk?: string | Buffer | Uint8Array): void {
    if (chunk !== undefined) this.write(chunk)
    this.finish()
  }

  /** Teardown equivalent; a route handler's `res.destroy()` aborts mid-response. */
  destroy(error?: Error): void {
    if (error !== undefined) this.emit('error', error)
    this.finish()
  }

  private finish(): void {
    if (this.ended) return
    this.ended = true
    this.emit('finish')
    this.emit('close')
  }

  /** The bridge envelope for the captured response. */
  envelope(): HttpResponseEnvelope {
    return {
      status: this.statusCode,
      headers: Object.fromEntries(this.headerMap),
      bodyBase64: Buffer.concat(this.chunks).toString('base64'),
    }
  }
}

/**
 * Dispatch one raw virtual-host HTTP request against the booted desktop host.
 *
 * The renderer's patched fetch sends every same-origin `file://` and
 * `http://dsh.internal` request over the preload bridge as `{ type:
 * 'http-request', method, path, search, headers, body }`. The main dispatches
 * through the full webserver route registry (`webServer.match` exact →
 * prefix), the socketless analog of the official HTTP server — so ANY plugin
 * route works in-process with no per-plugin bridge. A plugin's exact route
 * under `/api/*` (e.g. dsh-usage-stats) beats the connection's `/api` prefix
 * route exactly as the official server resolves it. Only when the match IS
 * the connection's own `/api` prefix route (or nothing matched a `/api/*`
 * path) does the proven fast path serve the plane through `toFetchHandler`;
 * unmatched non-`/api` paths fall to the fallback seat (the SPA index).
 * @param ctx - booted desktop context.
 * @param request - the bridge request message.
 * @returns the response envelope.
 */
export async function dispatchHttpRequest(ctx: Context, request: HttpRequestMessage): Promise<HttpResponseEnvelope> {
  const method = typeof request?.method === 'string' ? request.method.toUpperCase() : 'GET'
  const path = typeof request?.path === 'string' ? request.path : ''
  const search = typeof request?.search === 'string' && request.search !== '' ? request.search : ''
  const target = new URL(`${path}${search}`, `http://${VIRTUAL_HOST}`)

  const webServer = ctx.get('webServer') as VirtualWebServer | undefined
  const route = webServer?.match(target.pathname)

  // A route that is not the connection's own `/api` prefix wins outright:
  // exact matches beat the prefix (a plugin's `/api/usage-stats/*` route), and
  // every non-`/api` route dispatches here too.
  const connectionApiPrefix = route?.kind === 'prefix' && route.path === API_PATH
  if (route !== undefined && !connectionApiPrefix) {
    return dispatchWebRoute(ctx, route.handler, target, method, `${path}${search}`, request)
  }

  // The composed `/api` plane keeps its proven fast path (unary RPC + the
  // session-log download surface) — the same surface the connection's `/api`
  // prefix route serves, preserved without the registry's req/res stand-ins.
  if (target.pathname.startsWith(`${API_PATH}/`)) {
    const connection = ctx.get('connection') as DesktopHostConnection | undefined
    const apiProxy = ctx.get('apiProxy')
    if (connection === undefined || apiProxy === undefined) {
      return { status: 503, headers: {}, bodyBase64: '' }
    }
    const apiFetchHandler = connection.createSharedFetchHandler(API_PATH, {
      fetch: (req) => toFetchHandler(apiProxy).fetch(req),
    })
    const response = await apiFetchHandler.fetch(new Request(target, { method }))
    const headers = Object.fromEntries(response.headers.entries())
    const body = Buffer.from(await response.arrayBuffer())
    return { status: response.status, headers, bodyBase64: body.toString('base64') }
  }

  // Unmatched non-`/api` paths fall to the fallback seat (the SPA index).
  if (webServer?.fallback === undefined) {
    return { status: 404, headers: {}, bodyBase64: '' }
  }
  return dispatchWebRoute(ctx, webServer.fallback, target, method, `${path}${search}`, request)
}

/**
 * Invoke one webserver route handler in-process with synthesized request and
 * response stand-ins.
 * @param ctx - booted desktop context (for error logging).
 * @param handler - the route or fallback handler.
 * @param target - the parsed request URL.
 * @param method - the request method.
 * @param url - the full path + search, as a handler reads it from `request.url`.
 * @param request - the bridge request message (headers + body).
 * @returns the response envelope.
 */
async function dispatchWebRoute(
  ctx: Context,
  handler: WebRoute['handler'],
  target: URL,
  method: string,
  url: string,
  request: HttpRequestMessage,
): Promise<HttpResponseEnvelope> {
  // The registry types handlers against Node's http types; the desktop
  // dispatches with structural stand-ins that carry the same surface.
  const routeHandler = handler as unknown as (req: VirtualRequest, res: VirtualResponse) => void | Promise<void>
  const res = new VirtualResponse()
  const req = new VirtualRequest(method, url, request.headers, request.body)
  try {
    await routeHandler(req, res)
  } catch (error) {
    console.warn(`dsh-desktop: webServer route ${target.pathname} failed: ${error instanceof Error ? error.message : String(error)}`)
    return { status: 500, headers: {}, bodyBase64: '' }
  }
  return res.envelope()
}
