/**
 * Build the desktop connection client bundle with esbuild: bundle
 * `src/client/entry.js` (and its imports — the IPC carrier, the pinned
 * controller, and the `@deepseek-ai/dsh-host-apiproxy` modules they reach)
 * into the single self-contained `lib/client.js` that `exports["./client"]`
 * serves to the client module system.
 */

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(`${root}lib`, { recursive: true })

const result = await build({
  entryPoints: [`${root}src/client/entry.js`],
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  outfile: `${root}lib/client.js`,
  sourcemap: true,
  logLevel: 'info',
})
if (result.errors.length > 0) process.exit(1)
