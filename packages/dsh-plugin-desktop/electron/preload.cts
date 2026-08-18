// dsh desktop preload: exposes the boot manifest and the desktop IPC bridge to
// the renderer. Runs before the page scripts in the isolated preload world.
// Plain CJS by design (Electron's preload contract, compiled from this .cts
// source by tsc); only contextBridge and ipcRenderer are used, so this works
// under sandbox: true. `require` keeps the file CJS under verbatimModuleSyntax.

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

// The shell reads window.__DSH_BOOT__ at boot; expose the host-composed graph
// (bundle URLs rewritten to absolute file:// paths) before page scripts run.
contextBridge.exposeInMainWorld('__DSH_BOOT__', ipcRenderer.sendSync('dsh:boot-manifest'))

// The desktop connection carrier: unary/respond over invoke, downlink streams
// over the frame channel, virtual-host WebSockets over the ws channels, plus
// the shell preference surface (close-behavior read/write over invoke, tray
// labels one-way).
contextBridge.exposeInMainWorld('dshDesktop', {
  invoke: (request: unknown): Promise<unknown> => ipcRenderer.invoke('dsh:invoke', request),
  subscribe: (channel: unknown, listener: (message: unknown) => void): (() => void) => {
    const cb = (_event: Electron.IpcRendererEvent, frameChannel: unknown, message: unknown): void => {
      if (frameChannel === channel) listener(message)
    }
    ipcRenderer.on('dsh:frame', cb)
    ipcRenderer.send('dsh:subscribe', channel)
    return () => {
      ipcRenderer.removeListener('dsh:frame', cb)
      ipcRenderer.send('dsh:unsubscribe', channel)
    }
  },
  wsOpen: (request: unknown): Promise<unknown> => ipcRenderer.invoke('dsh:ws-open', request),
  wsSend: (socketId: unknown, data: unknown, binary: unknown): void => {
    ipcRenderer.send('dsh:ws-send', { socketId, data, binary })
  },
  wsClose: (socketId: unknown, code: unknown, reason: unknown): void => {
    ipcRenderer.send('dsh:ws-close', { socketId, code, reason })
  },
  onWsEvent: (listener: (event: unknown) => void): (() => void) => {
    const cb = (_event: Electron.IpcRendererEvent, message: unknown): void => listener(message)
    ipcRenderer.on('dsh:ws-event', cb)
    return () => ipcRenderer.removeListener('dsh:ws-event', cb)
  },
  getCloseBehavior: (): Promise<unknown> => ipcRenderer.invoke('dsh:close-behavior', { type: 'read' }),
  setCloseBehavior: (value: unknown): Promise<unknown> => ipcRenderer.invoke('dsh:close-behavior', { type: 'write', value }),
  sendLocale: (labels: unknown): void => { ipcRenderer.send('dsh:locale', labels) },
  rebootHost: (): Promise<unknown> => ipcRenderer.invoke('dsh:reboot-host'),
  getMarketVersion: (): Promise<unknown> => ipcRenderer.invoke('dsh:market-version', { type: 'read' }),
  updateMarket: (version: unknown): Promise<unknown> => ipcRenderer.invoke('dsh:market-version', { type: 'update', version }),
  rollbackMarket: (): Promise<unknown> => ipcRenderer.invoke('dsh:market-version', { type: 'rollback' }),
})
