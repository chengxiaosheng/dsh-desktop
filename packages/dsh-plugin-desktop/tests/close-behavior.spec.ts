/**
 * Node-half tests for the close-window behavior read path: the fallback
 * contract of `readCloseBehavior` (a broken or absent read must never prevent
 * the window from closing) and the stored-value coercion.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { readCloseBehavior } from '../src/index.ts'

test('readCloseBehavior falls back to quit when no settings provider exists', () => {
  const ctx = new Context()
  assert.deepEqual(readCloseBehavior(ctx), { closeToTray: false })
})

test('readCloseBehavior coerces non-boolean stored values to the quit default', () => {
  const ctx = new Context() as Context & { get: (key: string) => unknown }
  ctx.get = (key: string) => key === 'settings'
    ? { get: () => ({ closeToTray: 'yes' }) }
    : undefined
  assert.deepEqual(readCloseBehavior(ctx), { closeToTray: false })
})

test('readCloseBehavior reads a stored true preference', () => {
  const ctx = new Context() as Context & { get: (key: string) => unknown }
  ctx.get = (key: string) => key === 'settings'
    ? { get: () => ({ closeToTray: true }) }
    : undefined
  assert.deepEqual(readCloseBehavior(ctx), { closeToTray: true })
})
