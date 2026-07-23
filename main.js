'use strict';

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Uncomment for debugging:
  // win.webContents.openDevTools();
}

// --- IPC: open PCM files ------------------------------------------------
ipcMain.handle('dialog:openPcm', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open PCM / raw audio dump',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'PCM / raw audio', extensions: ['pcm', 'raw', 'bin', 'dat', 'dump', 'sw', 'sb'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (result.canceled) return [];
  return result.filePaths.map((p) => ({
    path: p,
    name: path.basename(p),
    size: fs.statSync(p).size
  }));
});

// --- IPC: read a file, return its bytes as ArrayBuffer ------------------
ipcMain.handle('file:read', async (_evt, filePath) => {
  const buf = await fs.promises.readFile(filePath);
  // Return an ArrayBuffer slice matching exactly the file bytes.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// --- IPC: save a WAV file ----------------------------------------------
ipcMain.handle('dialog:saveWav', async (_evt, { arrayBuffer, defaultName, defaultDir }) => {
  const name = defaultName || 'export.wav';
  const defaultPath = defaultDir ? path.join(defaultDir, name) : name;
  const result = await dialog.showSaveDialog({
    title: 'Export WAV',
    defaultPath,
    filters: [{ name: 'WAV audio', extensions: ['wav'] }]
  });
  if (result.canceled || !result.filePath) return { saved: false };
  await fs.promises.writeFile(result.filePath, Buffer.from(arrayBuffer));
  return {
    saved: true,
    path: result.filePath,
    dir: path.dirname(result.filePath),
    name: path.basename(result.filePath)
  };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
