'use strict';
// Verify the hover bar follows the cursor and magnet-snaps to a selection edge
// when snap is on. Run: npx electron tools/diag-hover.js
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
      const X = t => { const r = wrap.getBoundingClientRect(); return r.left + g + (r.width - g) * (t / dur); };
      const Y = () => wrap.getBoundingClientRect().top + 50;
      window.__drag = (t1, t2) => { const y = Y(); const mk=(ty,x)=>new PointerEvent(ty,{clientX:x,clientY:y,button:0,pointerId:1,bubbles:true});
        wrap.dispatchEvent(mk('pointerdown',X(t1))); wrap.dispatchEvent(mk('pointermove',X(t2))); wrap.dispatchEvent(new PointerEvent('pointerup',{clientX:X(t2),clientY:y,button:0,pointerId:1,bubbles:true})); };
      window.__move = (t) => wrap.dispatchEvent(new PointerEvent('pointermove',{clientX:X(t),clientY:Y(),bubbles:true}));
      window.__hoverFrac = () => {
        const c = document.querySelector('.wf-overlay'); const dpr=c._dpr||1, cssW=c._cssW||c.width, W=c.width, H=c.height;
        const d = c.getContext('2d',{willReadFrequently:true}).getImageData(0,0,W,H).data;
        let bx=-1, bc=0;
        for (let x=0;x<W;x++){ let cnt=0; for (let y=0;y<H;y+=3){ const i=(y*W+x)*4; if (d[i]>200&&d[i+1]>200&&d[i+2]>200&&d[i+3]>40) cnt++; } if (cnt>bc){bc=cnt;bx=x;} }
        if (bc<3) return null;
        return +(((bx/dpr) - 46)/(cssW - 46)).toFixed(3);
      };
      window.__setSnap = (on) => { const e=document.getElementById('snap-enabled'); e.checked=on; e.dispatchEvent(new Event('change')); };
      'ok';
    `);

    await js(win, `window.__drag(0.30, 0.70)`); // select → edges at frac 0.15 and 0.35 (0.30s/0.70s)
    await wait(200);

    await js(win, `window.__setSnap(true); window.__move(0.55)`); // mid-plot, away from edges
    await wait(120);
    const hoverMid = await js(win, `window.__hoverFrac()`);        // expect ~0.275 (0.55/2)

    await js(win, `window.__move(0.685)`);                          // near right edge (0.70s)
    await wait(120);
    const hoverSnap = await js(win, `window.__hoverFrac()`);        // expect ~0.35 (snapped to edge)

    await js(win, `window.__setSnap(false); window.__move(0.685)`);
    await wait(120);
    const hoverFree = await js(win, `window.__hoverFrac()`);        // expect ~0.3425 (not snapped)

    console.log('HOVERDIAG ' + JSON.stringify({ hoverMid, hoverSnap, hoverFree }));
  } catch (err) {
    console.log('ERR ' + (err && err.message ? err.message : String(err)));
  } finally {
    app.exit(0);
  }
});
