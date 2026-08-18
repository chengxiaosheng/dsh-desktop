/**
 * Plugin-market version service: the desktop shell's controlled update and
 * rollback surface for the built-in plugin market.
 *
 * The market ships as the app's bundled copy — an `optionalDependencies`
 * entry the heal walk does not manage — and the boot keeps a profile fallback
 * link to it. A user-installed override lives at `<profile>/node_modules/
 * dshmarket` as a real directory and shadows the bundled copy on the next
 * boot (the loader's overridable resolution and the client table both prefer
 * the profile). This module reads the three versions (bundled / override /
 * registry), gates a candidate update against the desktop's closure peer
 * versions, and performs dependency-only installs — never writing
 * `dsh.profile.bundles`, so the single `dsh-market` row and the boot health
 * check stay intact. The shell owns this surface rather than the market
 * itself, so the control works even when the market is broken or outdated.
 */

import { createRequire } from 'node:module'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { satisfies } from './peer-range.ts'
import { resolvePackageRoot } from './package-root.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { DesktopPnpm } from './desktop-services.ts'

const MARKET = 'dshmarket'
/** npm registry base for market metadata; override with DSH_MARKET_REGISTRY. */
const REGISTRY = process.env.DSH_MARKET_REGISTRY ?? 'https://registry.npmjs.org'
/** The app install's `package.json` — the closure the bundled copy resolves from. */
const INSTALL_ANCHOR = join(resolvePackageRoot(), 'package.json')

/** The version states the shell settings row presents. */
export interface MarketVersionInfo {
  /** The bundled (built-in fallback) copy's version; null when not installed. */
  bundled: string | null
  /** The user-installed override's version; null when the bundled copy serves. */
  override: string | null
  /** The registry's latest version; null when the registry is unreachable. */
  latest: string | null
  /** Human-readable failure when the check itself failed. */
  error?: string
}

/** One shell-requested market-version mutation result. */
export interface MarketVersionResult {
  ok: boolean
  message: string
}

/** A pnpm operation handle (structural subset of `DesktopPnpmHandle`). */
interface PnpmRunHandle {
  readonly done: Promise<{ readonly exitCode: number | null }>
}

/** The active profile directory the host services report. */
function activeProfileDir(ctx: Context): string {
  const profiles = ctx.get('desktopProfiles') as { current: { dir: string } } | undefined
  if (profiles === undefined) throw new Error('dsh-desktop: desktopProfiles service missing — market version control unavailable')
  return profiles.current.dir
}

/** The package-manager service the shell runs dependency operations through. */
function packageManager(ctx: Context): DesktopPnpm {
  const pnpm = ctx.get('desktopPnpm') as DesktopPnpm | undefined
  if (pnpm === undefined) throw new Error('dsh-desktop: desktopPnpm service missing — market version control unavailable')
  return pnpm
}

/** The bundled copy's version from the app closure. */
export function bundledMarketVersion(installAnchor: string = INSTALL_ANCHOR): string | null {
  try {
    const require = createRequire(installAnchor)
    const manifest = JSON.parse(readFileSync(require.resolve(`${MARKET}/package.json`), 'utf8')) as { version?: string }
    return manifest.version ?? null
  } catch {
    return null
  }
}

/** Whether a path exists and is a real directory (not a symlink). */
function isRealDir(path: string): boolean {
  try {
    return existsSync(path) && !lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** The override's version from the profile, or null when the bundled copy serves. */
export function overrideMarketVersion(profileDir: string): string | null {
  const dir = join(profileDir, 'node_modules', MARKET)
  if (!isRealDir(dir)) return null
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }
    return manifest.version ?? null
  } catch {
    return null
  }
}

