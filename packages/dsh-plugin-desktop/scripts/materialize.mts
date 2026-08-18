#!/usr/bin/env node
/**
 * Materialize a self-contained Electron app payload for electron-builder.
 *
 * The desktop host resolves every plugin row and bundle by name from a flat
 * node_modules closure (the boot's heal links it into $DSH_HOME/profiles/
 * node_modules). In the source checkout that closure is pnpm symlinks into the
 * workspace; a packaged app must carry it as real files, co-located with the
 * runtime so the loader's bare-specifier imports and the boot's anchor resolve
 * from real directories — the `deepseek-harness/apps/desktop` layout. Output
 * (electron-builder `directories.app` + `extraResources`):
 *   dist-pack/   the thin asar app: a bootstrap main that imports the real
 *                runtime from resources/host and imports no @deepseek-ai package
 *   dist-host/   extraResources → resources/host: the electron runtime, the row
 *                sources, cordis.patch.yml, the build icon, the flat dependency
 *                closure (node_modules), and the host manifest the packaged boot
 *                anchors on
 *
 * The staged runtime is the package's compiled TypeScript (`lib/electron` +
 * `lib/src`, produced by `pnpm build`) — never the sources.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
const appAnchor = join(pkgRoot, 'package.json')
const staging = join(pkgRoot, 'dist-pack')
const hostStaging = join(pkgRoot, 'dist-host')
const compiledRoot = join(pkgRoot, 'lib')

/** The manifest fields the closure walk reads (the full manifest also carries name/version/etc.). */
interface ClosureManifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const appManifest = JSON.parse(readFileSync(appAnchor, 'utf8')) as ClosureManifest & {
  name: string
  version: string
  license: string
  homepage: string
  devDependencies?: Record<string, string>
}

// The builder config is the single source of the display identity the
// packaged app reports (Electron derives userData from productName).
const builderConfig = parse(readFileSync(join(pkgRoot, 'electron-builder.yml'), 'utf8')) as {
  productName: string
  appId: string
}

// ---- 1. Walk the same dependency closure healProfilesModuleFallback does. ----
function packageDirFromAnchor(anchorPath: string, packageName: string): string | undefined {
  for (const searchPath of createRequire(anchorPath).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

const closure = new Map<string, string>() // package name → resolved dir
closure.set(appManifest.name, pkgRoot) // the desktop row package itself
// @pnpm/<platform> ships the standalone pnpm binary that @pnpm/exe's install
// setup hard-links into its own `pnpm` file. The linked copy is what the
// desktop runs at runtime, so the platform packages are install-time-only and
// are excluded to avoid shipping a second ~150MB binary per platform.
const PNPM_PLATFORM_PKG = /^@pnpm\/(?:linux|linuxstatic|win|macos)-(?:x64|arm64)$/
const queue: Array<{ anchor: string; manifest: ClosureManifest }> = [{ anchor: appAnchor, manifest: appManifest }]
for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
  const manifest = next.manifest
  for (const dep of [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    // Platform-binding packages (koffi's @koromix/*, sharp's @img/*) are
    // optional dependencies; the closure needs the current platform's copy.
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]) {
    if (closure.has(dep) || PNPM_PLATFORM_PKG.test(dep)) continue
    const dir = packageDirFromAnchor(next.anchor, dep)
    if (dir === undefined) continue
    closure.set(dep, dir)
    // Realpath the resolved dir before using it as the next anchor so the walk
    // follows pnpm's nested-symlink layout (deps live in the .pnpm entry's own
    // node_modules, reachable only from the realpath).
    let real: string
    try { real = realpathSync(dir) } catch { real = dir }
    queue.push({ anchor: join(real, 'package.json'), manifest: JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) })
  }
}

