/**
 * Tests for the desktop virtual-host HTTP bridge (`host-http.ts`).
 *
 * Runs in plain Node with a fake preload bridge, matching the client-half test
 * style: the bridge only touches fetch/Response/URL/Blob/atob, all Node globals.
 * The download-save path stubs `document` and `URL.createObjectURL` so the save
 * gesture is observable without a browser.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeBase64,
  isDesktopHostUrl,
  isVirtualHostUrl,
  patchAnchorClick,
  patchDownloadClicks,
  patchFetch,
  saveVirtualHostDownload,
} from '../src/client/host-http.ts'
import type { DshDesktopBridge } from '../src/client/ipc-api-client.ts'

const EXPORT_URL = 'http://dsh.internal/api/session.export?sessionId=s1&includeDescendants=true'
/** The URL the upstream controller actually builds on the desktop's file:// page. */
const FILE_EXPORT_URL = 'file:///api/session.export?sessionId=s1&includeDescendants=true'

test('isVirtualHostUrl matches the dsh.internal fallback host only', () => {
  assert.equal(isVirtualHostUrl(new URL(EXPORT_URL)), true)
  assert.equal(isVirtualHostUrl(new URL('http://dsh.internal/other')), true)
  assert.equal(isVirtualHostUrl(new URL('https://dsh.internal/x')), false)
  assert.equal(isVirtualHostUrl(new URL('http://example.com/x')), false)
})

test('isDesktopHostUrl matches every file:// request and the virtual host', () => {
  assert.equal(isDesktopHostUrl(new URL(FILE_EXPORT_URL)), true)
  assert.equal(isDesktopHostUrl(new URL(EXPORT_URL)), true)
  // A socketless desktop has no other server: every same-origin file://
  // request (a plugin's `/dsh-market/*` route calls included) is host work.
  assert.equal(isDesktopHostUrl(new URL('file:///dsh-market/status')), true)
  assert.equal(isDesktopHostUrl(new URL('file:///assets/app.js')), true)
  assert.equal(isDesktopHostUrl(new URL('http://example.com/api/x')), false)
})

test('patchFetch routes a virtual-host HEAD probe over the bridge', async () => {
  const requests: unknown[] = []
  const bridge: DshDesktopBridge = {
    invoke: async (request) => {
      requests.push(request)
      return { status: 200, headers: { 'content-type': 'application/zip' }, bodyBase64: '' }
    },
    subscribe: () => () => {},
  }
  const restore = patchFetch(bridge)
  try {
    const response = await fetch(new URL(EXPORT_URL), { method: 'HEAD' })
    assert.equal(response.ok, true)
    assert.equal(response.status, 200)
    assert.deepEqual(requests, [{
      type: 'http-request',
      method: 'HEAD',
      path: '/api/session.export',
      search: '?sessionId=s1&includeDescendants=true',
    }])
  } finally {
    restore()
  }
})

test('patchFetch routes the file:// /api URL the desktop page actually builds', async () => {
  const requests: unknown[] = []
  const bridge: DshDesktopBridge = {
    invoke: async (request) => {
      requests.push(request)
      return { status: 200, headers: { 'content-type': 'application/zip' }, bodyBase64: '' }
    },
    subscribe: () => () => {},
  }
  const restore = patchFetch(bridge)
  try {
    const response = await fetch(new URL(FILE_EXPORT_URL), { method: 'HEAD' })
    assert.equal(response.ok, true)
    assert.deepEqual(requests, [{
      type: 'http-request',
      method: 'HEAD',
      path: '/api/session.export',
      search: '?sessionId=s1&includeDescendants=true',
    }])
  } finally {
    restore()
  }
})

test('patchFetch GET returns the decoded host body', async () => {
  const payload = 'PK\x03\x04fake-zip-bytes'
  const bridge: DshDesktopBridge = {
    invoke: async () => ({ status: 200, headers: { 'content-type': 'application/zip' }, bodyBase64: btoa(payload) }),
    subscribe: () => () => {},
  }
  const restore = patchFetch(bridge)
  try {
    const response = await fetch(new URL(EXPORT_URL))
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert.equal(new TextDecoder().decode(bytes), payload)
  } finally {
    restore()
  }
})

test('patchFetch forwards method, headers, and body for a same-origin POST', async () => {
  const requests: unknown[] = []
  const bridge: DshDesktopBridge = {
    invoke: async (request) => {
      requests.push(request)
      return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, bodyBase64: btoa('{"ok":true}') }
    },
    subscribe: () => () => {},
  }
  const restore = patchFetch(bridge)
  try {
    const response = await fetch(new URL('file:///dsh-market/install'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"url":"https://github.com/x/y"}',
    })
    assert.equal(response.status, 200)
    assert.deepEqual(requests, [{
      type: 'http-request',
      method: 'POST',
      path: '/dsh-market/install',
      search: '',
      headers: { 'content-type': 'application/json' },
      body: '{"url":"https://github.com/x/y"}',
    }])
  } finally {
    restore()
  }
})