/** The registry's latest version, or null when unreachable. */
async function registryLatest(): Promise<string | null> {
  try {
    const response = await fetch(`${REGISTRY}/${MARKET}/latest`, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return null
    const doc = await response.json() as { version?: string }
    return doc.version ?? null
  } catch {
    return null
  }
}

/** The candidate version's published package.json manifest, or null. */
async function publishedManifest(version: string): Promise<{ peerDependencies?: Record<string, string> } | null> {
  try {
    const response = await fetch(`${REGISTRY}/${MARKET}/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return null
    return await response.json() as { peerDependencies?: Record<string, string> }
  } catch {
    return null
  }
}

/** The desktop closure's installed version of a peer package, or null. */
function closureVersion(peer: string, installAnchor: string): string | null {
  try {
    const require = createRequire(installAnchor)
    const manifest = JSON.parse(readFileSync(require.resolve(`${peer}/package.json`), 'utf8')) as { version?: string }
    return manifest.version ?? null
  } catch {
    return null
  }
}

/**
 * Compatibility gate over an already-fetched candidate manifest: every peer
 * must be satisfied by the desktop closure's version of that peer. A peer the
 * closure lacks would install fresh inside the profile, splitting the
 * `@deepseek-ai/*` service identity (duplicate singletons), so such a
 * candidate is rejected.
 * @returns a human-readable rejection reason, or null when the candidate is
 *   compatible with the closure.
 */
export function peerCompatErrorForManifest(
  manifest: { peerDependencies?: Record<string, string> },
  installAnchor: string = INSTALL_ANCHOR,
): string | null {
  for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const installed = closureVersion(peer, installAnchor)
    if (installed === null) return `dshmarket@? peers on ${peer}, which the desktop does not ship`
    if (!satisfies(installed, range)) {
      return `dshmarket@? requires ${peer} ${range}, but the desktop ships ${installed}`
    }
  }
  return null
}

/**
 * Compatibility gate: fetch the candidate's published manifest and run the
 * peer check against the closure.
 * @returns a human-readable rejection reason, or null when the candidate is
 *   compatible with the closure.
 */
export async function peerCompatError(version: string, installAnchor: string = INSTALL_ANCHOR): Promise<string | null> {
  const manifest = await publishedManifest(version)
  if (manifest === null) return `cannot fetch dshmarket@${version} from the registry`
  const reason = peerCompatErrorForManifest(manifest, installAnchor)
  return reason === null ? null : reason.replace('dshmarket@?', `dshmarket@${version}`)
}

/**
 * Add `dshmarket@<version>` to the profile's `minimumReleaseAgeExclude` so the
 * profile-side pnpm (which does not inherit the desktop workspace's exclude)
 * does not refuse a fresh market release. Merges into an existing block.
 * @returns true when the profile workspace file was updated.
 */
export function ensureMarketReleaseAgeExclude(profileDir: string, version: string): boolean {
  const file = join(profileDir, 'pnpm-workspace.yaml')
  let yaml = ''
  try {
    yaml = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  const entry = `${MARKET}@${version}`
  const blockRe = /minimumReleaseAgeExclude:\n((?:[ \t]+[^\n]*\n?)*)/
  const blockMatch = blockRe.exec(yaml)
  if (blockMatch !== null) {
    if (blockMatch[0].includes(entry)) return false
    const block = blockMatch[0].replace(/\n?$/, '\n') + `  - ${entry}\n`
    writeFileSync(file, yaml.replace(blockRe, block))
    return true
  }
  writeFileSync(file, `${yaml.replace(/\n?$/, '\n')}minimumReleaseAgeExclude:\n  - ${entry}\n`)
  return true
}

/** Remove the market's entry from the profile's release-age exclude. */
export function clearMarketReleaseAgeExclude(profileDir: string, version?: string): void {
  const file = join(profileDir, 'pnpm-workspace.yaml')
  let yaml = ''
  try {
    yaml = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const blockRe = /minimumReleaseAgeExclude:\n((?:[ \t]+[^\n]*\n?)*)/
  const blockMatch = blockRe.exec(yaml)
  if (blockMatch === null) return
  const kept = blockMatch[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !(line.startsWith('-') && (version === undefined || line === `- ${MARKET}@${version}`)))
  const replacement = kept.length > 0
    ? `minimumReleaseAgeExclude:\n${kept.map((line) => `  ${line}`).join('\n')}\n`
    : ''
  writeFileSync(file, yaml.replace(blockRe, replacement))
}

/** Read the three market version states for the settings row. */
export async function readMarketVersion(ctx: Context): Promise<MarketVersionInfo> {
  const profileDir = activeProfileDir(ctx)
  const bundled = bundledMarketVersion()
  const override = overrideMarketVersion(profileDir)
  const latest = await registryLatest()
  const info: MarketVersionInfo = { bundled, override, latest }
  if (latest === null && bundled === null) info.error = 'cannot reach the npm registry'
  return info
}

/**
 * Update the market to an exact version: gate it against the closure, exempt
 * it from the profile release-age check, and install it dependency-only.
 * Takes effect on the next host restart.
 */
export async function updateMarketVersion(ctx: Context, version: string): Promise<MarketVersionResult> {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    return { ok: false, message: `invalid market version: ${version}` }
  }
  const profileDir = activeProfileDir(ctx)
  const compat = await peerCompatError(version)
  if (compat !== null) return { ok: false, message: compat }
  ensureMarketReleaseAgeExclude(profileDir, version)
  const handle = packageManager(ctx).run(['add', `${MARKET}@${version}`])
  const result = await handle.done
  if (result.exitCode !== 0) {
    return { ok: false, message: `pnpm failed to install dshmarket@${version} (exit ${result.exitCode})` }
  }
  return { ok: true, message: `installed dshmarket@${version} — restart the host to apply` }
}

/** Remove the override, falling back to the bundled copy on the next boot. */
export async function rollbackMarketVersion(ctx: Context): Promise<MarketVersionResult> {
  const profileDir = activeProfileDir(ctx)
  const handle = packageManager(ctx).run(['remove', MARKET])
  const result = await handle.done
  if (result.exitCode !== 0) {
    return { ok: false, message: `pnpm failed to remove the market override (exit ${result.exitCode})` }
  }
  clearMarketReleaseAgeExclude(profileDir)
  return { ok: true, message: 'removed the market override — the bundled copy will serve on the next restart' }
}
