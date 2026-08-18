/**
 * Unit tests for the plugin-market version service's pure helpers: version
 * reads (bundled / override), the profile release-age exclude management, and
 * the peer compatibility gate. The pnpm-driven update/rollback legs and the
 * registry fetch are exercised manually/headlessly elsewhere (they touch the
 * pnpm store and the network), so nothing here spawns a child or fetches.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  bundledMarketVersion,
  clearMarketReleaseAgeExclude,
  ensureMarketReleaseAgeExclude,
  overrideMarketVersion,
  peerCompatErrorForManifest,
} from '../electron/market-version.ts'
import { resolvePackageRoot } from '../electron/package-root.ts'

const PKG_ROOT = resolvePackageRoot()
const INSTALL_ANCHOR = join(PKG_ROOT, 'package.json')

function makeProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-version-'))
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  return dir
}

test('bundledMarketVersion reads the desktop closure copy', () => {
  const version = bundledMarketVersion(INSTALL_ANCHOR)
  assert.equal(typeof version, 'string')
  assert.match(version as string, /^\d+\.\d+\.\d+$/)
})

test('overrideMarketVersion distinguishes a real override from the bundled fallback', () => {
  const profile = makeProfile()
  try {
    assert.equal(overrideMarketVersion(profile), null, 'no override by default')
    const dir = join(profile, 'node_modules', 'dshmarket')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dshmarket', version: '9.9.9' }))
    assert.equal(overrideMarketVersion(profile), '9.9.9')
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('ensureMarketReleaseAgeExclude adds and merges the entry; clear removes it', () => {
  const profile = makeProfile()
  try {
    const file = join(profile, 'pnpm-workspace.yaml')
    assert.equal(ensureMarketReleaseAgeExclude(profile, '1.12.2'), true, 'first write')
    assert.match(readFileSync(file, 'utf8'), /minimumReleaseAgeExclude:\n  - dshmarket@1\.12\.2\n/)
    assert.equal(ensureMarketReleaseAgeExclude(profile, '1.12.2'), false, 'idempotent')
    assert.equal(ensureMarketReleaseAgeExclude(profile, '1.12.3'), true, 'merges a second version')
    const yaml = readFileSync(file, 'utf8')
    assert.match(yaml, /- dshmarket@1\.12\.2/)
    assert.match(yaml, /- dshmarket@1\.12\.3/)
    clearMarketReleaseAgeExclude(profile)
    assert.doesNotMatch(readFileSync(file, 'utf8'), /minimumReleaseAgeExclude/)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('peerCompatErrorForManifest gates a candidate against the closure peers', () => {
  // The desktop closure ships @deepseek-ai/cordis and @deepseek-ai/dsh-settings.
  assert.equal(
    peerCompatErrorForManifest({ peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' } }, INSTALL_ANCHOR),
    null,
    'a peer range the closure satisfies passes',
  )
  const tooNew = peerCompatErrorForManifest({ peerDependencies: { '@deepseek-ai/dsh-settings': '^0.2.0' } }, INSTALL_ANCHOR)
  assert.ok(tooNew !== null, 'a peer range the closure cannot satisfy fails')
  assert.match(tooNew as string, /^dshmarket@\? requires @deepseek-ai\/dsh-settings/)
  const missing = peerCompatErrorForManifest({ peerDependencies: { '@deepseek-ai/dsh-nonexistent': '^1.0.0' } }, INSTALL_ANCHOR)
  assert.ok(missing !== null, 'a peer the closure does not ship fails')
  assert.match(missing as string, /which the desktop does not ship/)
  assert.equal(peerCompatErrorForManifest({}, INSTALL_ANCHOR), null, 'no peers passes')
})
