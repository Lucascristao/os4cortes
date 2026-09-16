const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('os4', {
  state: () => ipcRenderer.invoke('state'),
  login: (n) => ipcRenderer.invoke('login', n),
  saveAccount: (network, account) => ipcRenderer.invoke('save-account', { network, account }),
  closeLogin: (n) => ipcRenderer.invoke('close-login', n),
  openSite: () => ipcRenderer.invoke('open-site'),
  getQueue: () => ipcRenderer.invoke('get-queue'),
  enqueueManual: (data) => ipcRenderer.invoke('enqueue-manual', data),
  onLog: (cb) => ipcRenderer.on('app-log', (_event, data) => cb(data)),
  onQueueStatus: (cb) => ipcRenderer.on('queue-status', (_event, data) => cb(data)),
  onCooldown: (cb) => ipcRenderer.on('cooldown', (_event, data) => cb(data))
});
