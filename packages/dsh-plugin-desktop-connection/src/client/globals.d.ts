/**
 * Global declarations for the desktop renderer surface: the preload bridge and
 * the client module loader. The Electron main exposes both before page scripts
 * run (the desktop package's `electron/preload.cts`); both are optional because
 * the same sources compile into the bundle that plain-Node tests load.
 */

import type { DshDesktopBridge } from './ipc-api-client.ts'

declare global {
  interface Window {
    /** Preload-exposed desktop bridge; absent outside an Electron page. */
    dshDesktop?: DshDesktopBridge
    /** The shell kernel's client module loader, installed before bundles load. */
    __ModuleLoader__?: ModuleLoader
  }
  var dshDesktop: DshDesktopBridge | undefined
  var __ModuleLoader__: ModuleLoader | undefined
}

/** The bundle registration handoff the shell kernel accepts. */
export interface ModuleLoader {
  load(handoff: { id: string; factory: () => unknown }): void
}
