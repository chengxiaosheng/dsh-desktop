// dsh desktop preload: exposes the boot manifest and the desktop IPC bridge to
// the renderer. Runs before the page scripts in the isolated preload world.
// Plain CJS by design (Electron's preload contract); only contextBridge and
// ipcRenderer are used, so this works under sandbox: true.
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// The shell reads window.__DSH_BOOT__ at boot; expose the host-composed graph
// (bundle URLs rewritten to absolute file:// paths) before page scripts run.
contextBridge.exposeInMainWorld('__DSH_BOOT__', ipcRenderer.sendSync('dsh:boot-manifest'))

// The desktop connection carrier: unary/respond over invoke, downlink streams
// over the frame channel.
contextBridge.exposeInMainWorld('dshDesktop', {
  invoke: (request) => ipcRenderer.invoke('dsh:invoke', request),
  subscribe: (channel, listener) => {
    const cb = (_event, frameChannel, message) => {
      if (frameChannel === channel) listener(message)
    }
    ipcRenderer.on('dsh:frame', cb)
    ipcRenderer.send('dsh:subscribe', channel)
    return () => {
      ipcRenderer.removeListener('dsh:frame', cb)
      ipcRenderer.send('dsh:unsubscribe', channel)
    }
  },
})
