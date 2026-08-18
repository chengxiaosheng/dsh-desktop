/**
 * Permission-request policy for the desktop main window.
 *
 * The SPA's chat UI writes the system clipboard through `navigator.clipboard`
 * (`@deepseek-ai/dsh-client-ui-primitives` `writeClipboard`, used by the
 * message/JSON/hover-card copy buttons). Chromium routes that sanitized write
 * through a `clipboard-sanitized-write` permission request, and Electron
 * consults the window's `setPermissionRequestHandler` for it — so the
 * deny-everything policy would make every copy button a silent no-op. This
 * predicate is the whole policy; it lives outside `window.ts` so it is
 * headless-testable.
 */

/**
 * Whether a webContents permission request is one the SPA may have.
 *
 * Electron 43 surfaces exactly one clipboard-write request name —
 * `clipboard-sanitized-write`, emitted by `navigator.clipboard.writeText` /
 * `write` for sanitized writes (the unsanitized write path surfaces as
 * `clipboard-read`, which is denied). Every other permission (camera,
 * microphone, notifications, geolocation, …) is denied.
 * @param permission - the permission name Electron reports for the request.
 * @returns true only for the clipboard-write request the UI needs.
 */
export function isGrantedPermission(permission: string): boolean {
  return permission === 'clipboard-sanitized-write'
}
