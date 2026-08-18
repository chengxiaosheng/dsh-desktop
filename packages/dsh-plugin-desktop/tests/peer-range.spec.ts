/**
 * Unit tests for the minimal semver-range satisfier the plugin-market
 * compatibility gate uses. Focused on the forms peer ranges actually use:
 * caret with prereleases, tilde, comparators, exact and bare-partial versions.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { satisfies } from '../electron/peer-range.ts'

test('satisfies handles exact, comparator, and union ranges', () => {
  assert.equal(satisfies('1.2.3', '1.2.3'), true)
  assert.equal(satisfies('1.2.4', '1.2.3'), false)
  assert.equal(satisfies('1.5.0', '>=1.2.3'), true)
  assert.equal(satisfies('1.2.0', '>=1.2.3'), false)
  assert.equal(satisfies('1.2.0', '<2.0.0'), true)
  assert.equal(satisfies('0.9.0', '1.0.0 || 0.9.x'), true)
  assert.equal(satisfies('2.0.0', '1.0.0 || 0.9.x'), false)
})

test('satisfies handles caret ranges with prereleases (the peer gate shape)', () => {
  // dshmarket peers on @deepseek-ai/dsh-settings ^0.1.0-rc.7
  assert.equal(satisfies('0.1.0-rc.7', '^0.1.0-rc.7'), true, 'closure rc.7 satisfies ^0.1.0-rc.7')
  assert.equal(satisfies('0.1.0-rc.8', '^0.1.0-rc.7'), true, 'newer rc satisfies')
  assert.equal(satisfies('0.1.0-rc.6', '^0.1.0-rc.7'), false, 'older rc fails')
  assert.equal(satisfies('0.1.0', '^0.1.0-rc.7'), true, 'release after rc satisfies')
  assert.equal(satisfies('0.2.0', '^0.1.0-rc.7'), false, 'next minor fails caret')
  assert.equal(satisfies('1.0.0', '^0.1.0-rc.7'), false, 'next major fails caret')
})

test('satisfies handles caret across non-zero majors and tilde', () => {
  assert.equal(satisfies('4.0.1', '^4.0.1'), true)
  assert.equal(satisfies('4.5.0', '^4.0.1'), true)
  assert.equal(satisfies('5.0.0', '^4.0.1'), false)
  assert.equal(satisfies('4.0.2', '~4.0.1'), true)
  assert.equal(satisfies('4.1.0', '~4.0.1'), false)
})

test('satisfies handles bare partial versions and prerelease ordering', () => {
  assert.equal(satisfies('1.5.0', '1'), true)
  assert.equal(satisfies('2.0.0', '1'), false)
  assert.equal(satisfies('1.5.0', '1.2'), false)
  assert.equal(satisfies('1.2.9', '1.2'), true)
  assert.equal(satisfies('0.1.0-rc.7', '0.1.0-rc.6'), false)
  assert.equal(satisfies('0.1.0-rc.6', '0.1.0-rc.7'), false)
})

test('satisfies rejects malformed input gracefully', () => {
  assert.equal(satisfies('not-a-version', '^1.0.0'), false)
  assert.equal(satisfies('1.2.3', 'not-a-range'), false)
})
