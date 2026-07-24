'use strict';
// Diagnostic: load the real renderer, open a sample as 3ch, set all channels to
// "Both", and measure whether the card/handle overflow the window.
// Run: npx electron tools/diag-layout.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const sample = path.join(__dirname, '..', 'samples', 'stereo_interleaved.s16le.pcm');

ipcMain.handle('dialog:openPcm', async () => [{ path: sample, name: path.basename(sample), size: fs.statSync(sample).size }]);
ipcMain.handle('file:read', async (_e, fp) => { const b = fs.readFileSync(fp); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
ipcMain.handle('dialog:saveWav', async () => ({ saved: false }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 700, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // open as 3 channels
  await win.webContents.executeJavaScript(`(() => {
    const c = document.getElementById('def-channels'); c.value = '3'; c.dispatchEvent(new Event('change'));
    document.getElementById('open-btn').click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  // set every channel to "Both" (3rd mode button)
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.ch-modes').forEach(m => m.querySelectorAll('.btn')[2].click());
  })()`);
  await new Promise((r) => setTimeout(r, 800));

  const info = await win.webContents.executeJavaScript(`(() => {
    const files = document.getElementById('files');
    const card = document.querySelector('.file-card');
    const channels = document.querySelector('.channels');
    const resizer = document.querySelector('.card-resizer');
    const rz = resizer.getBoundingClientRect();
    const cs = getComputedStyle(channels);
    return {
      innerH: window.innerHeight,
      numChannelRows: document.querySelectorAll('.ch-row').length,
      channelsMaxHeight: cs.maxHeight,
      channelsOverflowY: cs.overflowY,
      channelsScrollH: channels.scrollHeight,
      channelsClientH: channels.clientHeight,
      channelsCanScroll: channels.scrollHeight > channels.clientHeight + 1,
      cardHeight: Math.round(card.getBoundingClientRect().height),
      filesScrollH: files.scrollHeight,
      filesClientH: files.clientHeight,
      filesCanScroll: files.scrollHeight > files.clientHeight + 1,
      resizerTop: Math.round(rz.top),
      resizerBottom: Math.round(rz.bottom),
      resizerInWindow: rz.top >= 0 && rz.bottom <= window.innerHeight
    };
  })()`);
  console.log('DIAG ' + JSON.stringify(info));
  app.exit(0);
});
