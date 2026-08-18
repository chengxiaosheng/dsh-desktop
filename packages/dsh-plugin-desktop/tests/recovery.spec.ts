/**
 * Boot-recovery tests: a broken profile install (a bundle whose patch
 * references a package that is not installed) must not hard-fail the whole
 * tree — `bootDesktop` drops the unloadable bundle, persists the removal, and
 * boots the rest.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { healProfilesModuleFallback, initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { bootDesktop } from '../electron/boot-desktop.ts'

const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPO_ROOT = join(PKG_ROOT, '..', '..')
const HOME = join(REPO_ROOT, '.tmp-home', 'recovery')
const PROFILE = join(HOME, 'profiles', 'desktop')
process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })

after(() => rmSync(HOME, { recursive: true, force: true }))

/** Seed a profile whose bundle patch references a package that is not installed. */
function seedBrokenBundle(): void {
  initProfile(PROFILE, PROFILE_TEMPLATES.web)
  healProfilesModuleFallback(join(PKG_ROOT, 'package.json'), HOME)
  const bundleDir = join(PROFILE, 'node_modules', '@fake', 'broken-bundle')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: '@fake/broken-bundle', version: '1.0.0', type: 'module',
    exports: { '.': './index.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(bundleDir, 'index.js'), "export const name = 'broken-bundle'\n")
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), "- insert:\n    - id: broken\n      name: '@fake/not-installed'\n")
  const manifestPath = join(PROFILE, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
  manifest.dsh.profile.bundles = [...manifest.dsh.profile.bundles, '@fake/broken-bundle']
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

test('boot recovery drops a bundle whose patch references a missing package', async () => {
  seedBrokenBundle()
  const ctx = await bootDesktop(HOME)
  try {
    const loader = ctx.get('loader') as { entries(): Iterable<{ options?: { id?: string } }> } | undefined
    const ids = [...(loader?.entries?.() ?? [])].map(entry => entry.options?.id).filter(Boolean)
    assert.ok(!ids.includes('broken'), 'broken row is not mounted')
    assert.ok(ids.includes('desktop-shell'), 'the desktop rows still mount')
    const manifest = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    assert.ok(!manifest.dsh.profile.bundles.includes('@fake/broken-bundle'), 'broken bundle pruned from the manifest')
  } finally {
    await ctx.fiber.dispose()
  }
})
