'use strict';
// Verify HiDPI: force device scale factor 2 and confirm canvases are backed by
// a 2x device-pixel buffer while still rendering. Run: npx electron tools/diag-dpi.js
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('force-device-scale-factor', '2');

const sample = path.join(__dirname, '..', 'samples', 'mono_sweep.s16le.pcm');
ipcMain.handle('dialog:openPcm', async () => [{ path: sample, name: path.basename(sample), size: fs.statSync(sample).size }]);
ipcMain.handle('file:read', async (_e, fp) => { const b = fs.readFileSync(fp); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
ipcMain.handle('dialog:saveWav', async () => ({ saved: false }));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (win, code) => win.webContents.executeJavaScript(code);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await js(win, `document.getElementById('open-btn').click()`);
    await wait(700);
    await js(win, `document.querySelector('.ch-modes').querySelectorAll('.btn')[2].click()`); // Both
    await wait(700);
    const info = await js(win, `(() => {
      const wf = document.querySelector('canvas.wf-base');
      const sp = document.querySelector('canvas.spec');
      const litSpec = (() => { const d = sp.getContext('2d',{willReadFrequently:true}).getImageData(0,0,sp.width,sp.height).data; let n=0; for(let i=0;i<d.length;i+=4) if(d[i]+d[i+1]+d[i+2]>40) n++; return n; })();
      return {
        devicePixelRatio: window.devicePixelRatio,
        wfBufferW: wf.width, wfCssW: wf._cssW, wfRatio: +(wf.width/wf._cssW).toFixed(2),
        specBufferW: sp.width, specCssW: sp._cssW, specBufferH: sp.height, specCssH: sp._cssH,
        specLitPixels: litSpec
      };
    })()`);
    console.log('DPIDIAG ' + JSON.stringify(info));
  } catch (err) {
    console.log('ERR ' + (err && err.message ? err.message : String(err)));
  } finally {
    app.exit(0);
  }
});
