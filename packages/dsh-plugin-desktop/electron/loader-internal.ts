/**
 * Profile-anchored module-resolution hook for the Cordis loader.
 *
 * The loader resolves bare (non-relative) entry specifiers through its
 * "internal" module loader when present, otherwise through `import.meta.resolve`
 * from the loader's OWN module location. The native internal loader (backed by
 * `node-addon-require-builtin`) is unavailable under Electron, so a plugin
 * installed into the profile (`~/.dsh/profiles/<name>/node_modules`) is
 * unreachable — bare names resolve against the workspace/packaged tree instead
 * and the app fails to boot after the first plugin install. This hook re-anchors
 * bare resolution to the profile (where installed plugins live) using plain ESM
 * `import` and a `createRequire(profile)` resolver — no Node internals required.
 * The resolver honors ESM-only `exports` maps: a package that declares only
 * `import`/`types` conditions (no `require`) fails CJS `require.resolve` with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`, so the hook then resolves the package
 * directory and picks the `import`/`default` entry itself. When a native
 * internal exists it is delegated to unchanged, so the override is
 * behavior-neutral on hosts that already resolve correctly.
 */

import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The loader's internal module-loader surface (`internal.import(specifier, baseUrl, options)`). */
export interface ProfileLoaderInternal {
  import(specifier: string, baseUrl: string, options?: unknown): Promise<unknown>
}

/** Split a bare specifier into its package name and optional subpath. */
function splitBare(specifier: string): { pkg: string; sub?: string } {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    return { pkg: `${parts[0]}/${parts[1] ?? ''}`, sub: parts.slice(2).join('/') || undefined }
  }
  return { pkg: parts[0] ?? '', sub: parts.slice(1).join('/') || undefined }
}

/** A package.json entry descriptor (a path or an exports-conditions object). */
type EntryValue = string | { [condition: string]: string | EntryValue } | null | undefined

/** Pick the ESM-loadable path from an exports entry (string or conditions object). */
function entryPath(entry: EntryValue): string | undefined {
  if (typeof entry === 'string') return entry
  if (entry !== null && typeof entry === 'object') {
    const conditions = entry as { [condition: string]: string }
    return conditions.import ?? conditions.default ?? (typeof conditions.require === 'string' ? conditions.require : undefined)
  }
  return undefined
}

/** The root entry path of a package manifest (`exports["."]` import/default, else `main`). */
function rootEntry(manifest: { main?: unknown; exports?: unknown }): string {
  const exports = manifest.exports as Record<string, EntryValue> | string | undefined
  if (typeof exports === 'string') return exports
  if (exports !== null && typeof exports === 'object' && exports['.'] !== undefined) {
    const dot = entryPath(exports['.'])
    if (dot !== undefined) return dot
  }
  if (typeof manifest.main === 'string') return manifest.main
  return 'index.js'
}

/** The exported path of a package subpath (`exports["./sub"]`), else the literal subpath. */
function subpathEntry(manifest: { exports?: unknown }, sub: string): string {
  const exports = manifest.exports as Record<string, EntryValue> | undefined
  const key = `./${sub}`
  const entry = exports !== null && typeof exports === 'object' ? entryPath(exports[key]) : undefined
  return entry ?? sub
}

/**
 * Resolve a bare specifier to an absolute entry file path, with ESM conditions.
 * @param require - a `createRequire` anchored to the profile.
 * @param specifier - the bare npm name (optionally `pkg/sub`).
 * @returns the absolute entry path.
 * @throws for unresolvable packages (the loader surfaces the error).
 */
export function resolveBareEntry(require: ReturnType<typeof createRequire>, specifier: string): string {
  try {
    return require.resolve(specifier)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
  }
  // ESM-only exports (no `require` condition): resolve the package directory
  // through its own package.json and pick the import/default entry.
  const { pkg, sub } = splitBare(specifier)
  const manifestPath = require.resolve(`${pkg}/package.json`)
  const dir = dirname(manifestPath)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { main?: unknown; exports?: unknown }
  return join(dir, sub !== undefined ? subpathEntry(manifest, sub) : rootEntry(manifest))
}

/**
 * Whether a bare specifier resolves to an existing entry file from the
 * profile — the boot recovery check for unloadable plugin entries.
 * @param profilePackageUrl - the active profile's `package.json` file URL.
 * @param specifier - the bare npm name (optionally `pkg/sub`).
 * @returns true when the entry resolves and its file exists.
 */
export function canResolveBare(profilePackageUrl: string, specifier: string): boolean {
  try {
    const require = createRequire(profilePackageUrl)
    return existsSync(resolveBareEntry(require, specifier))
  } catch {
    return false
  }
}

/**
 * Build the profile-anchored internal loader.
 * @param profilePackageUrl - the active profile's `package.json` file URL (the
 *   `bareModuleBaseUrl` the desktop boots with); bare names resolve from it.
 * @param native - the loader's original `internal` when the host provided one
 *   (plain Node); delegated to unchanged when present.
 * @returns the `internal` hook to install on `ctx.loader`.
 */
export function createProfileLoaderInternal(profilePackageUrl: string, native?: ProfileLoaderInternal): ProfileLoaderInternal {
  const require = createRequire(profilePackageUrl)
  return {
    async import(specifier, baseUrl, options) {
      if (native !== undefined) return native.import(specifier, baseUrl, options)
      if (specifier.startsWith('node:')) return import(specifier)
      if (specifier.startsWith('.') || specifier.startsWith('/')
        || specifier.startsWith('file:') || specifier.startsWith('data:')
        || specifier.startsWith('http:') || specifier.startsWith('https:')) {
        return import(new URL(specifier, baseUrl ?? profilePackageUrl).href)
      }
      // Bare npm name (optionally a subpath like `pkg/entry`): anchor to the
      // profile, where `dsh plugin add` installed it.
      const filePath = resolveBareEntry(require, specifier)
      return import(pathToFileURL(filePath).href)
    },
  }
}
