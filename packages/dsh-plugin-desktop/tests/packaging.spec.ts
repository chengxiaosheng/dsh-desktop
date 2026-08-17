/**
 * Packaging contract for the electron-builder configuration.
 *
 * Asserts the standalone `electron-builder.yml` declares the shipped target
 * matrix (mac DMG, win x64 NSIS, linux AppImage + deb + rpm) and the
 * materialize staging layout the packaged boot anchors on (thin asar app +
 * `resources/host` runtime), so a config edit cannot silently drop a target
 * or break the packaged-boot resolution paths.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

interface ExtraResource {
  from: string
  to: string
}

interface BuilderConfig {
  appId: string
  productName: string
  executableName: string
  asar: boolean
  publish: null
  npmRebuild: boolean
  directories: { app: string; output: string; buildResources: string }
  files: string[]
  extraResources: ExtraResource[]
  mac: { target: unknown; artifactName: string }
  win: { target: Array<{ target: string; arch: string[] }> }
  nsis: { artifactName: string }
  linux: { target: string[]; artifactName: string }
}

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url))
const config = parse(readFileSync(join(PKG_ROOT, 'electron-builder.yml'), 'utf8')) as BuilderConfig

test('electron-builder.yml declares the application identity and asar staging', () => {
  assert.equal(config.appId, 'ai.deepseek.dsh.desktop')
  assert.equal(config.productName, 'DSH Desktop')
  assert.equal(config.executableName, 'dsh-desktop')
  assert.equal(config.asar, true)
  assert.equal(config.npmRebuild, false)
  assert.equal(config.publish, null, 'publishing is off; releases are built, never uploaded, by the builder')
  assert.deepEqual(config.directories, { app: 'dist-pack', output: 'dist', buildResources: 'build' })
  assert.ok(config.files.includes('lib/**'), 'asar app carries the bootstrap lib')
  assert.ok(config.files.includes('package.json'), 'asar app carries its manifest')
})

test('extraResources stage the materialized host runtime under resources/host', () => {
  const mapping = new Map(config.extraResources.map((entry) => [entry.from, entry.to]))
  assert.deepEqual(
    [...mapping.values()].every((to) => to.startsWith('host/')),
    true,
    'every staged entry lands under resources/host',
  )
  for (const from of ['dist-host/electron', 'dist-host/src', 'dist-host/cordis.patch.yml', 'dist-host/build', 'dist-host/package.json', 'dist-host/platform.json', 'dist-host/node_modules']) {
    assert.ok(mapping.has(from), `${from} is staged`)
  }
})

test('electron-builder.yml declares the target matrix: mac DMG, win x64 NSIS, linux AppImage + deb + rpm', () => {
  assert.deepEqual(config.mac.target, ['dmg'])
  assert.match(config.mac.artifactName, /\$\{version\}.*\$\{arch\}/)
  assert.equal(config.win.target.length, 1)
  assert.equal(config.win.target[0].target, 'nsis')
  assert.deepEqual(config.win.target[0].arch, ['x64'])
  assert.match(config.nsis.artifactName, /Setup\.\$\{ext\}$/)
  assert.deepEqual([...config.linux.target].sort(), ['AppImage', 'deb', 'rpm'])
  assert.match(config.linux.artifactName, /\$\{version\}.*\$\{arch\}/)
})
