/**
 * Verify the pinned ConnectionController copy matches the installed upstream
 * family. `pnpm install` resolves the `@deepseek-ai/*` family from the dist-tags
 * recorded in `upstream.json` (`next` for the dsh family, `latest` for the
 * cordis framework) with no committed lockfile, so the family can float past
 * the version the pinned copy was taken from. This script compares the
 * installed `@deepseek-ai/dsh-client-connection` version against
 * `upstream.json`'s `version` and fails with reapply instructions on mismatch,
 * so a drifted copy cannot ship silently.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const upstream = JSON.parse(readFileSync(`${root}upstream.json`, 'utf8')) as {
  repository: string
  version: string
  sourcePath: string
}

const require = createRequire(import.meta.url)
let installedVersion: string
try {
  const pkg = require.resolve('@deepseek-ai/dsh-client-connection/package.json')
  installedVersion = JSON.parse(readFileSync(pkg, 'utf8')).version as string
} catch {
  console.error('verify-upstream: cannot resolve @deepseek-ai/dsh-client-connection (run pnpm install first)')
  process.exit(1)
}

if (installedVersion === upstream.version) {
  console.log(`verify-upstream: installed @deepseek-ai/dsh-client-connection ${installedVersion} matches the pinned copy (${upstream.version})`)
} else {
  console.error(`verify-upstream: installed @deepseek-ai/dsh-client-connection ${installedVersion} differs from the pinned ConnectionController copy (${upstream.version})`)
  console.error(`Reapply: fetch ${upstream.repository} at the commit for ${installedVersion}, copy ${upstream.sourcePath} into src/client/controller.ts (rewriting its './api.ts' import to '@deepseek-ai/dsh-host-apiproxy/api' and spelling the constructor's parameter properties as explicit fields), then set upstream.json version/commit.`)
  process.exit(1)
}
