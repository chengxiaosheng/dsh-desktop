/**
 * Unit tests for the PATH bootstrap (`path-bootstrap.ts`) the desktop host
 * appends to package-manager children, so a GUI launch (sparse PATH) still
 * resolves a user pnpm. Pure string/fs logic — no child processes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildChildPath, childPathDirs, nvmNodeBins, userBinDirs } from '../electron/path-bootstrap.ts'

test('buildChildPath appends extra dirs preserving existing order, dedups, drops empty segments', () => {
  assert.equal(
    buildChildPath('/usr/bin:/bin', ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']),
    '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
  )
  assert.equal(buildChildPath(undefined, ['/a', '/b']), '/a:/b')
  assert.equal(buildChildPath('', ['/a']), '/a')
  assert.equal(buildChildPath('/a::/b', []), '/a:/b')
  assert.equal(buildChildPath('/a', ['/a', '/a']), '/a')
})

test('nvmNodeBins lists only existing versioned node bins holding node or pnpm', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-nvm-'))
  try {
    const withNode = join(home, '.nvm', 'versions', 'node', 'v24.0.0', 'bin')
    const withPnpm = join(home, '.nvm', 'versions', 'node', 'v22.0.0', 'bin')
    const empty = join(home, '.nvm', 'versions', 'node', 'v20.0.0', 'bin')
    const notVersioned = join(home, '.nvm', 'versions', 'node', 'system', 'bin')
    for (const dir of [withNode, withPnpm, empty, notVersioned]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(withNode, 'node'), '')
    writeFileSync(join(withPnpm, 'pnpm'), '')
    assert.deepEqual(nvmNodeBins(home).sort(), [withNode, withPnpm].sort())
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('nvmNodeBins returns [] when there is no nvm tree', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-nonvm-'))
  try {
    assert.deepEqual(nvmNodeBins(home), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('childPathDirs contains the static user dirs and any existing nvm node bin, without duplicates', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-dirs-'))
  try {
    const nvmBin = join(home, '.nvm', 'versions', 'node', 'v24.0.0', 'bin')
    mkdirSync(nvmBin, { recursive: true })
    writeFileSync(join(nvmBin, 'pnpm'), '')
    const dirs = childPathDirs(home)
    for (const dir of userBinDirs(home)) assert.ok(dirs.includes(dir), `static dir present: ${dir}`)
    assert.ok(dirs.includes(nvmBin), 'nvm bin present')
    assert.equal(new Set(dirs).size, dirs.length, 'no duplicate dirs')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
