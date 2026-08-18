/**
 * Resolve the desktop package root from the current module location.
 *
 * The module lives at different depths per layout — `electron/` in the source
 * tree and the packaged host, `lib/electron/` in the compiled workspace runtime
 * — so the package root is the nearest ancestor carrying `package.json`, never
 * a fixed relative hop. Shared by the boot helper and the desktop host
 * services so both anchor their `createRequire` resolution to the same install.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The package root this module runs from: the nearest ancestor directory
 * carrying `package.json` - `electron/` in the source tree, `lib/electron/`
 * in the compiled workspace runtime, `resources/host/electron/` in the
 * packaged app.
 * @returns absolute package-root directory.
 * @throws when no `package.json` exists above this module.
 */
export function resolvePackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`dsh-desktop: no package.json above ${import.meta.url}`)
    dir = parent
  }
}
