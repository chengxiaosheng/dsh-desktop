/**
 * SPA page staging for `file://` loading.
 *
 * The published `@deepseek-ai/dsh-web-frontend` index references
 * server-relative assets (`/assets/...`), which a `file://` page cannot
 * resolve, so the shell stages a rewritten copy in a fresh temp directory
 * before the window loads it. The staged page is disposable: the window owns
 * it and removes the directory when it closes.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { composeDesktopManifest } from './boot-desktop.js'

/** Rewrite server-relative SPA assets to absolute file:// URLs under the dist dir. */
function rewriteAssetUrls(html: string, distDir: string): string {
  return html.replace(/(src|href)="\/(assets\/[^"]+|[^"]*\.(?:webmanifest|svg))"/g, (_m, attr: string, path: string) => {
    return `${attr}="${pathToFileURL(join(distDir, path)).href}"`
  })
}

/** A staged SPA index: the page to load and the directory it owns. */
export interface StagedPage {
  /** Absolute path of the rewritten index.html. */
  path: string
  /** The page's `file://` URL - the one origin `will-navigate` accepts. */
  url: string
  /** Remove the staging directory; idempotent. */
  dispose(): void
}

/**
 * Stage the SPA index of the booted host for `file://` loading.
 * @param ctx - the booted desktop context.
 * @returns the staged page; the caller owns disposal.
 */
export function stageDesktopPage(ctx: Context): StagedPage {
  const { distIndex } = composeDesktopManifest(ctx)
  const distDir = dirname(distIndex)
  const html = rewriteAssetUrls(readFileSync(distIndex, 'utf8'), distDir)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-page-'))
  const path = join(dir, 'index.html')
  writeFileSync(path, html)
  return {
    path,
    url: pathToFileURL(path).href,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}
