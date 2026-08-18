#!/usr/bin/env node
/**
 * Build, package, and verify DSH Desktop for one electron-builder target.
 *
 * Runs the pipeline with fail-fast ordering: compile this package (the
 * packaged runtime is the compiled lib/, never sources), compile the
 * workspace connection package (its client bundle is part of the shipped
 * graph), materialize the self-contained payload (dist-pack + dist-host),
 * run electron-builder against electron-builder.yml, then boot the packaged
 * resources/host headlessly. Extra CLI arguments pass through to
 * electron-builder (e.g. `--linux deb` builds a single target, `--x64`
 * selects an architecture).
 * @param args - a target flag (`--dir`, `--mac`, `--win`, `--linux`) plus
 *   any electron-builder arguments.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliArgs = process.argv.slice(2)
if (!cliArgs.some((arg) => arg.startsWith('--'))) {
  console.error('usage: node scripts/dist.mts <--dir|--mac|--win|--linux> [electron-builder args…]')
  process.exit(2)
}

run('pnpm', ['run', 'build'], 'compile the desktop runtime')
run('pnpm', ['--filter', 'dsh-plugin-desktop-connection', 'run', 'build'], 'compile the connection node half + client bundle')
run(process.execPath, [join('scripts', 'materialize.mts')], 'stage the packaged payload')
run(process.execPath, [join('scripts', 'electron-builder.mts'), ...cliArgs], 'run electron-builder')
run(process.execPath, [join('scripts', 'verify-packaged-boot.mts')], 'boot the packaged app headlessly')

/**
 * Run one pipeline step to completion; abort the pipeline on failure.
 * @param command - executable to spawn.
 * @param stepArgs - arguments for the step.
 * @param what - human-readable step description for progress and failure logs.
 */
function run(command: string, stepArgs: string[], what: string): void {
  console.log(`dist: ${what}`)
  // On Windows a bare `pnpm` resolves to the pnpm.cmd shim, which spawnSync
  // cannot launch directly; shell: true lets cmd resolve it. Node on other
  // platforms resolves the binary itself, so the shell stays off there.
  const result = spawnSync(command, stepArgs, {
    cwd: pkgRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    console.error(`dist: step failed (${what}), exit ${String(result.status)}`)
    process.exit(result.status ?? 1)
  }
}
