'use strict';
// Headless-ish Electron smoke test: load the renderer, capture console
// errors and load failures, then exit non-zero if anything went wrong.
// Run: npx electron tools/smoke-electron.js

const { app, BrowserWindow } = require('electron');
const path = require('path');

const errors = [];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.webContents.on('console-message', (_e, level, message) => {
    // level 3 = error
    if (level >= 2) errors.push(`[console ${level}] ${message}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    errors.push(`did-fail-load ${code} ${desc}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    errors.push(`render-process-gone ${JSON.stringify(details)}`);
  });

  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  } catch (err) {
    errors.push('loadFile threw: ' + err.message);
  }

  // Give module scripts time to import and run DOMContentLoaded handler.
  await new Promise((r) => setTimeout(r, 1500));

  // Probe that the app initialized: status text + globals present.
  let probe;
  try {
    probe = await win.webContents.executeJavaScript(`(() => ({
      status: document.getElementById('status')?.textContent || '',
      hasApi: typeof window.api === 'object' && typeof window.api.openPcmFiles === 'function',
      hasPathForFile: typeof window.api?.pathForFile === 'function',
      hasDropOverlay: !!document.getElementById('drop-overlay'),
      exportBtn: !!document.getElementById('export-btn'),
      hasNameInput: !!document.getElementById('export-name'),
      hasRecentBox: !!document.getElementById('export-recent'),
      nameValue: document.getElementById('export-name')?.value || '',
      defFormatOptions: document.getElementById('def-format')?.options.length || 0,
      specWindowOptions: document.getElementById('spec-window')?.options.length || 0,
      specScaleOptions: document.getElementById('spec-scale')?.options.length || 0,
      hasSpecRange: !!document.getElementById('spec-fmax') && !!document.getElementById('spec-dbmin'),
      hasPreview: !!document.getElementById('preview-btn') && !!document.getElementById('preview-bar'),
      previewDisabled: document.getElementById('preview-btn')?.disabled
    }))()`);
  } catch (err) {
    errors.push('probe threw: ' + err.message);
  }

  console.log('PROBE:', JSON.stringify(probe));
  if (!probe || !probe.hasApi) errors.push('window.api not exposed');
  if (!probe || !probe.hasPathForFile) errors.push('pathForFile not exposed');
  if (!probe || !probe.hasDropOverlay) errors.push('drop overlay missing');
  if (!probe || !probe.hasNameInput) errors.push('export name input missing');
  if (!probe || !probe.hasRecentBox) errors.push('recent path box missing');
  if (!probe || probe.specWindowOptions < 6) errors.push('spectrogram window dropdown not populated');
  if (!probe || probe.specScaleOptions < 4) errors.push('spectrogram scale dropdown not populated');
  if (!probe || !probe.hasSpecRange) errors.push('spectrogram range inputs missing');
  if (!probe || !probe.hasPreview) errors.push('mixed preview controls missing');
  if (!probe || probe.previewDisabled !== true) errors.push('preview button should start disabled (no selection)');

  // Exercise the real STFT + render pipeline across every frequency scale.
  let render;
  try {
    render = await win.webContents.executeJavaScript(`(async () => {
      const mod = await import('./spectrogram.js');
      const N = 8192, SR = 48000, F = 3000;
      const sig = new Float32Array(N);
      for (let i = 0; i < N; i++) sig[i] = 0.8 * Math.sin(2 * Math.PI * F * i / SR);
      const m = mod.computeSpectrogramMatrix(sig, { windowType: 'blackman-harris', fftSize: 2048, overlap: 0.75 });
      const out = {};
      for (const scale of ['linear','log','mel','bark']) {
        const c = document.createElement('canvas'); c.width = 500; c.height = 260;
        mod.renderSpectrogram(c, m, { sampleRate: SR, scale, fMin: 0, fMax: 0, dbMin: -100, dbMax: -10, durationSec: N/SR });
        const d = c.getContext('2d').getImageData(60, 0, 400, 240).data;
        let nonBlack = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 40) nonBlack++;
        out[scale] = nonBlack;
      }
      out.cols = m.cols; out.bins = m.bins;
      return out;
    })()`);
  } catch (err) {
    errors.push('render probe threw: ' + err.message);
  }
  console.log('RENDER:', JSON.stringify(render));
  if (render) {
    for (const scale of ['linear', 'log', 'mel', 'bark']) {
      if (!(render[scale] > 100)) errors.push(`spectrogram render (${scale}) produced too few lit pixels: ${render[scale]}`);
    }
  }
  if (!probe || probe.defFormatOptions < 5) errors.push('format dropdown not populated');
  if (!probe || !probe.status) errors.push('status not initialized');

  if (errors.length) {
    console.log('SMOKE FAIL:');
    for (const e of errors) console.log('  ' + e);
    app.exit(1);
  } else {
    console.log('SMOKE OK');
    app.exit(0);
  }
});