// ---- 2. The thin asar app (bootstrap only). ----
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
mkdirSync(join(staging, 'lib'), { recursive: true })
writeFileSync(join(staging, 'lib', 'main.js'), [
  '// Packaged main-process bootstrap: the real runtime ships in resources/host',
  '// next to the materialized dependency closure, so its @deepseek-ai imports',
  '// resolve from real files, not an asar-internal node_modules.',
  "import { join } from 'node:path'",
  "import { pathToFileURL } from 'node:url'",
  "await import(pathToFileURL(join(process.resourcesPath, 'host', 'electron', 'main.js')).href)",
  '',
].join('\n'))
writeFileSync(join(staging, 'package.json'), JSON.stringify({
  name: appManifest.name,
  productName: builderConfig.productName,
  version: appManifest.version,
  private: true,
  type: 'module',
  main: 'lib/main.js',
  license: appManifest.license,
  homepage: appManifest.homepage,
  // electron-builder sizes the app from devDependencies; the real closure ships
  // via extraResources, so no runtime deps are declared here.
  devDependencies: { electron: appManifest.devDependencies?.electron },
}, null, 2) + '\n')
// electron-builder's node-module collector runs `pnpm list --prod` from the app
// dir; an empty local workspace + lockfile scope that list to this app alone so
// it never walks up and packs the whole workspace's deps as dead weight.
writeFileSync(join(staging, 'pnpm-workspace.yaml'), 'packages: []\n')
writeFileSync(join(staging, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n')

// ---- 3. The host runtime + flat closure (extraResources → resources/host). ----
rmSync(hostStaging, { recursive: true, force: true })
mkdirSync(hostStaging, { recursive: true })
for (const entry of ['electron', 'src']) {
  const source = join(compiledRoot, entry)
  if (!existsSync(source)) {
    throw new Error(`desktop-pack: compiled runtime missing at ${source} — run pnpm build first`)
  }
  cpSync(source, join(hostStaging, entry), { recursive: true })
}
cpSync(join(pkgRoot, 'cordis.patch.yml'), join(hostStaging, 'cordis.patch.yml'))

// The linux window icon; the packaged window resolves it from the host tree.
const iconSource = join(pkgRoot, 'build', 'icon.png')
if (!existsSync(iconSource)) {
  throw new Error(`desktop-pack: build icon missing at ${iconSource}`)
}
mkdirSync(join(hostStaging, 'build'), { recursive: true })
cpSync(iconSource, join(hostStaging, 'build', 'icon.png'))

const copiedRealDirs = new Set<string>()
const modulesDir = join(hostStaging, 'node_modules')
mkdirSync(modulesDir, { recursive: true })
for (const [name, dir] of closure) {
  let real: string
  try { real = realpathSync(dir) } catch { real = dir }
  if (copiedRealDirs.has(real)) continue
  copiedRealDirs.add(real)
  const target = join(modulesDir, name)
  mkdirSync(dirname(target), { recursive: true })
  if (name === appManifest.name) {
    // The desktop row package is the app itself; copying the whole dir would
    // recurse into this staging tree. Ship only the row contract: package.json
    // (exports + dsh.bundle.patch), the compiled runtime, and the composition patch.
    cpSync(join(real, 'package.json'), join(target, 'package.json'))
    cpSync(join(real, 'cordis.patch.yml'), join(target, 'cordis.patch.yml'))
    cpSync(join(real, 'lib'), join(target, 'lib'), { recursive: true })
    continue
  }
  copyRuntime(real, target)
}

// The host manifest declares the WHOLE closure as dependencies (concrete
// versions) so the packaged profile boot's heal walks them from
// resources/host/node_modules; it is never packed by electron-builder, only
// extraResource'd.
const hostDeps: Record<string, string> = {}
for (const [name, dir] of closure) {
  try {
    hostDeps[name] = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? '*'
  } catch {
    hostDeps[name] = '*'
  }
}
writeFileSync(join(hostStaging, 'package.json'), JSON.stringify({
  name: 'dsh-plugin-desktop-host',
  version: appManifest.version,
  private: true,
  type: 'module',
  dependencies: hostDeps,
}, null, 2) + '\n')

// Record the source platform so a stale dist-host is never packed for a
// different platform (each platform builds its own native bindings).
writeFileSync(join(hostStaging, 'platform.json'), JSON.stringify({ platform: process.platform, arch: process.arch }) + '\n')

console.log(`desktop-pack: ${closure.size} packages, ${copiedRealDirs.size} real dirs copied -> ${hostStaging} (app -> ${staging})`)

/**
 * Copy one package's runtime files, skipping pnpm internals and non-runtime
 * dirs. Native binaries (build/, prebuilds/, bin/) and dist/-shipped runtime
 * code are kept — the flat layout must satisfy every runtime import.
 */
function copyRuntime(sourceDir: string, targetDir: string): void {
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(sourceDir, src)
      if (rel === '') return true // the copy root itself
      const first = rel.split('/')[0]
      if (first === 'node_modules') return false
      if (first === 'scripts' || first === 'tests') return false
      if (basename(src) === 'tsconfig.tsbuildinfo') return false
      return true
    },
  })
}
