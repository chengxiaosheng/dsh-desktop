/**
 * @module dsh-plugin-desktop-connection
 *
 * The desktop `connection` row. The node half re-exports the official
 * `@deepseek-ai/dsh-client-connection` apply unchanged, so the host-side
 * `HostConnectionService`, the `/api` route, and the two downlink registrations
 * behave exactly as the web profile's. The client half (built to
 * `lib/client.js`, declared by `dsh.client`) provides `ctx.connection` over the
 * Electron IPC bridge instead of HTTP/WebSocket.
 *
 * The row replacement matters because Cordis rejects two plugins providing the
 * same service in one scope (`service "connection" has been registered`), so a
 * desktop carrier cannot coexist with the official client half — it must
 * replace the row, and only the desktop package may declare `dsh.client`.
 */

export * from '@deepseek-ai/dsh-client-connection'
