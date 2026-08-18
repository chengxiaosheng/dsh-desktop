/**
 * PATH bootstrap for desktop package-manager children.
 *
 * A GUI launch (macOS Finder/Dock, Windows Explorer, a Linux desktop menu)
 * does not source the user's shell profile, so the inherited PATH is sparse
 * and user-installed tools — most importantly `pnpm` — are invisible to
 * spawned children even though a terminal finds them. The dshmarket web
 * runtime compensates with its own `spawnEnv()`; the desktop host appends the
 * same well-known bin directories here (plus the nvm / volta / pnpm-setup
 * locations where a user pnpm actually lives), so the `dsh` CLI child's
 * `spawnSync("pnpm")` resolves regardless of how the app was started.
 *
 * Appended directories carry their own runtime where it matters: an nvm node
 * bin holds `node` next to `pnpm`, and a `pnpm setup` shim embeds its node
 * path, so a `#!/usr/bin/env node` shebang still resolves. The list is the
 * well-known user set, not an exhaustive scan; existing PATH entries keep
 * precedence (extras are only appended).
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The static well-known user bin dirs a terminal sources but a GUI launch
 * does not. `/opt/homebrew/bin` and `/usr/local/bin` mirror the dshmarket web
 * runtime's `spawnEnv` candidates; the rest are where a user-installed pnpm
 * actually lands (`pnpm setup`, `npm prefix -g`, volta, nvm).
 * @param home - the user's home directory.
 */
export function userBinDirs(home: string): string[] {
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.local', 'share', 'pnpm'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
  ]
}

/**
 * nvm versioned node bins (`~/.nvm/versions/node/<v>/bin`) that actually hold
 * a `node` and/or `pnpm` executable — a GUI launch never sees them, yet an
 * nvm user's pnpm (and its sibling node for the shebang) live exactly there.
 * @param home - the user's home directory (the nvm root's parent).
 */
export function nvmNodeBins(home: string): string[] {
  const versionsDir = join(home, '.nvm', 'versions', 'node')
  let versions: string[]
  try {
    versions = readdirSync(versionsDir)
  } catch {
    return []
  }
  const bins: string[] = []
  for (const version of versions) {
    if (!version.startsWith('v')) continue
    const dir = join(versionsDir, version, 'bin')
    if (existsSync(join(dir, 'node')) || existsSync(join(dir, 'pnpm'))) bins.push(dir)
  }
  return bins
}

/** Every extra bin dir appended to a spawned child's PATH, deduplicated. */
export function childPathDirs(home: string): string[] {
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const dir of [...userBinDirs(home), ...nvmNodeBins(home)]) {
    if (!seen.has(dir)) {
      seen.add(dir)
      dirs.push(dir)
    }
  }
  return dirs
}

/**
 * Append extra bin dirs to a POSIX PATH, preserving existing entries and their
 * order and dropping empty segments; each extra dir is added once and only if
 * absent, so existing PATH entries keep precedence.
 * @param existing - the inherited PATH (may be empty or undefined).
 * @param extra - the well-known dirs to append.
 */
export function buildChildPath(existing: string | undefined, extra: readonly string[]): string {
  const parts = (existing ?? '').split(':').filter((part) => part !== '')
  for (const dir of extra) {
    if (!parts.includes(dir)) parts.push(dir)
  }
  return parts.join(':')
}
