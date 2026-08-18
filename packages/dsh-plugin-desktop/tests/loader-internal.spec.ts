/**
 * Unit tests for the profile-anchored loader internal (`loader-internal.ts`),
 * the module-resolution hook that keeps profile-installed plugins resolvable
 * when the native internal loader is unavailable (Electron).
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createProfileLoaderInternal, type ProfileLoaderInternal } from '../electron/loader-internal.ts'

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url))
const PROFILE = join(PKG_ROOT, '.tmp-test-profile')
rmSync(PROFILE, { recursive: true, force: true })
const mkDir = (rel: string) => mkdirSync(join(PROFILE, rel), { recursive: true })
const write = (rel: string, content: string) => writeFileSync(join(PROFILE, rel), content)
mkDir('node_modules/@fake/profile-plugin')
write('node_modules/@fake/profile-plugin/package.json', JSON.stringify({
  name: '@fake/profile-plugin', version: '1.0.0', type: 'module', main: 'index.js',
}))
write('node_modules/@fake/profile-plugin/index.js',
  "export const name = 'fake-profile-plugin'\nexport function apply() {}\n")
// An ESM-only plugin: exports declares only `types` + `import` conditions (no
// `require`), so CJS `require.resolve` throws ERR_PACKAGE_PATH_NOT_EXPORTED and
// the hook must resolve the entry from the exports map itself.
mkDir('node_modules/@fake/esm-plugin')
mkDir('node_modules/@fake/esm-plugin/lib')
write('node_modules/@fake/esm-plugin/package.json', JSON.stringify({
  name: '@fake/esm-plugin', version: '1.0.0', type: 'module',
  exports: { '.': { types: './lib/index.d.ts', import: './lib/index.js' }, './package.json': './package.json' },
}))
write('node_modules/@fake/esm-plugin/lib/index.js', "export const name = 'fake-esm-plugin'\n")
write('entry.js', "export const entry = 'profile-relative'\n")
const PROFILE_PACKAGE_URL = pathToFileURL(join(PROFILE, 'package.json')).href

after(() => rmSync(PROFILE, { recursive: true, force: true }))

test('resolves a bare plugin name from the profile node_modules', async () => {
  const internal = createProfileLoaderInternal(PROFILE_PACKAGE_URL)
  const mod = await internal.import('@fake/profile-plugin', PROFILE_PACKAGE_URL, {})
  assert.equal(typeof mod, 'object')
  const typed = mod as { name?: unknown; apply?: unknown }
  assert.equal(typed.name, 'fake-profile-plugin')
  assert.equal(typeof typed.apply, 'function')
})

test('resolves a bare subpath specifier from the profile', async () => {
  const internal = createProfileLoaderInternal(PROFILE_PACKAGE_URL)
  const mod = await internal.import('@fake/profile-plugin/index.js', PROFILE_PACKAGE_URL, {})
  assert.equal((mod as { name?: string }).name, 'fake-profile-plugin')
})

test('resolves an ESM-only plugin (no require condition) from its exports map', async () => {
  const internal = createProfileLoaderInternal(PROFILE_PACKAGE_URL)
  const mod = await internal.import('@fake/esm-plugin', PROFILE_PACKAGE_URL, {})
  assert.equal((mod as { name?: string }).name, 'fake-esm-plugin')
})

test('resolves relative and node: specifiers', async () => {
  const internal = createProfileLoaderInternal(PROFILE_PACKAGE_URL)
  const rel = await internal.import('./entry.js', PROFILE_PACKAGE_URL, {})
  assert.equal((rel as { entry?: string }).entry, 'profile-relative')
  const builtin = await internal.import('node:path', PROFILE_PACKAGE_URL, {})
  assert.equal(typeof (builtin as { join?: unknown }).join, 'function')
})

test('delegates to the native internal when one is provided', async () => {
  const calls: Array<[string, string]> = []
  const native: ProfileLoaderInternal = {
    import: async (specifier, baseUrl) => { calls.push([specifier, baseUrl]); return { delegated: true } },
  }
  const internal = createProfileLoaderInternal(PROFILE_PACKAGE_URL, native)
  const result = await internal.import('anything', 'file:///base/', {})
  assert.deepEqual(result, { delegated: true })
  assert.deepEqual(calls, [['anything', 'file:///base/']])
})
