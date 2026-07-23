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
    // level 2 = warning, 3 = error. Ignore the benign getImageData perf hint
    // (triggered by this test's own pixel readbacks, not the app).
    if (/willReadFrequently/i.test(message)) return;
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
      previewDisabled: document.getElementById('preview-btn')?.disabled,
      hasPresets: !!document.getElementById('preset-select') && !!document.getElementById('preset-save') && !!document.getElementById('preset-name')
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
  if (!probe || !probe.hasPresets) errors.push('preset controls missing');

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

  // Exercise the waveform + axes + Hilbert envelope render path (incl. zoom).
  let wfr;
  try {
    wfr = await win.webContents.executeJavaScript(`(async () => {
      const wf = await import('./waveform.js');
      const hb = await import('./hilbert.js');
      const N = 8000, SR = 48000;
      const sig = new Float32Array(N);
      for (let i = 0; i < N; i++) sig[i] = 0.6 * Math.sin(2 * Math.PI * 500 * i / SR);
      const env = hb.hilbertEnvelope(sig, { smooth: 96 });
      const c = document.createElement('canvas'); c.width = 600; c.height = 120;
      wf.drawWaveform(c, sig, { start: 0, end: N, sampleRate: SR, envelope: env });
      const d = c.getContext('2d').getImageData(wf.WF_LEFT, 0, 600 - wf.WF_LEFT, 104).data;
      let lit = 0, amber = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i+1], b = d[i+2];
        if (b > 80 && b > r) lit++;
        if (r > 150 && g > 100 && b < 130) amber++;
      }
      // zoom to a sub-range must still render
      wf.drawWaveform(c, sig, { start: 1000, end: 1200, sampleRate: SR });
      const d2 = c.getContext('2d').getImageData(wf.WF_LEFT, 0, 600 - wf.WF_LEFT, 104).data;
      let lit2 = 0;
      for (let i = 0; i < d2.length; i += 4) if (d2[i+2] > 80 && d2[i+2] > d2[i]) lit2++;
      return { lit, amber, litZoom: lit2, wfLeft: wf.WF_LEFT };
    })()`);
  } catch (err) {
    errors.push('waveform render probe threw: ' + err.message);
  }
  console.log('WAVEFORM:', JSON.stringify(wfr));
  if (wfr) {
    if (!(wfr.lit > 100)) errors.push('waveform produced too few lit pixels: ' + wfr.lit);
    if (!(wfr.amber > 20)) errors.push('envelope overlay produced too few pixels: ' + wfr.amber);
    if (!(wfr.litZoom > 100)) errors.push('zoomed waveform produced too few lit pixels: ' + wfr.litZoom);
  }

  // Exercise the split spectrogram pipeline: build image once, paint full,
  // paint a time-cropped window, and build a frequency-zoomed image.
  let sx;
  try {
    sx = await win.webContents.executeJavaScript(`(async () => {
      const mod = await import('./spectrogram.js');
      const N = 16000, SR = 48000, F = 3000;
      const sig = new Float32Array(N);
      for (let i = 0; i < N; i++) sig[i] = 0.8 * Math.sin(2 * Math.PI * F * i / SR);
      const m = mod.computeSpectrogramMatrix(sig, { windowType: 'hann', fftSize: 1024, overlap: 0.75 });
      const total = m.cols * m.hop;
      const c = document.createElement('canvas'); c.width = 500; c.height = 200;
      const count = () => { const d = c.getContext('2d').getImageData(mod.LEFT_GUTTER, 0, 400, 180).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i]+d[i+1]+d[i+2] > 40) n++; return n; };
      const full = mod.buildSpectrogramImage(m, { sampleRate: SR, scale: 'linear', fMin: 0, fMax: 0, dbMin: -100, dbMax: -10, canvasHeight: 200 });
      mod.paintSpectrogram(c, full, { sampleRate: SR, viewStart: 0, viewEnd: total });
      const litFull = count();
      mod.paintSpectrogram(c, full, { sampleRate: SR, viewStart: total*0.25, viewEnd: total*0.5 });
      const litCrop = count();
      const zoom = mod.buildSpectrogramImage(m, { sampleRate: SR, scale: 'log', fMin: 1000, fMax: 6000, dbMin: -100, dbMax: -10, canvasHeight: 200 });
      mod.paintSpectrogram(c, zoom, { sampleRate: SR, viewStart: 0, viewEnd: total });
      const litFreqZoom = count();
      return { litFull, litCrop, litFreqZoom };
    })()`);
  } catch (err) {
    errors.push('spectrogram split probe threw: ' + err.message);
  }
  console.log('SPEC2:', JSON.stringify(sx));
  if (sx) {
    if (!(sx.litFull > 100)) errors.push('spectrogram build/paint full too few pixels: ' + sx.litFull);
    if (!(sx.litCrop > 100)) errors.push('spectrogram time-crop too few pixels: ' + sx.litCrop);
    if (!(sx.litFreqZoom > 100)) errors.push('spectrogram freq-zoom too few pixels: ' + sx.litFreqZoom);
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
