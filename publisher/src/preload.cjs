const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('os4', {
  state: () => ipcRenderer.invoke('state'),
  login: (n) => ipcRenderer.invoke('login', n),
  saveAccount: (network, account) => ipcRenderer.invoke('save-account', { network, account }),
  closeLogin: (n) => ipcRenderer.invoke('close-login', n),
  openSite: () => ipcRenderer.invoke('open-site'),
  getQueue: () => ipcRenderer.invoke('get-queue'),
  enqueueManual: (data) => ipcRenderer.invoke('enqueue-manual', data),
  importDriveFolder: (url) => ipcRenderer.invoke('import-drive-folder', url),
  pauseQueue: () => ipcRenderer.invoke('queue:pause'),
  resumeQueue: () => ipcRenderer.invoke('queue:resume'),
  retryJob: (id) => ipcRenderer.invoke('queue:retry', id),
  retryAllFailed: () => ipcRenderer.invoke('queue:retry-all'),
  deleteJob: (id) => ipcRenderer.invoke('queue:delete', id),
  onLog: (cb) => ipcRenderer.on('app-log', (_event, data) => cb(data)),
  onQueueStatus: (cb) => ipcRenderer.on('queue-status', (_event, data) => cb(data)),
  onCooldown: (cb) => ipcRenderer.on('cooldown', (_event, data) => cb(data)),
  onDriveImportFinished: (cb) => ipcRenderer.on('drive-import-finished', (_event, data) => cb(data))
});