test('patchFetch forwards a non-ok status as a Response the caller can read', async () => {
  const bridge: DshDesktopBridge = {
    invoke: async () => ({ status: 400, headers: {}, bodyBase64: btoa('missing or invalid sessionId query parameter') }),
    subscribe: () => () => {},
  }
  const restore = patchFetch(bridge)
  try {
    const response = await fetch(new URL('http://dsh.internal/api/session.export'), { method: 'HEAD' })
    assert.equal(response.status, 400)
    assert.equal(response.ok, false)
    assert.equal(await response.text(), '')
  } finally {
    restore()
  }
})

test('patchFetch rejects an already-aborted virtual-host request', async () => {
  const bridge: DshDesktopBridge = {
    invoke: async () => { throw new Error('must not be invoked after abort') },
    subscribe: () => () => {},
  }
  const restore = patchFetch(bridge)
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      fetch(new URL(EXPORT_URL), { method: 'HEAD', signal: controller.signal }),
      /aborted/i,
    )
  } finally {
    restore()
  }
})

test('patchFetch passes through non-virtual-host requests', async () => {
  let originalCalled = false
  const stub = async (): Promise<Response> => { originalCalled = true; return new Response('ok', { status: 200 }) }
  const real = globalThis.fetch
  globalThis.fetch = stub
  const restore = patchFetch({
    invoke: async () => { throw new Error('bridge must not be invoked for foreign hosts') },
    subscribe: () => () => {},
  })
  try {
    const response = await fetch('https://example.com/x')
    assert.equal(response.status, 200)
    assert.equal(originalCalled, true)
  } finally {
    restore()
    globalThis.fetch = real
  }
})

test('patchFetch disposer restores the original fetch', async () => {
  const real = globalThis.fetch
  const restore = patchFetch({ invoke: async () => ({ status: 200, headers: {}, bodyBase64: '' }), subscribe: () => () => {} })
  assert.notEqual(globalThis.fetch, real, 'fetch patched')
  restore()
  assert.equal(globalThis.fetch, real, 'fetch restored')
})

test('decodeBase64 decodes bytes and an empty string', () => {
  assert.deepEqual(decodeBase64(''), new Uint8Array(0))
  assert.deepEqual(decodeBase64(btoa('hello')), new Uint8Array([104, 101, 108, 108, 111]))
})

test('saveVirtualHostDownload saves the GET body as a blob download', async () => {
  const created: Array<{ href: string; download: string; click: () => void }> = []
  const originalDocument = globalThis.document
  globalThis.document = {
    createElement: (tag: string) => {
      const anchor = { tag, href: '', download: '', click: () => created.push(anchor) }
      return anchor
    },
  } as unknown as Document
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = () => 'blob:test'
  URL.revokeObjectURL = () => {}
  try {
    const requests: unknown[] = []
    const bridge: DshDesktopBridge = {
      invoke: async (request) => {
        requests.push(request)
        return { status: 200, headers: { 'content-type': 'application/zip' }, bodyBase64: btoa('zip') }
      },
      subscribe: () => () => {},
    }
    await saveVirtualHostDownload(bridge, new URL(EXPORT_URL), 'dsh-session-s1.zip')
    assert.deepEqual(requests, [{ type: 'http-request', method: 'GET', path: '/api/session.export', search: '?sessionId=s1&includeDescendants=true' }])
    assert.equal(created.length, 1)
    assert.equal(created[0].href, 'blob:test')
    assert.equal(created[0].download, 'dsh-session-s1.zip')
  } finally {
    globalThis.document = originalDocument
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
  }
})

test('saveVirtualHostDownload rejects on a non-2xx answer', async () => {
  const bridge: DshDesktopBridge = {
    invoke: async () => ({ status: 404, headers: {}, bodyBase64: '' }),
    subscribe: () => () => {},
  }
  await assert.rejects(
    saveVirtualHostDownload(bridge, new URL(EXPORT_URL), 'x.zip'),
    /answered HTTP 404/,
  )
})

/** Install a fake document and invoke the click listener patchDownloadClicks registers. */
function captureClickHandler() {
  const holder: { listener: ((event: MouseEvent) => void) | undefined; capture: boolean } = { listener: undefined, capture: false }
  const originalDocument = globalThis.document
  globalThis.document = {
    addEventListener: (type: string, listener: (event: MouseEvent) => void, capture?: boolean) => {
      holder.listener = listener
      holder.capture = capture === true
    },
    removeEventListener: () => {},
    createElement: () => {
      const anchor = { href: '', download: '', click: () => {} }
      return anchor
    },
  } as unknown as Document
  return { holder, restore: () => { globalThis.document = originalDocument } }
}

