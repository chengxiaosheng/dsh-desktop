/**
 * Run electron-builder for one packaging target against the repository's
 * `electron-builder.yml`, with code-signing auto-discovery off, so unsigned
 * artifacts build without certificate material. The workspace client bundle
 * is rebuilt before packaging by the calling dist script.
 * @param args - electron-builder CLI arguments (e.g. `--dir`, `--mac`).
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const builderCli = require.resolve('electron-builder/cli.js')
const configPath = join(packageRoot, 'electron-builder.yml')
const cliArgs = process.argv.slice(2)
const args = ['--config', configPath, ...cliArgs]

// Installer targets build on their native host only (`--dir` builds the current
// host's unpacked app anywhere). A foreign host fails fast with a clear reason
// instead of a toolchain error.
const NATIVE_HOST: Record<string, string> = { '--mac': 'darwin', '--win': 'win32', '--linux': 'linux' }
const target = cliArgs.find((arg) => arg.startsWith('--'))
if (target !== undefined && target in NATIVE_HOST && process.platform !== NATIVE_HOST[target]) {
  throw new Error(
    `electron-builder ${target}: ${NATIVE_HOST[target]} artifacts must be built on a native ${NATIVE_HOST[target]} host (current: ${process.platform})`,
  )
}

const result = spawnSync(process.execPath, [builderCli, ...args], {
  cwd: packageRoot,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  stdio: 'inherit',
})
if (result.error !== undefined) throw result.error
if (result.status !== 0) {
  throw new Error(`electron-builder ${args.join(' ')} exited with ${String(result.status)}`)
}
