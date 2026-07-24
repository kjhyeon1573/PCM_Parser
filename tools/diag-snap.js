'use strict';
// Verify snap-to-other-track: select a range in file A, then an offset range in
// file B, and confirm B snaps to A's range. Run: npx electron tools/diag-snap.js
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const sdir = path.join(__dirname, '..', 'samples');
const files = ['mono_1000hz.s16le.pcm', 'mono_440hz.s16le.pcm'].map((n) => ({ path: path.join(sdir, n), name: n, size: fs.statSync(path.join(sdir, n)).size }));
ipcMain.handle('dialog:openPcm', async () => files);
ipcMain.handle('file:read', async (_e, fp) => { const b = fs.readFileSync(fp); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
ipcMain.handle('dialog:saveWav', async () => ({ saved: false }));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (win, code) => win.webContents.executeJavaScript(code);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 900, show: false, backgroundThrottling: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2 && !/willReadFrequently/.test(msg)) errs.push(msg); });
  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await js(win, `document.getElementById('open-btn').click()`);
    await wait(900);

    // helper: shift-drag select on the Nth file card's waveform, times in seconds (2s files)
    await js(win, `
      window.__selectOnCard = (cardIndex, t1, t2) => {
        const card = document.querySelectorAll('.file-card')[cardIndex];
        const wrap = card.querySelector('.wf-wrap');
        wrap.setPointerCapture = () => {}; wrap.releasePointerCapture = () => {};
        const r = wrap.getBoundingClientRect(); const g = 46, dur = 2.0;
        const xOf = t => r.left + g + (r.width - g) * (t / dur);
        const y = r.top + 50;
        const mk = (type, x) => new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true });
        wrap.dispatchEvent(mk('pointerdown', xOf(t1)));
        wrap.dispatchEvent(mk('pointermove', xOf(t2)));
        wrap.dispatchEvent(new PointerEvent('pointerup', { clientX: xOf(t2), clientY: y, button: 0, pointerId: 1, bubbles: true }));
        return true;
      };
      window.__cardRange = (i) => {
        const card = document.querySelectorAll('.file-card')[i];
        const s = card.dataset.sel || '';
        if (!s) return null;
        const [a, b] = s.split(',').map(Number);
        return { a: +(a / 48000).toFixed(3), b: +(b / 48000).toFixed(3), samples: [a, b] };
      };
      'ok';
    `);

    await js(win, `window.__selectOnCard(0, 0.40, 1.00)`); // file A: 0.40–1.00s
    await wait(300);
    const aRange = await js(win, `window.__cardRange(0)`);

    // snap ON (default): file B offset by 0.05s → should snap to A's range
    await js(win, `document.getElementById('snap-enabled').checked = true; document.getElementById('snap-enabled').dispatchEvent(new Event('change'));`);
    await js(win, `window.__selectOnCard(1, 0.45, 1.05)`);
    await wait(300);
    const bSnap = await js(win, `window.__cardRange(1)`);

    // snap OFF: same offset selection should NOT snap
    await js(win, `document.getElementById('snap-enabled').checked = false; document.getElementById('snap-enabled').dispatchEvent(new Event('change'));`);
    await js(win, `window.__selectOnCard(1, 0.45, 1.05)`);
    await wait(300);
    const bFree = await js(win, `window.__cardRange(1)`);

    const dbg = await js(win, `(() => {
      const cards = document.querySelectorAll('.file-card');
      return {
        cardCount: cards.length,
        card1FrHidden: cards[1] ? cards[1].querySelector('.fr-panel')?.classList.contains('hidden') : 'no-card',
        card1Label: cards[1] ? (cards[1].querySelector('.fr-panel .wf-view')?.textContent || '') : 'no-card'
      };
    })()`);
    console.log('SNAPDIAG ' + JSON.stringify({ aRange, bSnap, bFree, dbg, errs: errs.slice(0, 5) }));
  } catch (err) {
    console.log('ERR ' + (err && err.message ? err.message : String(err)));
  } finally {
    app.exit(0);
  }
});
