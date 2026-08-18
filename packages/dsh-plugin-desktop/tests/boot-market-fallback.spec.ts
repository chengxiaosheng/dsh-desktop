/**
 * Headless tests for the plugin-market override mechanics: the boot fallback
 * link (`ensureMarketFallback`), the not-a-bundle normalization
 * (`normalizeMarketNotABundle`), and the loader's overridable profile-first
 * resolution. No Electron, no socket, no pnpm child.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { ensureMarketFallback, normalizeMarketNotABundle } from '../electron/boot-desktop.ts'
import { createProfileLoaderInternal } from '../electron/loader-internal.ts'
import { resolvePackageRoot } from '../electron/package-root.ts'

const PKG_ROOT = resolvePackageRoot()
const INSTALL_ANCHOR = join(PKG_ROOT, 'package.json')

/** A package name that exists nowhere on this machine (pnpn sets NODE_PATH to
 *  the desktop virtual store, where a real `dshmarket` is hoisted — a test
 *  named `dshmarket` would resolve that instead of the fixture). */
const OVERRIDABLE = 'fixture-overridable-market'

/** Write a minimal loadable ESM package at `dir/node_modules/<name>`. */
function writePackage(dir: string, name: string, version: string, marker: string): void {
  const pkgDir = join(dir, 'node_modules', name)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.js' }))
  writeFileSync(join(pkgDir, 'index.js'), `export const where = ${JSON.stringify(marker)}\n`)
}

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-fallback-'))
  mkdirSync(join(dir, 'profiles', 'desktop', 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', dependencies: {} }))
  return dir
}

test('ensureMarketFallback links the bundled copy when the profile lacks the market', () => {
  const home = makeHome()
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    ensureMarketFallback(profileDir, INSTALL_ANCHOR)
    const link = join(profileDir, 'node_modules', 'dshmarket')
    assert.equal(existsSync(link), true)
    assert.equal(lstatSync(link).isSymbolicLink(), true)
    assert.equal(existsSync(join(link, 'package.json')), true, 'symlink target resolves')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ensureMarketFallback honors a valid real override and heals a broken one', () => {
  const home = makeHome()
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    const overrideDir = join(profileDir, 'node_modules', 'dshmarket')

    // A real override with a loadable entry stays as the active copy.
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(join(overrideDir, 'package.json'), JSON.stringify({ name: 'dshmarket', version: '9.9.9', main: 'index.js' }))
    writeFileSync(join(overrideDir, 'index.js'), 'export const where = "override"\n')
    ensureMarketFallback(profileDir, INSTALL_ANCHOR)
    assert.equal(lstatSync(overrideDir).isSymbolicLink(), false, 'valid override is not replaced')
    assert.equal(JSON.parse(readFileSync(join(overrideDir, 'package.json'), 'utf8')).version, '9.9.9')

    // A broken override (declares an entry that does not exist) is removed and
    // the bundled copy linked, and the profile dependency is cleared.
    rmSync(overrideDir, { recursive: true, force: true })
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(join(overrideDir, 'package.json'), JSON.stringify({ name: 'dshmarket', version: '8.8.8', main: 'missing.js' }))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', dependencies: { dshmarket: '^8.8.8' } }))
    ensureMarketFallback(profileDir, INSTALL_ANCHOR)
    assert.equal(lstatSync(overrideDir).isSymbolicLink(), true, 'broken override falls back to the bundled link')
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    assert.equal(manifest.dependencies?.dshmarket, undefined, 'broken override dependency cleared')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('normalizeMarketNotABundle strips dshmarket from the profile bundles', () => {
  const home = makeHome()
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      dependencies: { dshmarket: '^9.9.9' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket'] } },
    }))
    normalizeMarketNotABundle(profileDir)
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    assert.deepEqual(manifest.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loader resolves an overridable package profile-first when an override exists', async () => {
  const home = makeHome()
  try {
    const installDir = join(home, 'install')
    const profileDir = join(home, 'profiles', 'desktop')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'dsh-desktop-fixture', dependencies: { [OVERRIDABLE]: '^1.0.0' } }))
    writePackage(installDir, OVERRIDABLE, '1.0.0', 'bundled')
    writePackage(profileDir, OVERRIDABLE, '2.0.0', 'override')

    const profileUrl = pathToFileURL(join(profileDir, 'package.json')).href
    const installUrl = pathToFileURL(join(installDir, 'package.json')).href
    const loader = createProfileLoaderInternal(profileUrl, installUrl, undefined, new Set([OVERRIDABLE]))
    const overridden = await loader.import(OVERRIDABLE, profileUrl) as { where: string }
    assert.equal(overridden.where, 'override', 'overridable package resolves profile-first')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loader falls back to the closure when the profile has no market copy', async () => {
  const home = makeHome()
  try {
    const installDir = join(home, 'install')
    const profileDir = join(home, 'profiles', 'desktop')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'dsh-desktop-fixture', dependencies: { [OVERRIDABLE]: '^1.0.0' } }))
    writePackage(installDir, OVERRIDABLE, '1.0.0', 'bundled')

    const profileUrl = pathToFileURL(join(profileDir, 'package.json')).href
    const installUrl = pathToFileURL(join(installDir, 'package.json')).href
    const loader = createProfileLoaderInternal(profileUrl, installUrl, undefined, new Set([OVERRIDABLE]))
    const fallback = await loader.import(OVERRIDABLE, profileUrl) as { where: string }
    assert.equal(fallback.where, 'bundled', 'overridable package falls back to the closure')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
