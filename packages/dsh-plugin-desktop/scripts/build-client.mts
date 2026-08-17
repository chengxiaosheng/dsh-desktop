#!/usr/bin/env node
/**
 * Build the desktop shell client bundle with esbuild: bundle
 * `src/client/plugin.ts` (and its imports — the settings row, the locale
 * dictionaries, the preference policy) into the single self-contained
 * `lib/client.js` that `exports["./client"]` serves to the client module
 * system. Also writes `lib/client.d.ts`, the side-effect-module declaration
 * the client-half tests import the bundle with.
 *
 * The artifact matches the upstream client-bundle shape: the whole module
 * body lives inside the `window.__ModuleLoader__.load({ id, factory })`
 * handoff, and cross-package imports stay as `require(...)` calls resolved by
 * the module loader at runtime. `react`/`react/jsx-runtime` must be the
 * renderer's own instances (hooks), `dsh-client-ui-primitives` follows the
 * upstream external set, and `dsh-client-runtime/client` is itself a loader
 * bundle that cannot be inlined. esbuild's CJS output is wrapped in the
 * factory with `module`/`exports` shims so those requires resolve through the
 * loader's synchronous `require`.
 *
 * CSS modules are inlined like the upstream client artifacts: each
 * `*.module.css` becomes a hashed class map plus a guarded `<style>`-tag
 * injection (skipped when `document` is absent, so plain-Node bundle tests
 * load cleanly).
 */

import { build, type Plugin } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkgName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name as string
const outfile = join(root, 'lib/client.js')
mkdirSync(join(root, 'lib'), { recursive: true })

/** Deterministic 6-char content hash (FNV-1a, base-36) for CSS class names. */
function hashSource(source: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(0, 6)
}

/** Load `*.module.css` as a JS module: hashed class map + style-tag injection. */
const cssModuleLoader: Plugin = {
  name: 'css-module',
  setup(build) {
    build.onLoad({ filter: /\.module\.css$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8')
      const hash = hashSource(source)
      const classMap: Record<string, string> = {}
      const names = new Set<string>()
      for (const match of source.matchAll(/\.([A-Za-z_][\w-]*)\s*\{/g)) names.add(match[1])
      let css = source
      for (const name of names) {
        const hashed = `${hash}_${name}`
        classMap[name] = hashed
        css = css.replaceAll(`.${name}`, `.${hashed}`)
      }
      const tagId = `${pkgName}/${args.path.split('/').pop()}`
      const contents = [
        `const css = ${JSON.stringify(css)};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
        '  const tag = document.createElement("style");',
        `  tag.dataset.plugin = ${JSON.stringify(pkgName)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
      return { contents, loader: 'js' }
    })
  },
}

const result = await build({
  entryPoints: [join(root, 'src/client/plugin.ts')],
  bundle: true,
  format: 'cjs',
  target: ['chrome120'],
  outfile,
  sourcemap: true,
  logLevel: 'info',
  external: [
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-runtime/client',
  ],
  plugins: [cssModuleLoader],
})
if (result.errors.length > 0) process.exit(1)

// Wrap the CJS output in the loader factory: the whole module body — CSS
// injection included — runs inside `factory(require)`, and the loader's
// synchronous require answers the externals above.
const cjs = readFileSync(outfile, 'utf8')
const wrapped = [
  `window.__ModuleLoader__.load({`,
  `  id: ${JSON.stringify(pkgName)},`,
  `  factory: (require) => {`,
  `    const module = { exports: {} };`,
  `    const exports = module.exports;`,
  cjs,
  `    return module.exports;`,
  `  },`,
  `});`,
].join('\n')
writeFileSync(outfile, wrapped)

// The bundle registers through window.__ModuleLoader__ as a side effect; the
// declaration lets TypeScript consumers import lib/client.js (the bundle test).
writeFileSync(join(root, 'lib/client.d.ts'), [
  '/** Built desktop client bundle: registers the plugin via `window.__ModuleLoader__.load` (side-effect import). */',
  'export {}',
  '',
].join('\n'))

console.log(`desktop-client: src/client/plugin.ts -> lib/client.js (${pkgName})`)
