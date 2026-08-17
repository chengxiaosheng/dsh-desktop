/** Add every published-bundle row package missing from dsh-plugin-desktop deps. Pure fs. */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const pkgPath = join(root, 'packages/dsh-plugin-desktop/package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const deps = pkg.dependencies

function bundlePatchFiles(packageName) {
  const enc = packageName.replace(/\//g, '+')
  const results = []
  for (const dir of readdirSync(join(root, 'node_modules/.pnpm'))) {
    if (!dir.startsWith(`${enc}@`)) continue
    const patch = join(root, 'node_modules/.pnpm', dir, 'node_modules', packageName, 'cordis.patch.yml')
    try {
      results.push(readFileSync(patch, 'utf8'))
    } catch {
      // some store entries may not have the patch at this exact layout
    }
  }
  return results
}

const names = new Set()
for (const bundle of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
  for (const txt of bundlePatchFiles(bundle)) {
    for (const m of txt.matchAll(/^\s*name:\s*(.+)$/gm)) {
      names.add(m[1].trim().replace(/^['"]|['"]$/g, ''))
    }
  }
}

function installedVersion(packageName) {
  const enc = packageName.replace(/\//g, '+')
  const dir = readdirSync(join(root, 'node_modules/.pnpm')).find(d => d.startsWith(`${enc}@`))
  if (!dir) return undefined
  return dir.slice(enc.length + 1).split('_')[0]
}

const added = {}
for (const n of [...names].sort()) {
  if (Object.hasOwn(deps, n)) continue
  // Scoped packages carry exactly one '/' (the scope delimiter); skip subpath
  // exports (e.g. `@deepseek-ai/dsh-web-app/startup`) whose parent is added
  // separately.
  if (n.split('/').length !== 2) continue
  added[n] = installedVersion(n) ?? '0.1.0-rc.6'
}
Object.assign(deps, added)
const sorted = {}
for (const k of Object.keys(deps).sort()) sorted[k] = deps[k]
pkg.dependencies = sorted
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

const check = JSON.parse(readFileSync(pkgPath, 'utf8')).dependencies
const stillMissing = [...names].filter(n => !n.includes('/') && !Object.hasOwn(check, n))
console.log(`row names: ${names.size}; added ${Object.keys(added).length}; still missing: ${stillMissing.length}`)
for (const [k, v] of Object.entries(added)) console.log(`  ${k} ${v}`)
