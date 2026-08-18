/**
 * Ambient types for the `ws` package surface the WebSocket bridge tests use.
 *
 * `ws` ships no bundled types, and the repo's nodenext resolution does not
 * consult `@types/ws` through pnpm's symlinked node_modules, so the test's
 * `WebSocketServer({ noServer: true })` stand-in (the exact pattern
 * dsh-better-sidebar uses) declares its own minimal surface here. Only the
 * members the test exercises are declared.
 */

declare module 'ws' {
  export class WebSocketServer {
    constructor(options: { noServer?: boolean })
    handleUpgrade(
      req: unknown,
      socket: unknown,
      head: unknown,
      callback: (ws: WebSocket) => void,
    ): void
    close(callback?: () => void): void
  }

  export class WebSocket {
    static readonly CONNECTING: number
    static readonly OPEN: number
    static readonly CLOSING: number
    static readonly CLOSED: number
    readonly readyState: number
    send(data: string | Buffer, options?: { binary?: boolean }): void
    close(code?: number, reason?: string): void
    on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): void
    on(event: 'close', listener: (code: number, reason: Buffer) => void): void
    on(event: 'error', listener: (error: Error) => void): void
  }
}
