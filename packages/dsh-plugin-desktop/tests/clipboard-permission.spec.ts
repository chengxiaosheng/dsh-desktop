/**
 * Headless test for the desktop main-window permission-request policy.
 *
 * The chat copy buttons write the clipboard through `navigator.clipboard`,
 * which issues a `clipboard-sanitized-write` permission request; the window's
 * `setPermissionRequestHandler` must grant that one and deny every other.
 * Runs in plain Node — `permissions.ts` imports no Electron.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isGrantedPermission } from '../electron/permissions.ts'

test('the desktop grants clipboard write and denies every other permission request', () => {
  assert.equal(isGrantedPermission('clipboard-sanitized-write'), true, 'plain-text copy writes are granted')
  for (const denied of [
    'clipboard-read',
    'clipboard-write',
    'geolocation',
    'media',
    'mediaKeySystem',
    'midi',
    'notifications',
    'pointerLock',
    'fullscreen',
    'openExternal',
    'display-capture',
    'unknown',
  ]) {
    assert.equal(isGrantedPermission(denied), false, `${denied} is denied`)
  }
})
