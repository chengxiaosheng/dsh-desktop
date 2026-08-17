/**
 * @module dsh-plugin-desktop/webserver
 *
 * Virtual (socketless) `webServer` service — the desktop "interceptor".
 *
 * This plugin provides the exact route-registry contract the official
 * `@deepseek-ai/dsh-host-webserver` exposes (`register`, `registerUpgrade`,
 * `registerFallback`, `tapIndex`, `applyIndexTaps`, `host`, `port`) but never
 * binds a node:http socket. The desktop composition disables the official
 * `webserver` row and mounts this row instead, so the official `connection`
 * and `modules` rows activate unchanged against it while the desktop transport
 * dispatches requests in-process over IPC rather than a loopback socket.
 *
 * The registry semantics mirror the official package so the contract stays
 * identical: duplicate (kind, path) routes throw, prefix routes win by
 * longest-match, the fallback seat has a single owner, and index taps apply in
 * registration order. Only the listen step is omitted.
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Gateway config: the host/port pair the desktop reports (never bound). */
export const Config = z.object({
  host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
  port: z.natural().max(65535).required(),
})

/** No hard dependencies; activation is immediate. */
export const inject = []

/** Route match kind, mirroring the official webServer contract. */
export class VirtualWebServer extends Service {
  constructor(ctx, config) {
    super(ctx, 'webServer')
    this.config = config
    /** @type {Map<string, {kind:'exact', path:string, handler:Function}>} */
    this.exact = new Map()
    /** @type {Map<string, {kind:'prefix', path:string, handler:Function}>} */
    this.prefixes = new Map()
    /** @type {Map<string, {path:string, handler:Function}>} */
    this.upgrades = new Map()
    /** @type {((html:string)=>string)[]} */
    this.indexTaps = []
    /** @type {Function|undefined} */
    this.fallback = undefined
    // Marker proving the interceptor replaced the official socket-bound server.
    this.virtual = true
  }

  /** The configured (never bound) port. */
  get port() {
    return this.config.port
  }

  /** The configured bind host literal. */
  get host() {
    return this.config.host
  }

  /** Always false: this service never owns a listening socket. */
  hasSocket() {
    return false
  }

  /**
   * Register a named route. Duplicate (kind, path) throws, matching the
   * official contract (route patterns are a composition-level contract).
   * @param {object} route - kind, path, handler.
   * @returns {() => void} the disposer removing the route.
   */
  register(route) {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    }
    table.set(route.path, route)
    return () => {
      table.delete(route.path)
    }
  }

  /**
   * Register an exact-path HTTP upgrade route. Duplicate paths throw because
   * one socket can have only one protocol owner.
   * @param {object} route - pathname and handler.
   * @returns {() => void} the disposer removing the route.
   */
  registerUpgrade(route) {
    if (this.upgrades.has(route.path)) {
      throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    }
    this.upgrades.set(route.path, route)
    return () => {
      this.upgrades.delete(route.path)
    }
  }

  /**
   * Claim the fallback seat: the handler answering every request no named
   * route matches. One owner only — a second registration throws.
   * @param {Function} handler - owns the full response lifecycle.
   * @returns {() => void} the disposer releasing the seat.
   */
  registerFallback(handler) {
    if (this.fallback !== undefined) {
      throw new Error('webserver: fallback already registered')
    }
    this.fallback = handler
    return () => {
      this.fallback = undefined
    }
  }

  /**
   * Register an index.html transform, applied by the fallback owner in
   * registration order.
   * @param {(html:string)=>string} transform - pure html-to-html function.
   * @returns {() => void} the disposer removing the transform.
   */
  tapIndex(transform) {
    this.indexTaps.push(transform)
    return () => {
      const at = this.indexTaps.indexOf(transform)
      if (at !== -1) this.indexTaps.splice(at, 1)
    }
  }

  /**
   * Run an index.html body through the registered taps in registration order.
   * @param {string} html - the raw index.html body.
   * @returns {string} the transformed body.
   */
  applyIndexTaps(html) {
    let out = html
    for (const transform of this.indexTaps) out = transform(out)
    return out
  }

  /** Longest-prefix-wins over the prefix table after an exact-table miss. */
  match(pathname) {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  /**
   * Initialize the service. The official server binds here; the virtual server
   * intentionally does nothing — the desktop transport dispatches in-process.
   */
  async [Service.init]() {
    // No socket: there is nothing to bind or await.
  }
}

export default VirtualWebServer
