/**
 * Browser wire client for the desktop surface. This plugin provides
 * `ctx.connection` with the same ConnectionHandle shape as the official
 * `@deepseek-ai/dsh-client-connection` client half, but the carrier is the
 * Electron IPC bridge (`window.dshDesktop`) instead of HTTP/WebSocket. The
 * runtime object layer and every client plugin consuming `ctx.connection` run
 * unchanged.
 */

import { IpcApiClient, createDesktopConnectionRpc } from './ipc-api-client.js'
import { ConnectionController } from './controller.js'
import { patchAnchorClick, patchDownloadClicks, patchFetch } from './host-http.js'

/** Required services (none — this is the wire root). */
export const inject = []

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - client cordis context.
 */
export function apply(ctx) {
  const bridge = globalThis.dshDesktop
  if (bridge === undefined) {
    throw new Error('dsh-plugin-desktop-connection: window.dshDesktop is missing from a desktop composition')
  }
  const api = new IpcApiClient(bridge)
  const rpc = createDesktopConnectionRpc(bridge)
  let started = false
  let description = undefined
  const descriptionListeners = new Set()
  const publishDescription = (next) => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] host-description listener threw:', error)
      }
    }
  }
  const handle = {
    api,
    // The desktop caller is the process itself — trusted by construction.
    isLoopback: true,
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          publishDescription(next)
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') publishDescription(undefined)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller.start()
      return {
        stop: () => {
          controller.stop()
          publishDescription(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)

  // Virtual-host bridge: route the renderer's native host-origin requests (the
  // session-log download) over IPC so the zero-socket desktop answers them.
  ctx.effect(() => patchFetch(bridge), 'desktop-connection: virtual-host fetch bridge')
  ctx.effect(() => patchDownloadClicks(bridge), 'desktop-connection: virtual-host download bridge')
  ctx.effect(() => patchAnchorClick(bridge), 'desktop-connection: virtual-host anchor-click bridge')
}