test('patchDownloadClicks intercepts virtual-host anchor downloads and prevents navigation', async () => {
  const { holder, restore } = captureClickHandler()
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = () => 'blob:test'
  URL.revokeObjectURL = () => {}
  try {
    const requests: unknown[] = []
    const bridge: DshDesktopBridge = {
      invoke: async (request) => { requests.push(request); return { status: 200, headers: {}, bodyBase64: btoa('zip') } },
      subscribe: () => () => {},
    }
    const remove = patchDownloadClicks(bridge)
    assert.equal(holder.capture, true, 'capture-phase interception')
    let prevented = false
    holder.listener?.({
      target: { href: EXPORT_URL, download: 'dsh-session-s1.zip' },
      preventDefault: () => { prevented = true },
    } as unknown as MouseEvent)
    assert.equal(prevented, true, 'default navigation prevented')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(requests, [{ type: 'http-request', method: 'GET', path: '/api/session.export', search: '?sessionId=s1&includeDescendants=true' }])
    remove()
  } finally {
    restore()
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
  }
})

test('patchDownloadClicks leaves non-virtual-host clicks alone', async () => {
  const { holder, restore } = captureClickHandler()
  try {
    let invoked = false
    const bridge: DshDesktopBridge = {
      invoke: async () => { invoked = true; return { status: 200, headers: {}, bodyBase64: '' } },
      subscribe: () => () => {},
    }
    const remove = patchDownloadClicks(bridge)
    let prevented = false
    holder.listener?.({
      target: { href: 'https://example.com/api/session.export', download: 'x.zip' },
      preventDefault: () => { prevented = true },
    } as unknown as MouseEvent)
    assert.equal(prevented, false)
    assert.equal(invoked, false)
    remove()
  } finally {
    restore()
  }
})

/**
 * Install a fake document plus a fake HTMLAnchorElement prototype so
 * `patchAnchorClick` has something to patch, and stub blob-URL saving.
 */
function captureAnchorEnvironment() {
  const originalDocument = globalThis.document
  const originalAnchorElement = globalThis.HTMLAnchorElement
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = () => 'blob:test'
  URL.revokeObjectURL = () => {}
  globalThis.document = {
    createElement: (tag: string) => {
      const anchor = { tag, href: '', download: '', click: () => {} }
      return anchor
    },
  } as unknown as Document
  const proto: { click(): void } = { click() { throw new Error('native click must not run') } }
  globalThis.HTMLAnchorElement = { prototype: proto } as unknown as typeof HTMLAnchorElement
  return {
    proto,
    restore: () => {
      globalThis.document = originalDocument
      globalThis.HTMLAnchorElement = originalAnchorElement
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
    },
  }
}

test('patchAnchorClick diverts a detached virtual-host anchor click to the bridge', async () => {
  const { proto, restore } = captureAnchorEnvironment()
  try {
    const requests: unknown[] = []
    const bridge: DshDesktopBridge = {
      invoke: async (request) => { requests.push(request); return { status: 200, headers: { 'content-type': 'application/zip' }, bodyBase64: btoa('zip') } },
      subscribe: () => () => {},
    }
    const remove = patchAnchorClick(bridge)
    proto.click.call({ href: FILE_EXPORT_URL, download: 'dsh-session-s1.zip' } as unknown as HTMLAnchorElement)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(requests, [{ type: 'http-request', method: 'GET', path: '/api/session.export', search: '?sessionId=s1&includeDescendants=true' }])
    remove()
  } finally {
    restore()
  }
})

test('patchAnchorClick leaves foreign clicks native and diverts file:// anchors', async () => {
  const { proto, restore } = captureAnchorEnvironment()
  try {
    const nativeCalls: string[] = []
    proto.click = function click(this: { href: string }) { nativeCalls.push(this.href) }
    const invoked: number[] = []
    const bridge: DshDesktopBridge = {
      invoke: async () => { invoked.push(1); return { status: 200, headers: {}, bodyBase64: '' } },
      subscribe: () => () => {},
    }
    const remove = patchAnchorClick(bridge)
    proto.click.call({ href: 'https://example.com/x.zip', download: 'x.zip' })
    proto.click.call({ href: 'file:///assets/app.js', download: 'app.js' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(invoked, [1], 'file:// anchors divert to the bridge')
    assert.deepEqual(nativeCalls, ['https://example.com/x.zip'], 'foreign anchors stay native')
    remove()
  } finally {
    restore()
  }
})
