/**
 * Build the desktop connection client bundle with esbuild: bundle
 * `src/client/entry.ts` (and its imports — the IPC carrier, the pinned
 * controller, and the `@deepseek-ai/dsh-host-apiproxy` modules they reach)
 * into the single self-contained `lib/client.js` that `exports["./client"]`
 * serves to the client module system. Also writes `lib/client.d.ts`, the
 * side-effect-module declaration the client-half tests import the bundle with.
 */

import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(`${root}lib`, { recursive: true })

const result = await build({
  entryPoints: [`${root}src/client/entry.ts`],
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  outfile: `${root}lib/client.js`,
  sourcemap: true,
  logLevel: 'info',
})
if (result.errors.length > 0) process.exit(1)

// The bundle registers through window.__ModuleLoader__ as a side effect; the
// declaration lets TypeScript consumers import lib/client.js (the bundle test).
writeFileSync(`${root}lib/client.d.ts`, [
  '/** Built desktop-connection client bundle: registers the plugin via `window.__ModuleLoader__.load` (side-effect import). */',
  'export {}',
  '',
].join('\n'))
