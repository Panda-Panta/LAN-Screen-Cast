const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lan', {
  getNetworks: () => ipcRenderer.invoke('lan:get-networks'),
  getSources: type => ipcRenderer.invoke('lan:get-sources', type),
  selectSource: (id, config) => ipcRenderer.invoke('lan:select-source', id, config),
  start: config => ipcRenderer.invoke('lan:start', config),
  stop: () => ipcRenderer.invoke('lan:stop'),
  sendSignal: (id, signal) => ipcRenderer.invoke('lan:signal', id, signal),
  kick: id => ipcRenderer.invoke('lan:kick', id),
  retry: (id, reason) => ipcRenderer.invoke('lan:retry', id, reason),
  copy: text => ipcRenderer.invoke('lan:copy', text),
  beginRtmp: request => ipcRenderer.invoke('lan:begin-rtmp', request),
  appendRtmp: request => ipcRenderer.invoke('lan:append-rtmp', request),
  finishRtmp: request => ipcRenderer.invoke('lan:finish-rtmp', request),
  getSettings: () => ipcRenderer.invoke('lan:get-settings'),
  saveSettings: config => ipcRenderer.invoke('lan:save-settings', config),
  detectRouter: host => ipcRenderer.invoke('lan:detect-router', host),
  cancelRouterDetection: () => ipcRenderer.invoke('lan:cancel-router-detection'),
  readyToClose: requestId => ipcRenderer.invoke('lan:ready-to-close', requestId),
  onEvent: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('lan:event', listener);
    return () => ipcRenderer.removeListener('lan:event', listener);
  }
});
