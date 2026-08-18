/**
 * Desktop virtual-host HTTP bridge.
 *
 * The official connection client and the `session-log-export` download controller
 * resolve their host base as `location.origin`, falling back to
 * `http://dsh.internal` when the page has a null origin. On the desktop's
 * `file://` page Electron's Chromium reports `location.origin` as `"file://"` —
 * not the string `"null"` — so the fallback never triggers and host-relative
 * requests build `file:///api/...` URLs. Neither host has an HTTP server in the
 * zero-socket desktop: a native `fetch` to either rejects with "Failed to
 * fetch" and an anchor download to them would navigate the SPA away. This module
 * routes every such request over the preload IPC bridge instead: `patchFetch`
 * forwards the full request (method, headers, body) to the main, which
 * dispatches it against the webserver route registry in-process — the
 * session-log download surface (`/api/session.export`) and every plugin's
 * routes (`/dsh-market/*`, …) alike, with no per-plugin bridge. The
 * download helpers convert the follow-up anchor download into a GET over the
 * bridge saved through a Blob URL.
 */

import type { DshDesktopBridge } from './ipc-api-client.ts'

/**
 * The host the official connection client targets on a null-origin page
 * (`INTERNAL_BASE` in the upstream `AbstractApiClient` / session-log controller).
 */
export const VIRTUAL_HOST = 'dsh.internal'

/** Whether a URL targets the desktop's virtual host. */
export function isVirtualHostUrl(url: URL): boolean {
  return url.protocol === 'http:' && url.hostname === VIRTUAL_HOST
}

/**
 * Whether a URL targets the desktop's in-process host surface: any `file://`
 * request (the SPA origin — a socketless desktop has no other server, so every
 * same-origin relative fetch, e.g. a plugin's `/dsh-market/...` route calls, is
 * host work) or the upstream virtual-host fallback. Absolute `https://` URLs
 * (external images, CDNs) keep native fetch.
 */
export function isDesktopHostUrl(url: URL): boolean {
  return url.protocol === 'file:' || isVirtualHostUrl(url)
}

/**
 * One raw host HTTP request carried over the preload bridge: the method, path,
 * search, the observed request headers, and the UTF-8 body when one was
 * supplied. The main dispatches it against the full webserver route registry.
 */
function httpRequest(
  url: URL,
  method: string,
  headers: Record<string, string> | undefined,
  body: string | undefined,
): { type: 'http-request'; method: string; path: string; search: string; headers?: Record<string, string>; body?: string } {
  const message: { type: 'http-request'; method: string; path: string; search: string; headers?: Record<string, string>; body?: string } = {
    type: 'http-request',
    method,
    path: url.pathname,
    search: url.search,
  }
  if (headers !== undefined && Object.keys(headers).length > 0) message.headers = headers
  if (body !== undefined && body !== '') message.body = body
  return message
}

/**
 * The raw host HTTP response envelope the Electron main answers a
 * `{ type: 'http-request' }` bridge message with (`dispatchHttpRequest` in the
 * desktop package's `electron/boot-desktop.ts`).
 */
export interface HttpBridgeResponse {
  status: number
  headers?: Record<string, string>
  bodyBase64?: string
}

/**
 * Resolve a fetch input to a URL. Returns undefined when the input is relative
 * and the environment has no location base, so the caller can pass through.
 */
function urlOf(input: RequestInfo | URL): URL | undefined {
  if (input instanceof URL) return new URL(input.href)
  if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url)
  const base = globalThis.location?.href
  return typeof base === 'string' ? new URL(input as string, base) : undefined
}

/**
 * Patch `globalThis.fetch` so virtual-host requests dispatch over IPC.
 * @param bridge - preload bridge.
 * @returns disposer restoring the original fetch.
 */
export function patchFetch(bridge: DshDesktopBridge): () => void {
  const original = globalThis.fetch
  if (typeof original !== 'function') return () => {}
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input)
    if (url === undefined || !isDesktopHostUrl(url)) return original(input, init)
    if (init?.signal?.aborted) {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      throw error
    }
    const requestLike = typeof Request !== 'undefined' && input instanceof Request ? input : undefined
    const method = (init?.method ?? requestLike?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    const headerSource = init?.headers ?? requestLike?.headers
    if (headerSource instanceof Headers) {
      headerSource.forEach((value, key) => { headers[key] = value })
    } else if (Array.isArray(headerSource)) {
      for (const [key, value] of headerSource) headers[key] = value
    } else if (typeof headerSource === 'object' && headerSource !== null) {
      Object.assign(headers, headerSource)
    }
    let body: string | undefined
    const bodySource = init?.body ?? requestLike?.body
    if (bodySource !== undefined && bodySource !== null) {
      // A function-bodied fetch (a stream factory) cannot travel over the
      // bridge — let it hit the original (which rejects on a socketless host).
      if (typeof bodySource === 'function') return original(input, init)
      body = await new Response(bodySource as BodyInit).text()
    }
    const response = await bridge.invoke(httpRequest(url, method, headers, body)) as HttpBridgeResponse
    const responseHeaders = new Headers(response.headers ?? {})
    if (method === 'HEAD') return new Response(null, { status: response.status, headers: responseHeaders })
    return new Response(decodeBase64(response.bodyBase64 ?? ''), { status: response.status, headers: responseHeaders })
  }
  return () => { globalThis.fetch = original }
}

