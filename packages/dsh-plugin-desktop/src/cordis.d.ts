/**
 * Cordis `Context` augmentation for the desktop host: the services the desktop
 * rows and the Electron main read. `connection` is intentionally absent — the
 * official `@deepseek-ai/dsh-client-connection` node-half types already declare
 * it (as the host `HostConnectionHandle`), and a second declaration would
 * clash. `loader` is likewise left to the loader plugin's runtime.
 */

import type { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { VirtualWebServer } from './webserver.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The socketless webServer provider this package mounts. */
    webServer: VirtualWebServer
    /** The official modules registry, mounting unchanged against the virtual webServer. */
    clientModules: ClientModuleRegistry
    /** The gateway apiProxy the desktop dispatch legs read. */
    apiProxy: ApiProxy
    /** The agent-preset roster service (system-trust shipped root included). */
    agentPresets: AgentPresets
  }
}

export {}
