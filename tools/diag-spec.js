'use strict';
// Quantify how much each spectrogram control changes the rendered pixels.
// Run: npx electron tools/diag-spec.js
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const sample = path.join(__dirname, '..', 'samples', 'mono_sweep.s16le.pcm');
ipcMain.handle('dialog:openPcm', async () => [{ path: sample, name: path.basename(sample), size: fs.statSync(sample).size }]);
ipcMain.handle('file:read', async (_e, fp) => { const b = fs.readFileSync(fp); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
ipcMain.handle('dialog:saveWav', async () => ({ saved: false }));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (win, code) => win.webContents.executeJavaScript(code);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await js(win, `document.getElementById('open-btn').click()`);
    await wait(700);
    await js(win, `document.querySelector('.ch-modes').querySelectorAll('.btn')[1].click()`); // Spectrogram
    await wait(700);

    await js(win, `
      window.__pix = () => { const c = document.querySelector('canvas.spec'); return c.getContext('2d', { willReadFrequently: true }).getImageData(48, 0, c.width - 48, c.height - 18).data; };
      window.__setRef = () => { window.__ref = Uint8ClampedArray.from(window.__pix()); return window.__ref.length; };
      window.__diff = () => { const a = window.__ref, b = window.__pix(); let sum = 0, diff = 0, n = 0; for (let i = 0; i < a.length; i += 4) { const dd = Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2]); sum += dd; if (dd > 12) diff++; n++; } return { meanAbs: +(sum/n/3).toFixed(2), pctDiff: +(100*diff/n).toFixed(1) }; };
      window.__setCtl = (id, val) => { const e = document.getElementById(id); e.value = String(val); e.dispatchEvent(new Event('change')); };
      'ok';
    `);

    // fix size/overlap/scale so only the window varies, ref = hann
    await js(win, `window.__setCtl('spec-size','1024'); window.__setCtl('spec-overlap','0.75'); window.__setCtl('spec-scale','linear'); window.__setCtl('spec-window','hann')`);
    await wait(400);
    await js(win, `window.__setRef()`);

    const out = { windowsVsHann: {}, referenceChanges: {} };
    for (const w of ['rectangular', 'hamming', 'blackman', 'blackman-harris', 'bartlett', 'flattop']) {
      await js(win, `window.__setCtl('spec-window', ${JSON.stringify(w)})`);
      await wait(300);
      out.windowsVsHann[w] = await js(win, 'window.__diff()');
    }
    // back to hann, then measure non-window changes for magnitude comparison
    await js(win, `window.__setCtl('spec-window','hann')`); await wait(300); await js(win, `window.__setRef()`);
    await js(win, `window.__setCtl('spec-size','256')`); await wait(300);
    out.referenceChanges['size 1024->256'] = await js(win, 'window.__diff()');
    await js(win, `window.__setCtl('spec-size','1024')`); await wait(200); await js(win, `window.__setRef()`);
    await js(win, `window.__setCtl('spec-dbmax','-20')`); await wait(300);
    out.referenceChanges['dbmax -10->-20'] = await js(win, 'window.__diff()');
    await js(win, `window.__setCtl('spec-scale','log')`); await wait(300);
    out.referenceChanges['+scale log'] = await js(win, 'window.__diff()');

    console.log('SPECDIFF ' + JSON.stringify(out));
  } catch (err) {
    console.log('ERR ' + (err && err.message ? err.message : String(err)));
  } finally {
    app.exit(0);
  }
});