/**
 * Save one virtual-host GET response as a browser download.
 * @param bridge - preload bridge.
 * @param url - virtual-host URL to download.
 * @param filename - browser download filename.
 */
export async function saveVirtualHostDownload(bridge: DshDesktopBridge, url: URL, filename: string): Promise<void> {
  const response = await bridge.invoke(httpRequest(url, 'GET', undefined, undefined)) as HttpBridgeResponse
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`virtual host ${url.pathname} answered HTTP ${response.status}`)
  }
  const type = typeof response.headers?.['content-type'] === 'string'
    ? response.headers['content-type']
    : 'application/octet-stream'
  const blob = new Blob([decodeBase64(response.bodyBase64 ?? '')], { type })
  const objectUrl = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    anchor.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
  }
}

/** Resolve an anchor's download filename, falling back to its path when bare. */
function downloadFilename(anchor: HTMLAnchorElement, url: URL): string {
  return typeof anchor.download === 'string' && anchor.download !== ''
    ? anchor.download
    : `download${url.pathname.replace(/\//g, '-')}`
}

/**
 * Intercept a programmatic anchor click that targets the desktop host surface
 * and save the target instead. The `session-log-export` controller hands its
 * URL to a **detached** anchor (never in the DOM), so its click event never
 * reaches a `document` listener — only the prototype method observes it.
 * @param bridge - preload bridge.
 * @param anchor - the anchor being clicked.
 * @returns whether the click targeted the desktop host and was diverted.
 */
function interceptAnchorClick(bridge: DshDesktopBridge, anchor: HTMLAnchorElement): boolean {
  if (anchor?.href === undefined) return false
  let url: URL
  try {
    url = new URL(anchor.href)
  } catch {
    return false
  }
  if (!isDesktopHostUrl(url)) return false
  void saveVirtualHostDownload(bridge, url, downloadFilename(anchor, url)).catch((error) => {
    console.error('[desktop-connection] virtual-host download failed:', error)
  })
  return true
}

/**
 * Patch `HTMLAnchorElement.prototype.click` so programmatic downloads targeting
 * the desktop host surface dispatch over the bridge instead of navigating or
 * fetching a nonexistent host. Only virtual-host anchors are diverted; every
 * other click keeps its native behavior.
 * @param bridge - preload bridge.
 * @returns disposer restoring the original method.
 */
export function patchAnchorClick(bridge: DshDesktopBridge): () => void {
  const proto = globalThis.HTMLAnchorElement?.prototype
  if (proto === undefined || typeof proto.click !== 'function') return () => {}
  const original = proto.click
  proto.click = function click(this: HTMLAnchorElement): void {
    if (interceptAnchorClick(bridge, this)) return
    original.call(this)
  }
  return () => { proto.click = original }
}

/**
 * Intercept anchor clicks that would navigate to the virtual host and save the
 * target instead, so a cross-origin download (the `download` attribute is
 * ignored off same-origin) never navigates the SPA away. Companion to
 * `patchAnchorClick`, which catches the controller's detached-anchor clicks;
 * this catches user clicks on anchors already in the DOM.
 * @param bridge - preload bridge.
 * @returns disposer removing the listener.
 */
export function patchDownloadClicks(bridge: DshDesktopBridge): () => void {
  const doc = globalThis.document
  if (doc?.addEventListener === undefined) return () => {}
  const onCapturedClick = (event: MouseEvent): void => {
    const target = event.target
    if (target === null || !('href' in target)) return
    const anchor = target as HTMLAnchorElement
    let url: URL
    try {
      url = new URL(anchor.href)
    } catch {
      return
    }
    if (!isDesktopHostUrl(url)) return
    event.preventDefault()
    void saveVirtualHostDownload(bridge, url, downloadFilename(anchor, url)).catch((error) => {
      console.error('[desktop-connection] virtual-host download failed:', error)
    })
  }
  doc.addEventListener('click', onCapturedClick, true)
  return () => doc.removeEventListener('click', onCapturedClick, true)
}

/** Decode a base64 string into bytes. */
export function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  if (base64 === '') return new Uint8Array(0)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
