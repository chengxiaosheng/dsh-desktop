/**
 * Desktop host services the plugin-market contract reads: `desktopProfiles`
 * (the active profile) and `desktopPnpm` (the generation-scoped package
 * manager).
 *
 * `desktopPnpm` matches the public cross-environment contract the dshmarket
 * plugin consumes (`plugin-services.md` in the upstream desktop): `runPlugin`
 * re-invokes the published `dsh plugin --profile <active> …` CLI with the
 * caller directory as cwd, so pnpm runs AND `dsh.profile.bundles`
 * reconciliation happen through the ordinary DSH CLI. `run` is the low-level
 * variant that runs pnpm directly with the active profile as cwd.
 *
 * pnpm resolution: the bundled standalone binary (`@pnpm/exe`, materialized by
 * its install-time setup.js) is prepended to the child PATH so it wins when
 * present; otherwise the system `pnpm` on PATH serves. The `dsh` CLI entry
 * runs under Electron's plain-Node mode (`ELECTRON_RUN_AS_NODE`), so no system
 * Node is required and a packaged app can install plugins offline.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { resolvePackageRoot } from './package-root.ts'

const PKG_ROOT = resolvePackageRoot()
const INSTALL_ANCHOR = join(PKG_ROOT, 'package.json')
const require = createRequire(INSTALL_ANCHOR)

/** One package-manager operation handle, matching the upstream `DesktopPnpmHandle`. */
export interface DesktopPnpmHandle {
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  readonly done: Promise<{
    readonly exitCode: number | null
    readonly signal: NodeJS.Signals | null
  }>
  cancel(): void
}

/** The generation-scoped package manager, matching the upstream `DesktopPnpm`. */
export interface DesktopPnpm {
  run(args: readonly string[], signal?: AbortSignal): DesktopPnpmHandle
  runPlugin(args: readonly string[], invokingDir: string, signal?: AbortSignal): DesktopPnpmHandle
}

/** The active profile the desktop host owns; read by `ctx.get('desktopProfiles')`. */
export interface DesktopProfiles {
  current: {
    readonly name: string
    readonly dir: string
  }
}

/** The message the market's desktop adapter maps to its `busy` flag. */
export const BUSY_MESSAGE = 'another desktop pnpm operation is already running'

/** Resolve the published `dsh` CLI entry the plugin forwarder runs. */
function resolveDshBin(): string {
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: string | Record<string, string> }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  if (typeof bin !== 'string') throw new Error('dsh-desktop: @deepseek-ai/dsh declares no dsh bin')
  return join(dirname(manifestPath), bin)
}

/** The bundled standalone pnpm directory (`@pnpm/exe` with its binary materialized), or undefined. */
function bundledPnpmDir(): string | undefined {
  try {
    const dir = dirname(require.resolve('@pnpm/exe/package.json'))
    return existsSync(join(dir, 'pnpm')) ? dir : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the environment for a package-manager child: inherited env, the
 * bundled pnpm's directory prepended to PATH when present (so the `dsh` CLI's
 * own `spawnSync("pnpm", …)` resolves our binary first), and — for the CLI
 * forwarder — Electron's plain-Node mode.
 * @param asNode - when true, run `process.execPath` as plain Node (the `dsh` CLI launch).
 */
function childEnv(asNode: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const sep = process.platform === 'win32' ? ';' : ':'
  const bundled = bundledPnpmDir()
  if (bundled !== undefined) {
    const parts = (env.PATH ?? '').split(sep).filter(part => part !== '')
    if (!parts.includes(bundled)) parts.unshift(bundled)
    env.PATH = parts.join(sep)
  }
  if (asNode) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

/** Kill a spawned child and its whole tree (own process group on POSIX). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      return
    } catch { /* fall through to the direct kill */ }
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
      return
    } catch { /* fall through to the direct kill */ }
  }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

/** Assert a caller-supplied directory is an absolute, NUL-free path. */
function assertAbsoluteDir(dir: string, label: string): void {
  if (!isAbsolute(dir) || dir.includes('\0')) {
    throw new Error(`dsh-desktop: ${label} must be an absolute path without NUL`)
  }
}

/**
 * Create the `desktopProfiles` and `desktopPnpm` services for the active
 * profile directory. Register them on the host context in the boot prepare
 * hook, before Loader entries mount.
 * @param activeProfileDir - the active profile's absolute directory.
 * @param profileName - the active profile's name (the `--profile` the CLI targets).
 * @returns the two services.
 */
export function createDesktopServices(activeProfileDir: string, profileName: string): { desktopProfiles: DesktopProfiles; desktopPnpm: DesktopPnpm } {
  assertAbsoluteDir(activeProfileDir, 'active profile directory')
  const dshBin = resolveDshBin()
  let active: ChildProcess | null = null

  const guard = (): void => {
    if (active !== null) throw new Error(BUSY_MESSAGE)
  }

  const begin = (child: ChildProcess, signal: AbortSignal | undefined): DesktopPnpmHandle => {
    const onAbort = (): void => killTree(child)
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (code, childSignal) => {
        signal?.removeEventListener('abort', onAbort)
        active = null
        resolve({ exitCode: code, signal: childSignal })
      })
    })
    return {
      stdout: child.stdout!,
      stderr: child.stderr!,
      done,
      cancel: () => killTree(child),
    }
  }

  return {
    desktopProfiles: {
      current: { name: profileName, dir: activeProfileDir },
    },

    desktopPnpm: {
      /** Low-level pnpm run with the active profile as cwd (no plugin reconciliation). */
      run(args, signal) {
        guard()
        const bundled = bundledPnpmDir()
        const file = bundled !== undefined ? join(bundled, 'pnpm') : 'pnpm'
        const child = spawn(file, [...args], {
          cwd: activeProfileDir,
          env: childEnv(false),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        })
        return begin(child, signal)
      },

      /**
       * Plugin add/remove/update/install through the `dsh` CLI: initializes the
       * profile on first use, runs pnpm, and reconciles `dsh.profile.bundles`.
       * @param args - pnpm arguments forwarded after `dsh plugin --profile <active>`.
       * @param invokingDir - absolute caller directory used as the CLI cwd.
       */
      runPlugin(args, invokingDir, signal) {
        guard()
        assertAbsoluteDir(invokingDir, 'invoking directory')
        const child = spawn(process.execPath, [dshBin, 'plugin', '--profile', profileName, ...args], {
          cwd: invokingDir,
          env: childEnv(true),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        })
        return begin(child, signal)
      },
    },
  }
}
