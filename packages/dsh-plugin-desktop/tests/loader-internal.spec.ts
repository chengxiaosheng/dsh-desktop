/**
 * Unit tests for the installation-first loader internal (`loader-internal.ts`),
 * the module-resolution hook that keeps in-box singleton services on the app's
 * module instance while profile-installed plugins stay resolvable when the
 * native internal loader is unavailable (Electron).
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createProfileLoaderInternal, type ProfileLoaderInternal } from '../electron/loader-internal.ts'

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url))
const PROFILE = join(PKG_ROOT, '.tmp-test-profile')
const INSTALL = join(PKG_ROOT, '.tmp-test-install')
rmSync(PROFILE, { recursive: true, force: true })
rmSync(INSTALL, { recursive: true, force: true })
const mkDir = (root: string, rel: string) => mkdirSync(join(root, rel), { recursive: true })
const write = (root: string, rel: string, content: string) => writeFileSync(join(root, rel), content)

// The profile is where `dsh plugin add` installs user packages.
mkDir(PROFILE, 'node_modules/@fake/profile-plugin')
write(PROFILE, 'node_modules/@fake/profile-plugin/package.json', JSON.stringify({
  name: '@fake/profile-plugin', version: '1.0.0', type: 'module', main: 'index.js',
}))
write(PROFILE, 'node_modules/@fake/profile-plugin/index.js',
  "export const name = 'fake-profile-plugin'\nexport function apply() {}\n")
// An ESM-only plugin: exports declares only `types` + `import` conditions (no
// `require`), so CJS `require.resolve` throws ERR_PACKAGE_PATH_NOT_EXPORTED and
// the hook must resolve the entry from the exports map itself.
mkDir(PROFILE, 'node_modules/@fake/esm-plugin')
mkDir(PROFILE, 'node_modules/@fake/esm-plugin/lib')
write(PROFILE, 'node_modules/@fake/esm-plugin/package.json', JSON.stringify({
  name: '@fake/esm-plugin', version: '1.0.0', type: 'module',
  exports: { '.': { types: './lib/index.d.ts', import: './lib/index.js' }, './package.json': './package.json' },
}))
write(PROFILE, 'node_modules/@fake/esm-plugin/lib/index.js', "export const name = 'fake-esm-plugin'\n")
// A name resolvable from BOTH the installation and the profile, with different
// payloads: the installation copy must win so in-box singletons stay one
// module instance even when a profile-local duplicate exists.
mkDir(PROFILE, 'node_modules/@fake/inbox-plugin')
write(PROFILE, 'node_modules/@fake/inbox-plugin/package.json', JSON.stringify({
  name: '@fake/inbox-plugin', version: '1.0.0', type: 'module', main: 'index.js',
}))
write(PROFILE, 'node_modules/@fake/inbox-plugin/index.js', "export const source = 'profile'\n")
write(PROFILE, 'entry.js', "export const entry = 'profile-relative'\n")

// The installation closure is where in-box packages live (the app's own
// node_modules); user-installed packages are absent here.
mkDir(INSTALL, 'node_modules/@fake/inbox-plugin')
write(INSTALL, 'node_modules/@fake/inbox-plugin/package.json', JSON.stringify({
  name: '@fake/inbox-plugin', version: '1.0.0', type: 'module', main: 'index.js',
}))
write(INSTALL, 'node_modules/@fake/inbox-plugin/index.js', "export const source = 'install'\n")

const PROFILE_PACKAGE_URL = pathToFileURL(join(PROFILE, 'package.json')).href
const INSTALL_PACKAGE_URL = pathToFileURL(join(INSTALL, 'package.json')).href

after(() => {
  rmSync(PROFILE, { recursive: true, force: true })
  rmSync(INSTALL, { recursive: true, force: true })
})

test('resolves an in-box package from the installation closure before the profile', async () => {
  const internal = createProfileLoaderInternal(PROFILE_PACKAGE_URL, INSTALL_PACKAGE_URL)
  const mod = await internal.import('@fake/inbox-plugin', PROFILE_PACKAGE_URL, {})
  assert.equal((mod as { source?: string }).source, 'install')
})

test('keeps the installation closure authoritative even when a native internal is present', async () => {
  const calls: string[] = []
  const native: ProfileLoaderInternal = {
    import: async (specifier) => { calls.push(specifier); return { delegated: true } },
  }
  const internal = createProfileLoaderInternal(PROFILE_PACKAGE_URL, INSTALL_PACKAGE_URL, native)
  const mod = await internal.import('@fake/inbox-plugin', PROFILE_PACKAGE_URL, {})
  assert.equal((mod as { source?: string }).source, 'install')
  assert.deepEqual(calls, [], 'the native must not shadow an in-box package')
})

test('defers a profile-only package to the native internal when one is provided', async () => {
  const calls: string[] = []
  const native: ProfileLoaderInternal = {
    import: async (specifier) => { calls.push(specifier); return { delegated: true } },
  }
  const internal = createProfileLoaderInternal(PROFILE_PACKAGE_URL, INSTALL_PACKAGE_URL, native)
  const result = await internal.import('@fake/profile-plugin', PROFILE_PACKAGE_URL, {})
  assert.deepEqual(result, { delegated: true })
  assert.deepEqual(calls, ['@fake/profile-plugin'])
})

test('resolves a bare plugin name from the profile node_modules', async () => {
  const internal = createProfileLoaderInternal(PROFILE_PACKAGE_URL, INSTALL_PACKAGE_URL)
  const mod = await internal.import('@fake/profile-plugin', PROFILE_PACKAGE_URL, {})
  assert.equal(typeof mod, 'object')
  const typed = mod as { name?: unknown; apply?: unknown }
  assert.equal(typed.name, 'fake-profile-plugin')
  assert.equal(typeof typed.apply, 'function')
})

test('resolves a bare subpath specifier from the profile', async () => {
  const internal = createProfileLoaderInternal(PROFILE_PACKAGE_URL, INSTALL_PACKAGE_URL)
  const mod = await internal.import('@fake/profile-plugin/index.js', PROFILE_PACKAGE_URL, {})
  assert.equal((mod as { name?: string }).name, 'fake-profile-plugin')
})

test('resolves an ESM-only plugin (no require condition) from its exports map', async () => {
  const internal = createProfileLoaderInternal(PROFILE_PACKAGE_URL, INSTALL_PACKAGE_URL)
  const mod = await internal.import('@fake/esm-plugin', PROFILE_PACKAGE_URL, {})
  assert.equal((mod as { name?: string }).name, 'fake-esm-plugin')
})

test('resolves relative and node: specifiers', async () => {
  const internal = createProfileLoaderInternal(PROFILE_PACKAGE_URL, INSTALL_PACKAGE_URL)
  const rel = await internal.import('./entry.js', PROFILE_PACKAGE_URL, {})
  assert.equal((rel as { entry?: string }).entry, 'profile-relative')
  const builtin = await internal.import('node:path', PROFILE_PACKAGE_URL, {})
  assert.equal(typeof (builtin as { join?: unknown }).join, 'function')
})

test('delegates an unresolvable-from-install specifier to the native internal', async () => {
  const calls: Array<[string, string]> = []
  const native: ProfileLoaderInternal = {
    import: async (specifier, baseUrl) => { calls.push([specifier, baseUrl]); return { delegated: true } },
  }
  const internal = createProfileLoaderInternal(PROFILE_PACKAGE_URL, INSTALL_PACKAGE_URL, native)
  const result = await internal.import('anything', 'file:///base/', {})
  assert.deepEqual(result, { delegated: true })
  assert.deepEqual(calls, [['anything', 'file:///base/']])
})
