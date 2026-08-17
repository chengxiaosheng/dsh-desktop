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
 * registration order. Only the listen step is omitted. The route shapes below
 * mirror the official `WebRoute`/`WebUpgradeRoute`/`Config` declarations (the
 * official module's types are not imported because its `Context.webServer`
 * augmentation would clash with the desktop's `VirtualWebServer`).
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'

/** Route match kind, mirroring the official webServer contract. */
export type WebRouteKind = 'exact' | 'prefix'

/** One named route registration, mirroring the official `WebRoute`. */
export interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** One exact-path HTTP upgrade registration, mirroring the official `WebUpgradeRoute`. */
export interface WebUpgradeRoute {
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns protocol negotiation and the upgraded socket after dispatch. */
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/** Gateway config: the host/port pair the desktop reports (never bound). */
export interface GatewayConfig {
  host: '127.0.0.1' | '0.0.0.0'
  port: number
}

/** Gateway config schema: the host/port pair the desktop reports (never bound). */
export const Config = z.object({
  host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
  port: z.natural().max(65535).required(),
})

/** No hard dependencies; activation is immediate. */
export const inject: string[] = []

/**
 * The socketless `webServer` provider. Registry semantics mirror the official
 * package; only the listen step is omitted.
 */
export class VirtualWebServer extends Service {
  /** Marker proving the interceptor replaced the official socket-bound server. */
  readonly virtual = true
  /** Exact-path route table. */
  readonly exact = new Map<string, WebRoute>()
  /** Prefix route table (longest-prefix wins on match). */
  readonly prefixes = new Map<string, WebRoute>()
  /** Upgrade route table (one protocol owner per path). */
  readonly upgrades = new Map<string, WebUpgradeRoute>()
  /** Index.html transforms, applied in registration order. */
  readonly indexTaps: Array<(html: string) => string> = []
  /** The single fallback-seat owner; undefined until claimed. */
  fallback: WebRoute['handler'] | undefined

  private readonly config: GatewayConfig

  constructor(ctx: Context, config: GatewayConfig) {
    super(ctx, 'webServer')
    this.config = config
  }

  /** The configured (never bound) port. */
  get port(): number {
    return this.config.port
  }

  /** The configured bind host literal. */
  get host(): GatewayConfig['host'] {
    return this.config.host
  }

  /** Always false: this service never owns a listening socket. */
  hasSocket(): boolean {
    return false
  }

  /**
   * Register a named route. Duplicate (kind, path) throws, matching the
   * official contract (route patterns are a composition-level contract).
   * @param route - kind, path, handler.
   * @returns the disposer removing the route.
   */
  register(route: WebRoute): () => void {
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
   * @param route - pathname and handler.
   * @returns the disposer removing the route.
   */
  registerUpgrade(route: WebUpgradeRoute): () => void {
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
   * @param handler - owns the full response lifecycle.
   * @returns the disposer releasing the seat.
   */
  registerFallback(handler: WebRoute['handler']): () => void {
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
   * @param transform - pure html-to-html function.
   * @returns the disposer removing the transform.
   */
  tapIndex(transform: (html: string) => string): () => void {
    this.indexTaps.push(transform)
    return () => {
      const at = this.indexTaps.indexOf(transform)
      if (at !== -1) this.indexTaps.splice(at, 1)
    }
  }

  /**
   * Run an index.html body through the registered taps in registration order.
   * @param html - the raw index.html body.
   * @returns the transformed body.
   */
  applyIndexTaps(html: string): string {
    let out = html
    for (const transform of this.indexTaps) out = transform(out)
    return out
  }

  /** Longest-prefix-wins over the prefix table after an exact-table miss. */
  match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: WebRoute | undefined
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
  async [Service.init](): Promise<void> {
    // No socket: there is nothing to bind or await.
  }
}

export default VirtualWebServer
