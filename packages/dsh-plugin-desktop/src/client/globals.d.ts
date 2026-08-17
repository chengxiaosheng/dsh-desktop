/**
 * Global declarations for the desktop renderer surface: the client module
 * loader and the desktop bridge the shell half consumes. Both are exposed by
 * the shell kernel/preload before page scripts run; both are optional because
 * the same sources compile into the bundle that plain-Node tests load.
 */

import type { DesktopBridge } from './plugin.ts'

/** The bundle registration handoff the shell kernel accepts. */
export interface ModuleLoader {
  load(handoff: { id: string; factory: () => unknown }): void
}

declare global {
  interface Window {
    /** The shell kernel's client module loader, installed before bundles load. */
    __ModuleLoader__?: ModuleLoader
    /** The preload-exposed desktop bridge (merges with the connection carrier's declaration). */
    dshDesktop?: DesktopBridge
  }
  var __ModuleLoader__: ModuleLoader | undefined
}
