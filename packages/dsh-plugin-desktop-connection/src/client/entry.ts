/**
 * Bundle entry: registers this package's client half with the DSH client
 * module system. The shell kernel installs `window.__ModuleLoader__` before
 * bundles load; this script hands it the plugin factory, which materializes on
 * demand through the module table. esbuild bundles this file (and every import
 * it reaches) into the single self-contained `lib/client.js` that
 * `exports["./client"]` serves.
 */

import { apply, inject } from './plugin.ts'

window.__ModuleLoader__!.load({
  id: 'dsh-plugin-desktop-connection',
  factory: () => ({ apply, inject }),
})
