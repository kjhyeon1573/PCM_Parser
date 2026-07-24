'use strict';
// Verify the new plot gestures: drag = select region, drag edge = resize,
// click = seek (no selection change). Run: npx electron tools/diag-fr.js
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const sample = path.join(__dirname, '..', 'samples', 'mono_1000hz.s16le.pcm');
ipcMain.handle('dialog:openPcm', async () => [{ path: sample, name: path.basename(sample), size: fs.statSync(sample).size }]);
ipcMain.handle('file:read', async (_e, fp) => { const b = fs.readFileSync(fp); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
ipcMain.handle('dialog:saveWav', async () => ({ saved: false }));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (win, code) => win.webContents.executeJavaScript(code);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: false, backgroundThrottling: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await js(win, `document.getElementById('open-btn').click()`);
    await wait(700);

    await js(win, `
      const wrap = document.querySelector('.wf-wrap');
      wrap.setPointerCapture = () => {}; wrap.releasePointerCapture = () => {};
      const dur = 2.0, g = 46;
      window.__x = (t) => { const r = wrap.getBoundingClientRect(); return r.left + g + (r.width - g) * (t / dur); };
      window.__y = () => wrap.getBoundingClientRect().top + 50;
      window.__drag = (t1, t2) => {
        const y = window.__y();
        const mk = (type, x) => new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true });
        wrap.dispatchEvent(mk('pointerdown', window.__x(t1)));
        wrap.dispatchEvent(mk('pointermove', window.__x(t2)));
        wrap.dispatchEvent(new PointerEvent('pointerup', { clientX: window.__x(t2), clientY: y, button: 0, pointerId: 1, bubbles: true }));
      };
      window.__click = (t) => {
        const y = window.__y(), x = window.__x(t);
        const mk = (type) => new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true });
        wrap.dispatchEvent(mk('pointerdown')); wrap.dispatchEvent(mk('pointerup'));
      };
      window.__sel = () => { const s = document.querySelector('.file-card').dataset.sel; if (!s) return null; const [a,b]=s.split(',').map(Number); return { a:+(a/48000).toFixed(3), b:+(b/48000).toFixed(3) }; };
      'ok';
    `);

    await js(win, `window.__drag(0.30, 0.70)`);          // plain drag → select 0.30–0.70s
    await wait(200);
    const afterSelect = await js(win, `window.__sel()`);

    await js(win, `window.__drag(0.70, 0.90)`);          // grab right edge (0.70) → resize to 0.90
    await wait(200);
    const afterResizeR = await js(win, `window.__drag(0.30, 0.15), window.__sel()`); // grab left edge (0.30) → resize to 0.15

    await js(win, `window.__click(0.50)`);               // click → seek, must NOT change selection
    await wait(150);
    const afterClick = await js(win, `window.__sel()`);

    console.log('GESTDIAG ' + JSON.stringify({ afterSelect, afterResizeR, afterClick }));
  } catch (err) {
    console.log('ERR ' + (err && err.message ? err.message : String(err)));
  } finally {
    app.exit(0);
  }
});
