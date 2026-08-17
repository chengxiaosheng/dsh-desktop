/**
 * Boot the unpacked packaged app headlessly and assert the socketless host,
 * the desktop connection mount, and the composed file:// manifest.
 *
 * Runs against the electron-builder `dist/` output for the current platform
 * (linux-unpacked, win-unpacked, or a mac .app bundle) without Electron, a
 * browser, or a listening socket — the packaged counterpart of the headless
 * boot proof. Exits non-zero when the packaged app does not boot.
 */

import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(dirname(dirname(fileURLToPath(import.meta.url))))
const distDir = join(packageRoot, 'dist')

/** Locate the electron-builder unpacked app root for the current platform. */
function findUnpackedRoot(): string {
  const entries = readdirSync(distDir, { withFileTypes: true })
  const unpacked = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('-unpacked'))
  if (unpacked !== undefined) return join(distDir, unpacked.name)
  const macBundle = entries.find((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
  if (macBundle !== undefined) return join(distDir, macBundle.name)
  throw new Error('verify-packaged-boot: no unpacked app directory found under dist/')
}

/** Resolve the packaged host runtime dir `resources/host` (descends into a mac .app bundle). */
function findHostDir(appRoot: string): string {
  const appBundle = readdirSync(appRoot, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
  const resourcesBase = appBundle !== undefined
    ? join(appRoot, appBundle.name, 'Contents', 'Resources')
    : join(appRoot, 'resources')
  const host = join(resourcesBase, 'host')
  if (!existsSync(join(host, 'electron', 'boot-desktop.js'))) {
    throw new Error(`verify-packaged-boot: packaged host runtime missing under ${host}`)
  }
  return host
}

/** The packaged boot module's headless-testable surface. */
interface PackagedBootModule {
  bootDesktop(home: string): Promise<{
    get(name: string): unknown
    fiber: { dispose(): Promise<void> }
  }>
  composeDesktopManifest(ctx: unknown): {
    graph: { entries: Array<{ id: string; url: string }> }
    distIndex: string
  }
}

const hostDir = findHostDir(findUnpackedRoot())
const bootModule = join(hostDir, 'electron', 'boot-desktop.js')
if (!existsSync(bootModule)) {
  throw new Error(`verify-packaged-boot: packaged boot module missing at ${bootModule}`)
}

const home = mkdtempSync(join(tmpdir(), 'dsh-packaged-verify-'))
process.env.DSH_HOME = home

const moduleUrl = pathToFileURL(bootModule).href
const boot = await import(moduleUrl) as PackagedBootModule
let ctx: { get(name: string): unknown; fiber: { dispose(): Promise<void> } } | undefined
try {
  ctx = await boot.bootDesktop(home)
  const webServer = ctx.get('webServer') as { virtual?: boolean; hasSocket?: () => boolean } | undefined
  if (webServer === undefined || webServer.virtual !== true || webServer.hasSocket?.() !== false) {
    throw new Error('verify-packaged-boot: socketless virtual webserver not mounted in the packaged app')
  }
  if (ctx.get('connection') === undefined) {
    throw new Error('verify-packaged-boot: connection service not mounted in the packaged app')
  }
  const { graph, distIndex } = boot.composeDesktopManifest(ctx)
  if (!existsSync(distIndex)) throw new Error(`verify-packaged-boot: packaged dist index missing at ${distIndex}`)
  const connectionEntry = graph.entries.find((entry) => entry.id === 'dsh-plugin-desktop-connection')
  if (connectionEntry === undefined) {
    throw new Error('verify-packaged-boot: desktop-connection bundle absent from the packaged graph')
  }
  console.log(`verify-packaged-boot: packaged app boots — ${graph.entries.length} graph entries, connection bundle ${connectionEntry.url}`)
} finally {
  if (ctx !== undefined) await ctx.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
}
