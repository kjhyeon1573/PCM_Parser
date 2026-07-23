'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openPcmFiles: () => ipcRenderer.invoke('dialog:openPcm'),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  saveWav: (arrayBuffer, defaultName, defaultDir) =>
    ipcRenderer.invoke('dialog:saveWav', { arrayBuffer, defaultName, defaultDir }),
  // Resolve a dropped File object to its absolute path on disk.
  pathForFile: (file) => webUtils.getPathForFile(file)
});
