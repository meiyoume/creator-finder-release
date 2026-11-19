'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('creatorAPI', {
  setTheme: theme => ipcRenderer.send('ui-theme', theme),
  // 应用内升级
  version: () => ipcRenderer.invoke('app:version'),  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: asset => ipcRenderer.invoke('update:download', asset),
  installUpdate: file => ipcRenderer.invoke('update:install', file),
  cancelUpdate: () => ipcRenderer.send('update:cancel'),
  onUpdateProgress: fn => {
    const handler = (_event, payload) => { try { fn(payload); } catch { /* ignore */ } };
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  }
});
