/**
 * Unit tests for the desktop host services (`desktop-services.ts`): the
 * `desktopProfiles`/`desktopPnpm` contract the plugin market reads. These
 * cover construction and synchronous argument validation only — spawning a
 * package operation is exercised manually/headlessly elsewhere (it touches
 * the pnpm store), so nothing here starts a child process.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDesktopServices } from '../electron/desktop-services.ts'

const ABS_PROFILE = '/tmp/dsh-desktop-service-test-profile'

test('createDesktopServices validates the active profile directory', () => {
  assert.throws(() => createDesktopServices('relative/path', 'desktop'), /absolute path without NUL/)
  assert.throws(() => createDesktopServices(`abs\u0000nul`, 'desktop'), /absolute path without NUL/)
})

test('createDesktopServices exposes the active profile and the two package-manager legs', () => {
  const { desktopProfiles, desktopPnpm } = createDesktopServices(ABS_PROFILE, 'desktop')
  assert.deepEqual(desktopProfiles.current, { name: 'desktop', dir: ABS_PROFILE })
  assert.equal(typeof desktopPnpm.run, 'function', 'low-level pnpm leg present')
  assert.equal(typeof desktopPnpm.runPlugin, 'function', 'dsh CLI plugin leg present')
})

test('desktopPnpm.runPlugin rejects a non-absolute invoking directory synchronously', () => {
  const { desktopPnpm } = createDesktopServices(ABS_PROFILE, 'desktop')
  assert.throws(() => desktopPnpm.runPlugin(['add', 'x'], 'relative', undefined), /absolute path without NUL/)
  assert.throws(() => desktopPnpm.runPlugin(['add', 'x'], `${ABS_PROFILE}\u0000x`, undefined), /absolute path without NUL/)
})
