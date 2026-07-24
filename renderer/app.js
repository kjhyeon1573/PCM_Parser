'use strict';

import { FORMATS, parsePcm, channelStats } from './pcm.js';
import { drawWaveform, drawCursor, WF_LEFT, WF_BOTTOM } from './waveform.js';
import { computeSpectrogramMatrix, buildSpectrogramImage, paintSpectrogram, LEFT_GUTTER } from './spectrogram.js';
import { hilbertEnvelope } from './hilbert.js';
import { frequencyResponse, renderFreqResponse } from './spectrum.js';
import { WINDOWS } from './windows.js';
import { SCALES, scaleForward, scaleInverse, effectiveFMin } from './scales.js';
import { Player } from './player.js';
import { encodeWav } from './wav.js';

// Default panel height (per-file, adjustable) for waveform & spectrogram canvases.
const PANEL_HEIGHT = 200;
const MIN_PANEL_HEIGHT = 90;
const MAX_PANEL_HEIGHT = 520;

// Global spectrogram settings — applied to every spectrogram.
// `compute`-affecting fields (window/size/overlap) require re-running the STFT;
// the rest only re-render the cached matrix.
const specSettings = {
  windowType: 'hann',
  fftSize: 1024,
  overlap: 0.75,
  scale: 'linear',   // linear | log | mel | bark
  fMin: 0,           // Hz; 0 = auto (DC, or a small value for log)
  fMax: 0,           // Hz; 0 = auto (Nyquist)
  dbMin: -100,
  dbMax: -10
};

// Global frequency-response (selected-region spectrum) settings.
const frSettings = {
  windowType: 'hann',
  fftSize: 2048,
  overlap: 0.5,
  scale: 'log',
  fMin: 0,
  fMax: 0,
  dbMin: -120,
  dbMax: 0
};

const state = {
  files: [],          // see makeFile()
  exportOrder: [],    // [{ fileId, ch }]
  nextId: 1,
  lastSaveDir: '',    // remembered folder for the save dialog
  lengthMode: 'longest', // 'longest' (pad) | 'shortest' (trim) for mix/export
  snapEnabled: true   // snap a new selection to another track's range (grid)
};

const player = new Player();          // per-file preview playback
const previewPlayer = new Player();   // mixed N-channel export preview
let activeFileId = null;

// ---- default settings applied to newly opened files -------------------
const defaults = {
  format: 's16le',
  channels: 1,
  sampleRate: 48000,
  headerBytes: 0
};

// =======================================================================
// DOM helpers
// =======================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  if (props.class) n.className = props.class;
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
};

function fmt(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}
function timeStr(sec) {
  if (!isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

// =======================================================================
// Format controls builder
// =======================================================================
function formatSelect(value) {
  const sel = el('select', { class: 'fmt-format' });
  for (const key of Object.keys(FORMATS)) {
    const o = el('option', { value: key, textContent: FORMATS[key].label });
    if (key === value) o.selected = true;
    sel.appendChild(o);
  }
  return sel;
}

// =======================================================================
// File model
// =======================================================================
function makeFile(meta, buffer) {
  return {
    id: state.nextId++,
    name: meta.name,
    path: meta.path,
    size: meta.size,
    buffer,
    settings: { ...defaults },
    parsed: null,
    stats: [],
    dom: null,
    view: { start: 0, end: 0 }, // per-file zoom window (samples), shared by all channels
    selection: null,            // per-file analysis region {start,end} samples, or null
    panelHeight: PANEL_HEIGHT,  // per-file plot height (px), adjustable
    channelDom: []
  };
}

function parseFile(file) {
  file.parsed = parsePcm(file.buffer, file.settings);
  file.stats = file.parsed.channels.map(channelStats);
  file.view = { start: 0, end: file.parsed.frameCount }; // reset zoom to full
  file.selection = null; // region invalid after re-parse
  // drop any export selections for channels that no longer exist
  state.exportOrder = state.exportOrder.filter(
    (e) => !(e.fileId === file.id && e.ch >= file.parsed.channels.length)
  );
}

// =======================================================================
// Rendering
// =======================================================================
const filesEl = () => $('#files');

function sizeCanvas(canvas, height) {
  // HiDPI: back the canvas with a device-pixel buffer (dpr× the CSS size) and
  // remember the logical CSS size + dpr for the drawing code to use.
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(200, canvas.parentElement.clientWidth);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(height * dpr);
  canvas._cssW = cssW;
  canvas._cssH = height;
  canvas._dpr = dpr;
}

// -------- precise, prompt canvas resizing (window + any layout change) -----
// A single ResizeObserver watches every waveform/spectrogram container so
// canvases always match their on-screen size. Work is batched into one rAF.
let roPending = new Set();
let roScheduled = false;
const sizeObserver = new ResizeObserver((entries) => {
  for (const e of entries) roPending.add(e.target);
  if (!roScheduled) { roScheduled = true; requestAnimationFrame(flushResize); }
});

function flushResize() {
  roScheduled = false;
  const targets = roPending;
  roPending = new Set();
  let cursorsDirty = false;
  for (const target of targets) {
    const cd = target._cd;
    if (!cd || target.clientWidth < 10) continue;
    const w = Math.max(200, target.clientWidth);
    if (target._kind === 'wf') {
      if (!wfVisible(cd) || cd.base._cssW === w) continue; // unchanged/hidden → skip
      sizeCanvas(cd.base, cd.file.panelHeight);
      sizeCanvas(cd.overlay, cd.file.panelHeight);
      drawChannelWaveform(cd);
      cursorsDirty = true;
    } else if (target._kind === 'spec') {
      if (!specVisible(cd) || !cd.matrix || cd.specCanvas._cssW === w) continue;
      sizeCanvas(cd.specCanvas, cd.file.panelHeight);
      sizeCanvas(cd.specOverlay, cd.file.panelHeight);
      ensureSpecImage(cd);   // height fixed → cached; width change → just repaint
      paintChannelSpec(cd);
      cursorsDirty = true;
    } else if (target._kind === 'fr') {
      if (!frVisible(cd) || cd.frCanvas._cssW === w) continue;
      renderChannelFr(cd);
    }
  }
  if (cursorsDirty) drawAllCursors();
}

function unobserveChannels(file) {
  for (const cd of file.channelDom) {
    if (cd.wfWrap) sizeObserver.unobserve(cd.wfWrap);
    if (cd.specWrap) sizeObserver.unobserve(cd.specWrap);
    if (cd.frInner) sizeObserver.unobserve(cd.frInner);
  }
}

function renderFile(file) {
  const card = el('div', { class: 'file-card' });
  file.dom = card;

  // ---- header ----
  const settings = file.settings;
  const formatSel = formatSelect(settings.format);
  const chInput = el('input', { class: 'num', type: 'number', min: 1, max: 64, value: settings.channels });
  const srInput = el('input', { class: 'num wide', type: 'number', min: 1, value: settings.sampleRate });
  const hdrInput = el('input', { class: 'num', type: 'number', min: 0, value: settings.headerBytes });

  const applyBtn = el('button', { class: 'btn small', textContent: 'Apply' });
  const playBtn = el('button', { class: 'btn small primary', textContent: '▶ Play' });
  const mixNote = el('span', { class: 'mix-note hidden' });
  const timeLabel = el('span', { class: 'time' });
  const info = el('span', { class: 'muted info' });

  applyBtn.onclick = () => {
    // remember each channel's view mode + envelope + plot state to restore them
    const restore = { mode: new Map(), env: new Set(), plotOff: new Set() };
    for (const cd of file.channelDom) {
      restore.mode.set(cd.ch, cd.mode);
      if (cd.envOn) restore.env.add(cd.ch);
      if (!cd.plotOn) restore.plotOff.add(cd.ch);
    }
    settings.format = formatSel.value;
    settings.channels = Math.max(1, parseInt(chInput.value) || 1);
    settings.sampleRate = Math.max(1, parseInt(srInput.value) || 48000);
    settings.headerBytes = Math.max(0, parseInt(hdrInput.value) || 0);
    parseFile(file);
    // signal changed → waveforms redraw and spectrograms recompute + re-render
    // with the new sample-rate-aware axes
    rebuildChannels(file, info, restore);
    updateExportPanel();
    if (activeFileId === file.id) { player.stop(); updatePlayButton(file, playBtn, timeLabel); }
  };

  playBtn.onclick = () => togglePlay(file, playBtn, timeLabel);

  const header = el('div', { class: 'file-header' }, [
    el('div', { class: 'file-title' }, [
      el('span', { class: 'fname', textContent: file.name }),
      el('span', { class: 'muted', textContent: '  ' + fmt(file.size) })
    ]),
    el('div', { class: 'ctrls' }, [
      el('label', {}, ['Format ', formatSel]),
      el('label', {}, ['Channels ', chInput]),
      el('label', {}, ['Sample rate ', srInput]),
      el('label', {}, ['Header bytes ', hdrInput]),
      applyBtn,
      playBtn,
      mixNote,
      timeLabel,
      info
    ])
  ]);

  const closeBtn = el('button', { class: 'btn small ghost close', textContent: '✕', title: 'Remove file' });
  closeBtn.onclick = () => removeFile(file);
  header.appendChild(closeBtn);

  card.appendChild(header);

  const chWrap = el('div', { class: 'channels' });
  card.appendChild(chWrap);

  // drag the card's bottom edge up/down to resize this file's plots
  const resizer = el('div', { class: 'card-resizer', title: 'Drag to resize plots' });
  card.appendChild(resizer);
  setupCardResize(file, resizer);

  card._chWrap = chWrap;
  card._playBtn = playBtn;
  card._timeLabel = timeLabel;
  card._mixNote = mixNote;

  filesEl().appendChild(card);
  rebuildChannels(file, info);
  updateMixNote(file);
}

/** Count currently-visible plot panels in a file (each waveform/spectrogram = 1). */
function visiblePanelCount(file) {
  let n = 0;
  for (const cd of file.channelDom) {
    if (wfVisible(cd)) n++;
    if (specVisible(cd)) n++;
  }
  return n;
}

/** Drag the card's bottom edge to change this file's plot height. */
function setupCardResize(file, handle) {
  let drag = null;
  handle.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    handle.setPointerCapture(ev.pointerId);
    // Dividing by the number of stacked panels makes the card's bottom edge
    // (the handle) track the cursor 1:1 even with many channels.
    drag = { y0: ev.clientY, h0: file.panelHeight, panels: Math.max(1, visiblePanelCount(file)), raf: 0, pending: file.panelHeight };
    handle.classList.add('active');
    ev.preventDefault();
  });
  handle.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    drag.pending = drag.h0 + (ev.clientY - drag.y0) / drag.panels; // drag down → taller
    if (!drag.raf) {
      drag.raf = requestAnimationFrame(() => {
        if (!drag) return;
        drag.raf = 0;
        setFilePanelHeight(file, drag.pending);
      });
    }
  });
  const end = (ev) => {
    if (!drag) return;
    if (drag.raf) cancelAnimationFrame(drag.raf);
    setFilePanelHeight(file, drag.pending);
    drag = null;
    handle.classList.remove('active');
    try { handle.releasePointerCapture(ev.pointerId); } catch (_) {}
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/** Show a red note when per-file playback will down-mix >2 checked channels to mono. */
function updateMixNote(file) {
  const note = file.dom && file.dom._mixNote;
  if (!note) return;
  const n = checkedChannels(file).length;
  if (n > 2) {
    note.textContent = `▶ ${n}ch → mono downmix`;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }
}

function updateAllMixNotes() {
  for (const f of state.files) updateMixNote(f);
}

function rebuildChannels(file, infoSpan, restore = null) {
  const chWrap = file.dom._chWrap;
  unobserveChannels(file);
  chWrap.innerHTML = '';
  file.channelDom = [];

  const p = file.parsed;
  const dur = p.frameCount / file.settings.sampleRate;
  infoSpan.textContent =
    `${p.channels.length} ch · ${p.frameCount.toLocaleString()} frames · ${timeStr(dur)}` +
    (p.bytesDropped ? ` · ${p.bytesDropped} trailing bytes ignored` : '');

  p.channels.forEach((data, ch) => {
    const cd = buildChannelRow(file, data, ch, chWrap);
    file.channelDom.push(cd);

    const restoreMode = restore && restore.mode.get(ch);
    const restoreEnv = restore && restore.env.has(ch);
    const restorePlotOff = restore && restore.plotOff.has(ch);

    requestAnimationFrame(() => {
      sizeCanvas(cd.base, cd.file.panelHeight);
      sizeCanvas(cd.overlay, cd.file.panelHeight);
      if (restoreEnv) enableEnvelope(cd, true);
      if (restorePlotOff) { setPlot(cd, false); return; }
      drawChannelWaveform(cd);
      if (restoreMode && restoreMode !== 'waveform') setChannelMode(cd, restoreMode);
    });
  });
}

function buildChannelRow(file, data, ch, chWrap) {
  // ---- left side: checkbox, peak, rms, view-mode buttons ----
  const checked = state.exportOrder.some((e) => e.fileId === file.id && e.ch === ch);
  const checkbox = el('input', { type: 'checkbox', checked });
  checkbox.onchange = () => toggleExport(file, ch, checkbox.checked);
  const st = file.stats[ch];

  const plotBtn = el('button', { class: 'btn tiny ghost active plot-toggle', textContent: 'plot', title: 'Show/hide plots for this channel' });
  const head = el('div', { class: 'ch-head' }, [
    el('label', { class: 'ch-check' }, [checkbox, el('span', { textContent: ` Ch ${ch}` })]),
    plotBtn
  ]);
  const peakLine = el('div', { class: 'ch-stat muted small', textContent: `peak ${st.peak.toFixed(3)}` });
  const rmsLine = el('div', { class: 'ch-stat muted small', textContent: `rms ${st.rms.toFixed(3)}` });

  const btnWf = el('button', { class: 'btn tiny ghost active', textContent: 'Waveform' });
  const btnSpec = el('button', { class: 'btn tiny ghost', textContent: 'Spectrogram' });
  const btnBoth = el('button', { class: 'btn tiny ghost', textContent: 'Both' });
  const modes = el('div', { class: 'ch-modes' }, [btnWf, btnSpec, btnBoth]);

  const side = el('div', { class: 'ch-side' }, [head, peakLine, rmsLine, modes]);

  // ---- right side: waveform panel + spectrogram panel ----
  const envBtn = el('button', { class: 'btn tiny ghost', textContent: 'RMS env' });
  const wfResetX = el('button', { class: 'btn tiny ghost', textContent: '⟲ time', title: 'Reset time zoom' });
  const wfResetY = el('button', { class: 'btn tiny ghost', textContent: '⟲ amp', title: 'Reset amplitude zoom' });
  const viewLabel = el('span', { class: 'muted small wf-view' });
  const wfToolbar = el('div', { class: 'wf-toolbar' }, [
    envBtn, wfResetX, wfResetY, viewLabel,
    el('span', { class: 'muted small wf-hint', textContent: 'drag: select · click: seek · edge: resize · Shift+drag: pan · wheel: zoom' })
  ]);

  const wfWrap = el('div', { class: 'wf-wrap' });
  wfWrap.style.height = file.panelHeight + 'px';
  const base = el('canvas', { class: 'wf-base' });
  const overlay = el('canvas', { class: 'wf-overlay' });
  wfWrap.appendChild(base);
  wfWrap.appendChild(overlay);
  const wfPanel = el('div', { class: 'wf-panel' }, [wfToolbar, wfWrap]);

  const specResetX = el('button', { class: 'btn tiny ghost', textContent: '⟲ time', title: 'Reset time zoom' });
  const specResetY = el('button', { class: 'btn tiny ghost', textContent: '⟲ freq', title: 'Reset frequency zoom' });
  const specToolbar = el('div', { class: 'wf-toolbar' }, [
    specResetX, specResetY,
    el('span', { class: 'muted small wf-hint', textContent: 'drag: select · click: seek · edge: resize · Shift+drag: pan · wheel: zoom' })
  ]);
  const specStatus = el('div', { class: 'spec-status muted small hidden', textContent: 'Computing…' });
  const specCanvas = el('canvas', { class: 'spec' });
  const specOverlay = el('canvas', { class: 'spec-overlay' });
  const specInner = el('div', { class: 'spec-inner' }, [specCanvas, specOverlay, specStatus]);
  specInner.style.height = file.panelHeight + 'px';
  const specWrap = el('div', { class: 'spec-wrap hidden' }, [specToolbar, specInner]);

  // frequency-response panel (shown when a region is selected)
  const frLabel = el('div', { class: 'muted small wf-view', textContent: 'Freq response' });
  const frToolbar = el('div', { class: 'wf-toolbar' }, [frLabel]);
  const frCanvas = el('canvas', { class: 'fr' });
  const frInner = el('div', { class: 'fr-inner' }, [frCanvas]);
  frInner.style.height = file.panelHeight + 'px';
  const frPanel = el('div', { class: 'fr-panel hidden' }, [frToolbar, frInner]);

  const main = el('div', { class: 'ch-main' }, [wfPanel, specWrap, frPanel]);

  const row = el('div', { class: 'ch-row' }, [side, main]);
  chWrap.appendChild(row);

  const cd = {
    file, data, ch,
    checkbox, base, overlay, wfWrap, wfPanel, viewLabel,
    specWrap, specInner, specCanvas, specOverlay, specStatus,
    frPanel, frInner, frCanvas, frLabel,
    btnWf, btnSpec, btnBoth, envBtn, plotBtn,
    peakLine, rmsLine, modes, main,
    plotOn: true,
    mode: 'waveform',
    envOn: false, envelope: null, envKey: '',
    ampView: { center: 0, range: 1 },      // waveform vertical (amplitude) view
    freqView: { min: null, max: null },     // spectrogram vertical (frequency) view; null = global
    matrix: null, matrixKey: '',
    specImage: null, specImageKey: '',
    frResp: null, frKey: ''                 // frequency-response cache
  };

  // plot on/off toggle
  plotBtn.onclick = () => setPlot(cd, !cd.plotOn);
  // view-mode buttons
  btnWf.onclick = () => setChannelMode(cd, 'waveform');
  btnSpec.onclick = () => setChannelMode(cd, 'spectrogram');
  btnBoth.onclick = () => setChannelMode(cd, 'both');
  envBtn.onclick = () => toggleEnvelope(cd);
  wfResetX.onclick = () => resetZoom(file);
  wfResetY.onclick = () => resetAmp(cd);
  specResetX.onclick = () => resetZoom(file);
  specResetY.onclick = () => resetFreq(cd);

  // observe for resizing
  wfWrap._cd = cd; wfWrap._kind = 'wf';
  specWrap._cd = cd; specWrap._kind = 'spec';
  frInner._cd = cd; frInner._kind = 'fr';
  sizeObserver.observe(wfWrap);
  sizeObserver.observe(specWrap);
  sizeObserver.observe(frInner);

  setupWaveformInteraction(cd);
  setupSpecInteraction(cd);
  return cd;
}

// =======================================================================
// Channel plot on/off + view mode (waveform / spectrogram / both)
// =======================================================================
function specVisible(cd) { return cd.plotOn && (cd.mode === 'spectrogram' || cd.mode === 'both'); }
function wfVisible(cd) { return cd.plotOn && (cd.mode === 'waveform' || cd.mode === 'both'); }

/** Toggle a channel's plots. When off, peak/rms, mode buttons and plots hide. */
function setPlot(cd, on) {
  cd.plotOn = on;
  cd.plotBtn.classList.toggle('active', on);
  cd.peakLine.classList.toggle('hidden', !on);
  cd.rmsLine.classList.toggle('hidden', !on);
  cd.modes.classList.toggle('hidden', !on);
  cd.main.classList.toggle('hidden', !on);
  if (on) setChannelMode(cd, cd.mode); // re-render the current mode
  updateFrVisibility(cd);
}

function setChannelMode(cd, mode) {
  cd.mode = mode;
  cd.btnWf.classList.toggle('active', mode === 'waveform');
  cd.btnSpec.classList.toggle('active', mode === 'spectrogram');
  cd.btnBoth.classList.toggle('active', mode === 'both');

  cd.wfPanel.classList.toggle('hidden', !wfVisible(cd));
  cd.specWrap.classList.toggle('hidden', !specVisible(cd));

  if (wfVisible(cd)) {
    requestAnimationFrame(() => {
      sizeCanvas(cd.base, cd.file.panelHeight);
      sizeCanvas(cd.overlay, cd.file.panelHeight);
      drawChannelWaveform(cd);
      drawAllCursors();
    });
  }
  if (specVisible(cd)) showChannelSpec(cd);
}

// =======================================================================
// Waveform drawing, zoom & interaction
// =======================================================================
function drawChannelWaveform(cd) {
  const v = cd.file.view;
  drawWaveform(cd.base, cd.data, {
    start: v.start,
    end: v.end,
    sampleRate: cd.file.settings.sampleRate,
    ampCenter: cd.ampView.center,
    ampRange: cd.ampView.range,
    color: '#4ea1ff',
    envelope: cd.envOn ? cd.envelope : null,
    selection: cd.file.selection
  });
  updateViewLabel(cd);
}

function updateViewLabel(cd) {
  const v = cd.file.view;
  const sr = cd.file.settings.sampleRate;
  cd.viewLabel.textContent = `${(v.start / sr).toFixed(3)}–${(v.end / sr).toFixed(3)}s`;
}

/** Redraw all visible views of a file after a shared (time) change. */
function redrawFileViews(file) {
  for (const cd of file.channelDom) {
    if (wfVisible(cd)) drawChannelWaveform(cd);
    if (specVisible(cd)) paintChannelSpec(cd); // cheap time re-crop, no recompute
  }
  drawAllCursors();
}

// ---- time (horizontal) zoom/pan — shared across a file's channels ----
function clampView(file, start, end) {
  const N = file.parsed.frameCount;
  let len = Math.round(end - start);
  len = Math.max(16, Math.min(N, len));
  let s = Math.round(start);
  if (s < 0) s = 0;
  if (s + len > N) s = N - len;
  if (s < 0) s = 0;
  file.view.start = s;
  file.view.end = s + len;
}

function zoomFile(file, factor, focusFrac = 0.5) {
  const v = file.view;
  const len = v.end - v.start;
  const focus = v.start + focusFrac * len;
  const newLen = len * factor;
  clampView(file, focus - focusFrac * newLen, focus - focusFrac * newLen + newLen);
  redrawFileViews(file);
}

function resetZoom(file) {
  file.view = { start: 0, end: file.parsed.frameCount };
  redrawFileViews(file);
}

/** Adjust the plot height for every channel of a file. */
function setFilePanelHeight(file, h) {
  h = Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, h | 0));
  file.panelHeight = h;
  for (const cd of file.channelDom) {
    cd.wfWrap.style.height = h + 'px';
    cd.specInner.style.height = h + 'px';
    cd.frInner.style.height = h + 'px';
    if (wfVisible(cd)) {
      sizeCanvas(cd.base, h);
      sizeCanvas(cd.overlay, h);
      drawChannelWaveform(cd);
    }
    if (specVisible(cd)) {
      sizeCanvas(cd.specCanvas, h);
      sizeCanvas(cd.specOverlay, h);
      ensureSpecImage(cd); // canvasHeight changed → key changes → rebuild
      paintChannelSpec(cd);
    }
    if (frVisible(cd)) renderChannelFr(cd);
  }
  drawAllCursors();
}

// ---- amplitude (vertical) zoom/pan — per waveform ----
function zoomAmp(cd, factor) {
  cd.ampView.range = Math.min(8, Math.max(1e-3, cd.ampView.range * factor));
  if (wfVisible(cd)) drawChannelWaveform(cd);
}
function panAmp(cd, startCenter, dyFrac, range) {
  // dyFrac in [-1,1] of plot height; full plot spans 2*range
  cd.ampView.center = Math.max(-8, Math.min(8, startCenter + dyFrac * range));
  if (wfVisible(cd)) drawChannelWaveform(cd);
}
function resetAmp(cd) {
  cd.ampView = { center: 0, range: 1 };
  if (wfVisible(cd)) drawChannelWaveform(cd);
}

// Shared wheel/drag interaction. `axis` handlers act when the pointer is over
// the left gutter; `time` handlers act over the plot area.
function attachAxisInteraction(wrapEl, cfg) {
  wrapEl.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = wrapEl.getBoundingClientRect();
    const overAxis = (ev.clientX - rect.left) < cfg.gutter;
    const factor = ev.deltaY < 0 ? 0.8 : 1.25;
    if (overAxis) cfg.onAxisZoom(factor);
    else {
      const plotW = Math.max(1, rect.width - cfg.gutter);
      const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left - cfg.gutter) / plotW));
      cfg.onTimeZoom(factor, frac);
    }
  }, { passive: false });

  const EDGE_PX = 6; // grab distance for a selection edge
  let drag = null;
  const fracAt = (clientX) => Math.min(1, Math.max(0, (clientX - drag.rectLeft - cfg.gutter) / drag.width));

  wrapEl.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const rect = wrapEl.getBoundingClientRect();
    const overAxis = (ev.clientX - rect.left) < cfg.gutter;
    const width = Math.max(1, rect.width - cfg.gutter);
    wrapEl.setPointerCapture(ev.pointerId);
    drag = {
      x0: ev.clientX, y0: ev.clientY, rectLeft: rect.left, width,
      height: Math.max(1, cfg.plotHeight()), overAxis, moved: false,
      mode: 'axis', startFrac: 0, lastA: 0, lastB: 0, ctx: null
    };
    if (overAxis) { drag.mode = 'axis'; drag.ctx = cfg.dragStart ? cfg.dragStart() : null; return; }

    const frac = (ev.clientX - rect.left - cfg.gutter) / width;
    // grab a selection edge if the pointer is near one (wider magnet when snap on)
    const edges = cfg.selectionFracs ? cfg.selectionFracs() : null;
    const edgeFrac = (state.snapEnabled ? MAG_PX : EDGE_PX) / width;
    let mode = null, startFrac = frac;
    if (edges && cfg.onSelect) {
      if (Math.abs(frac - edges[0]) <= edgeFrac) { mode = 'select'; startFrac = edges[1]; }      // left edge → right fixed
      else if (Math.abs(frac - edges[1]) <= edgeFrac) { mode = 'select'; startFrac = edges[0]; }  // right edge → left fixed
    }
    if (!mode) mode = ev.shiftKey ? 'pan' : (cfg.onSelect ? 'select' : 'pan');
    drag.mode = mode;
    drag.startFrac = startFrac;
    drag.lastA = Math.min(startFrac, frac);
    drag.lastB = Math.max(startFrac, frac);
    if (mode === 'pan') drag.ctx = cfg.dragStart ? cfg.dragStart() : null;
  });

  wrapEl.addEventListener('pointermove', (ev) => {
    if (!drag) {
      const rect = wrapEl.getBoundingClientRect();
      const width = Math.max(1, rect.width - cfg.gutter);
      const frac = (ev.clientX - rect.left - cfg.gutter) / width;
      // resize cursor when near a selection edge
      if (cfg.selectionFracs) {
        const edges = cfg.selectionFracs();
        const grab = (state.snapEnabled ? MAG_PX : EDGE_PX) / width;
        const near = edges && frac >= 0 &&
          (Math.abs(frac - edges[0]) <= grab || Math.abs(frac - edges[1]) <= grab);
        wrapEl.style.cursor = near ? 'ew-resize' : '';
      }
      if (cfg.onHover) cfg.onHover(frac); // update the hover bar
      return;
    }
    const dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    if (drag.mode === 'axis') cfg.onAxisPan(dy / drag.height, drag.ctx);
    else if (drag.mode === 'pan') cfg.onTimePan(dx / drag.width, drag.ctx);
    else if (drag.mode === 'select') {
      const f = fracAt(ev.clientX);
      drag.lastA = Math.min(drag.startFrac, f);
      drag.lastB = Math.max(drag.startFrac, f);
      cfg.onSelect(drag.lastA, drag.lastB, false);
    }
  });

  const endDrag = (ev) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) {
      if (!d.overAxis && cfg.onClick) {
        const plotW = Math.max(1, ev.currentTarget.getBoundingClientRect().width - cfg.gutter);
        const frac = Math.min(1, Math.max(0, (ev.clientX - d.rectLeft - cfg.gutter) / plotW));
        cfg.onClick(frac); // click = seek
      }
      return;
    }
    if (d.mode === 'select') cfg.onSelect(d.lastA, d.lastB, true);
  };
  wrapEl.addEventListener('pointerup', endDrag);
  wrapEl.addEventListener('pointercancel', () => { drag = null; });
  wrapEl.addEventListener('pointerleave', () => { if (cfg.onHoverLeave) cfg.onHoverLeave(); });
}

/** The file's selection edges as fractions of the current view (or null). */
function selectionFracsOf(file) {
  if (!file.selection) return null;
  const v = file.view;
  const len = v.end - v.start;
  if (len <= 0) return null;
  return [(file.selection.start - v.start) / len, (file.selection.end - v.start) / len];
}

/** Map a plot [0,1] fraction pair to samples in the file's current view. */
function selectionFromFracs(file, aFrac, bFrac, done) {
  const v = file.view;
  const len = v.end - v.start;
  setFileSelection(file, Math.round(v.start + aFrac * len), Math.round(v.start + bFrac * len), done);
}

function setupWaveformInteraction(cd) {
  const file = cd.file;
  attachAxisInteraction(cd.wfWrap, {
    gutter: WF_LEFT,
    plotHeight: () => cd.base.height - WF_BOTTOM,
    onTimeZoom: (factor, frac) => zoomFile(file, factor, frac),
    onAxisZoom: (factor) => zoomAmp(cd, factor),
    dragStart: () => ({ v0: { ...file.view }, center0: cd.ampView.center }),
    onTimePan: (dxFrac, ctx) => {
      const len = ctx.v0.end - ctx.v0.start;
      clampView(file, ctx.v0.start - dxFrac * len, ctx.v0.end - dxFrac * len);
      redrawFileViews(file);
    },
    onAxisPan: (dyFrac, ctx) => panAmp(cd, ctx.center0, dyFrac, cd.ampView.range),
    onSelect: (a, b, done) => selectionFromFracs(file, a, b, done),
    selectionFracs: () => selectionFracsOf(file),
    onHover: (frac) => setHover(cd, 'wf', frac),
    onHoverLeave: () => clearHoverOn(cd, 'wf'),
    onClick: (frac) => {
      const v = file.view;
      const sample = v.start + frac * (v.end - v.start);
      seekFileSeconds(file, sample / file.settings.sampleRate);
    }
  });
}

function setupSpecInteraction(cd) {
  const file = cd.file;
  attachAxisInteraction(cd.specInner, {
    gutter: LEFT_GUTTER,
    plotHeight: () => cd.specCanvas.height - 18,
    onTimeZoom: (factor, frac) => zoomFile(file, factor, frac),
    onAxisZoom: (factor) => zoomFreq(cd, factor),
    dragStart: () => ({ v0: { ...file.view }, freq0: effectiveFreqRange(cd) }),
    onTimePan: (dxFrac, ctx) => {
      const len = ctx.v0.end - ctx.v0.start;
      clampView(file, ctx.v0.start - dxFrac * len, ctx.v0.end - dxFrac * len);
      redrawFileViews(file);
    },
    onAxisPan: (dyFrac, ctx) => panFreq(cd, ctx.freq0, dyFrac),
    onSelect: (a, b, done) => selectionFromFracs(file, a, b, done),
    selectionFracs: () => selectionFracsOf(file),
    onHover: (frac) => setHover(cd, 'spec', frac),
    onHoverLeave: () => clearHoverOn(cd, 'spec'),
    onClick: (frac) => {   // click on the spectrogram seeks like the waveform
      const v = file.view;
      const sample = v.start + frac * (v.end - v.start);
      seekFileSeconds(file, sample / file.settings.sampleRate);
    }
  });
}

// =======================================================================
// Hilbert amplitude envelope (RMS-like overlay)
// =======================================================================
function envKeyFor(cd) { return String(cd.data.length); }

function enableEnvelope(cd, on) {
  cd.envOn = on;
  cd.envBtn.classList.toggle('active', on);
  if (on) {
    const key = envKeyFor(cd);
    if (!cd.envelope || cd.envKey !== key) {
      const sr = cd.file.settings.sampleRate;
      cd.envelope = hilbertEnvelope(cd.data, { smooth: Math.max(1, Math.round(sr * 0.002)) });
      cd.envKey = key;
    }
  }
}

function toggleEnvelope(cd) {
  const turnOn = !cd.envOn;
  if (turnOn) {
    cd.envBtn.textContent = '…';
    setTimeout(() => {
      enableEnvelope(cd, true);
      cd.envBtn.textContent = 'RMS env';
      if (wfVisible(cd)) drawChannelWaveform(cd);
    }, 10);
  } else {
    enableEnvelope(cd, false);
    if (wfVisible(cd)) drawChannelWaveform(cd);
  }
}

// =======================================================================
// Per-channel spectrogram
// =======================================================================
function matrixKeyFor(data) {
  return `${specSettings.windowType}|${specSettings.fftSize}|${specSettings.overlap}|${data.length}`;
}

function ensureMatrix(cd) {
  const key = matrixKeyFor(cd.data);
  if (cd.matrix && cd.matrixKey === key) return;
  cd.matrix = computeSpectrogramMatrix(cd.data, {
    windowType: specSettings.windowType,
    fftSize: specSettings.fftSize,
    overlap: specSettings.overlap,
    maxCols: Math.max(600, cd.specCanvas.width || 1200)
  });
  cd.matrixKey = key;
}

// Effective concrete frequency range for a channel (per-channel override or global).
function effectiveFreqRange(cd) {
  const nyq = cd.file.settings.sampleRate / 2;
  const scale = specSettings.scale;
  let fMin = cd.freqView.min != null ? cd.freqView.min : specSettings.fMin;
  let fMax = cd.freqView.max != null ? cd.freqView.max : specSettings.fMax;
  fMin = effectiveFMin(scale, fMin ?? 0, nyq);
  fMax = fMax > 0 ? Math.min(fMax, nyq) : nyq;
  if (fMax <= fMin) { fMin = effectiveFMin(scale, 0, nyq); fMax = nyq; }
  return { fMin, fMax };
}

function specImageKeyFor(cd) {
  const f = effectiveFreqRange(cd);
  return [cd.matrixKey, specSettings.scale, f.fMin.toFixed(3), f.fMax.toFixed(3),
    specSettings.dbMin, specSettings.dbMax, cd.specCanvas.height].join('|');
}

/** (Re)build the frequency-mapped image if any influencing setting changed. */
function ensureSpecImage(cd) {
  if (!cd.matrix) return;
  const key = specImageKeyFor(cd);
  if (cd.specImage && cd.specImageKey === key) return;
  const f = effectiveFreqRange(cd);
  cd.specImage = buildSpectrogramImage(cd.matrix, {
    sampleRate: cd.file.settings.sampleRate,
    scale: specSettings.scale,
    fMin: f.fMin,
    fMax: f.fMax,
    dbMin: specSettings.dbMin,
    dbMax: specSettings.dbMax,
    canvasHeight: cd.specCanvas.height
  });
  cd.specImageKey = key;
}

/** Paint the (already built) spectrogram image with the current time window. */
function paintChannelSpec(cd) {
  if (!cd.specImage) return;
  const v = cd.file.view;
  const sel = cd.file.selection;
  paintSpectrogram(cd.specCanvas, cd.specImage, {
    sampleRate: cd.file.settings.sampleRate,
    viewStart: v.start,
    viewEnd: v.end,
    selStart: sel ? sel.start : null,
    selEnd: sel ? sel.end : null
  });
}

/** Ensure matrix + image are ready (async), then paint. */
function showChannelSpec(cd, recompute) {
  cd.specStatus.classList.remove('hidden');
  cd.specCanvas.classList.add('dim');
  if (recompute) { cd.matrixKey = ''; cd.specImageKey = ''; }
  setTimeout(() => {
    sizeCanvas(cd.specCanvas, cd.file.panelHeight);
    sizeCanvas(cd.specOverlay, cd.file.panelHeight);
    ensureMatrix(cd);
    ensureSpecImage(cd);
    paintChannelSpec(cd);
    drawAllCursors();
    cd.specStatus.classList.add('hidden');
    cd.specCanvas.classList.remove('dim');
  }, 10);
}

// ---- frequency (vertical) zoom/pan — per spectrogram ----
function zoomFreq(cd, factor) {
  const scale = specSettings.scale;
  const nyq = cd.file.settings.sampleRate / 2;
  const { fMin, fMax } = effectiveFreqRange(cd);
  const sMin = scaleForward(scale, fMin), sMax = scaleForward(scale, fMax);
  const center = (sMin + sMax) / 2;
  const half = ((sMax - sMin) / 2) * factor;
  const loF = scaleInverse(scale, center - half);
  const hiF = scaleInverse(scale, center + half);
  cd.freqView.min = Math.max(0, loF);
  cd.freqView.max = Math.min(nyq, hiF);
  showChannelSpec(cd);
}
function panFreq(cd, startRange, dyFrac) {
  const scale = specSettings.scale;
  const nyq = cd.file.settings.sampleRate / 2;
  const sMin = scaleForward(scale, startRange.fMin), sMax = scaleForward(scale, startRange.fMax);
  const shift = dyFrac * (sMax - sMin); // drag down → view moves down
  let loF = scaleInverse(scale, sMin + shift);
  let hiF = scaleInverse(scale, sMax + shift);
  if (loF < 0) { hiF -= loF; loF = 0; }
  if (hiF > nyq) { loF -= (hiF - nyq); hiF = nyq; if (loF < 0) loF = 0; }
  cd.freqView.min = loF;
  cd.freqView.max = hiF;
  showChannelSpec(cd);
}
function resetFreq(cd) {
  cd.freqView = { min: null, max: null };
  showChannelSpec(cd);
}

/** Rebuild + repaint every visible spectrogram (spec settings changed). */
function refreshAllSpectrograms(recompute) {
  for (const f of state.files) {
    for (const cd of f.channelDom) {
      if (!specVisible(cd)) continue;
      cd.freqView = { min: null, max: null }; // global change resets per-channel freq zoom
      showChannelSpec(cd, recompute);
    }
  }
}

// =======================================================================
// Frequency response of the selected region
// =======================================================================
function frVisible(cd) { return cd.plotOn && !!cd.file.selection; }

function frKeyFor(cd) {
  const sel = cd.file.selection;
  return `${sel.start}-${sel.end}|${frSettings.windowType}|${frSettings.fftSize}|${frSettings.overlap}|${cd.data.length}`;
}

function ensureFr(cd) {
  if (!cd.file.selection) return;
  const key = frKeyFor(cd);
  if (cd.frResp && cd.frKey === key) return;
  cd.frResp = frequencyResponse(cd.data, cd.file.selection.start, cd.file.selection.end, {
    windowType: frSettings.windowType,
    fftSize: frSettings.fftSize,
    overlap: frSettings.overlap
  });
  cd.frKey = key;
}

function renderChannelFr(cd) {
  if (!frVisible(cd)) return;
  sizeCanvas(cd.frCanvas, cd.file.panelHeight);
  ensureFr(cd);
  renderFreqResponse(cd.frCanvas, cd.frResp, {
    sampleRate: cd.file.settings.sampleRate,
    scale: frSettings.scale,
    fMin: frSettings.fMin,
    fMax: frSettings.fMax,
    dbMin: frSettings.dbMin,
    dbMax: frSettings.dbMax
  });
  const sr = cd.file.settings.sampleRate;
  const sel = cd.file.selection;
  cd.frLabel.textContent =
    `Freq response · ${(sel.start / sr).toFixed(3)}–${(sel.end / sr).toFixed(3)}s` +
    (cd.frResp ? ` · ${cd.frResp.frames} frame${cd.frResp.frames === 1 ? '' : 's'} × ${cd.frResp.fftSize}` : '');
}

/** Show/hide a channel's FR panel to match plot + selection state. */
function updateFrVisibility(cd) {
  const show = frVisible(cd);
  cd.frPanel.classList.toggle('hidden', !show);
  if (show) requestAnimationFrame(() => renderChannelFr(cd));
}

/** Re-render every visible FR panel (settings changed). */
function refreshAllFr(recompute) {
  for (const f of state.files) {
    for (const cd of f.channelDom) {
      if (!frVisible(cd)) continue;
      if (recompute) cd.frKey = '';
      renderChannelFr(cd);
    }
  }
}

// ---- selection (analysis region) ----

/** Another file's current selection, as a time grid (seconds). */
function referenceSelectionFor(file) {
  for (const f of state.files) {
    if (f.id !== file.id && f.selection) {
      const sr = f.settings.sampleRate;
      const startSec = f.selection.start / sr;
      const lenSec = (f.selection.end - f.selection.start) / sr;
      return { startSec, lenSec };
    }
  }
  return null;
}

/** Snap a time (s) onto the grid {refStart + k·refLen}, within 20% of the spacing. */
function snapToGrid(t, ref) {
  const grid = ref.lenSec;
  if (!(grid > 0)) return t;
  const k = Math.round((t - ref.startSec) / grid);
  const gridT = ref.startSec + k * grid;
  return Math.abs(t - gridT) <= grid * 0.2 ? gridT : t;
}

function setFileSelection(file, s, e, done) {
  let a = Math.min(s, e);
  let b = Math.max(s, e);
  // grid-snap to another track's selected range for alignment
  if (state.snapEnabled) {
    const ref = referenceSelectionFor(file);
    if (ref) {
      const sr = file.settings.sampleRate;
      const na = Math.round(snapToGrid(a / sr, ref) * sr);
      const nb = Math.round(snapToGrid(b / sr, ref) * sr);
      a = Math.min(na, nb);
      b = Math.max(na, nb);
    }
  }
  a = Math.max(0, a);
  b = Math.min(file.parsed.frameCount, b);
  const minLen = Math.max(2, Math.round(file.settings.sampleRate * 0.0005));
  if (done && b - a < minLen) { clearFileSelection(file); return; }
  file.selection = { start: a, end: b };
  if (file.dom) file.dom.dataset.sel = `${a},${b}`;
  redrawFileViews(file);                       // draw the band on wf/spec
  for (const cd of file.channelDom) cd.frKey = ''; // region changed → recompute
  if (done) {
    for (const cd of file.channelDom) updateFrVisibility(cd);
  }
}

function clearFileSelection(file) {
  file.selection = null;
  if (file.dom) file.dom.dataset.sel = '';
  redrawFileViews(file);
  for (const cd of file.channelDom) cd.frPanel.classList.add('hidden');
}

// =======================================================================
// Playback
// =======================================================================
let playerKey = ''; // signature of the checked channels currently loaded

/** Checked (export-selected) channel indices of a file. */
function checkedChannels(file) {
  return state.exportOrder
    .filter((e) => e.fileId === file.id)
    .map((e) => e.ch)
    .sort((a, b) => a - b);
}
function checkedKey(file) {
  return file.id + ':' + checkedChannels(file).join(',');
}

/**
 * Build the playback buffer channels from the checked channels only.
 *
 * We must NOT hand Web Audio an N-channel buffer with unchecked channels
 * zero-filled: for channel counts without a defined speaker layout (3, 5, …)
 * the "speakers" down-mix falls back to "discrete", which keeps only the first
 * two channels and DROPS the rest — so e.g. the 3rd channel of a 3-ch file would
 * be silent. Instead we pass only the checked channels: 1 → mono, 2 → stereo,
 * and >2 are summed to mono so every checked channel is audible.
 */
function buildPlaybackChannels(file) {
  const checked = checkedChannels(file);
  if (checked.length === 0) return null;
  const src = checked.map((ch) => file.parsed.channels[ch]);
  if (src.length <= 2) return src; // mono / stereo → direct, no dropping
  const N = file.parsed.frameCount;
  const mono = new Float32Array(N);
  const inv = 1 / src.length;
  for (const c of src) for (let i = 0; i < c.length; i++) mono[i] += c[i] * inv;
  return [mono];
}

/** Load a file's checked-only channels into the player. */
function loadFileIntoPlayer(file) {
  const chans = buildPlaybackChannels(file);
  if (!chans) return false;
  player.load(file.id, chans, file.settings.sampleRate);
  activeFileId = file.id;
  playerKey = checkedKey(file);
  return true;
}

function togglePlay(file, btn, timeLabel) {
  if (player.playing && activeFileId === file.id) {
    player.pause();
    updatePlayButton(file, btn, timeLabel);
    return;
  }
  // (re)load when switching files or when the checked set changed
  if (activeFileId !== file.id || playerKey !== checkedKey(file)) {
    if (!loadFileIntoPlayer(file)) {
      setStatus('재생할 채널이 없습니다 — 이 파일에서 채널을 하나 이상 체크하세요.');
      updatePlayButton(file, btn, timeLabel);
      return;
    }
  }
  pausePreview();
  player.play();
  startCursorLoop();
  updatePlayButton(file, btn, timeLabel);
}

function seekFileSeconds(file, seconds) {
  pausePreview();
  if (activeFileId !== file.id || playerKey !== checkedKey(file)) {
    if (!loadFileIntoPlayer(file)) {
      setStatus('재생할 채널이 없습니다 — 이 파일에서 채널을 하나 이상 체크하세요.');
      return;
    }
  }
  player.seek(seconds);
  if (player.playing) startCursorLoop(); // keep the cursor moving from the new spot
  else drawAllCursors();
}

/** Live-update the active file's audio when its checked channels change. */
function refreshActivePlayback(file) {
  if (activeFileId !== file.id) return;
  if (playerKey === checkedKey(file)) return;
  const wasPlaying = player.playing;
  const t = player.currentTime;
  if (!loadFileIntoPlayer(file)) {   // nothing checked now
    player.stop();
    updatePlayButton(file);
    clearCursors();
    return;
  }
  player.seek(t);
  if (wasPlaying) player.play();
  updatePlayButton(file);
}

function updatePlayButton(file, btn, timeLabel) {
  btn = btn || file.dom._playBtn;
  timeLabel = timeLabel || file.dom._timeLabel;
  btn.textContent = player.playing && activeFileId === file.id ? '⏸ Pause' : '▶ Play';
}

player.onEnded = () => {
  const f = state.files.find((x) => x.id === activeFileId);
  if (f) updatePlayButton(f);
  clearCursors();
};

let cursorRAF = null;
function startCursorLoop() {
  if (cursorRAF) return;
  const tick = () => {
    drawAllCursors();
    const f = state.files.find((x) => x.id === activeFileId);
    if (f) f.dom._timeLabel.textContent = `${timeStr(player.currentTime)} / ${timeStr(player.duration)}`;
    if (player.playing) {
      cursorRAF = requestAnimationFrame(tick);
    } else {
      cursorRAF = null;
    }
  };
  cursorRAF = requestAnimationFrame(tick);
}

// hover indicator (light vertical bar following the mouse)
let hover = { cd: null, kind: null, frac: -1 };

/** Playhead position as a fraction of the file's current view, or -1 if hidden. */
function playbackFrac(file) {
  if (activeFileId !== file.id || !file.parsed) return -1;
  const sr = file.settings.sampleRate;
  const cur = player.currentTime * sr;
  const v = file.view;
  const len = v.end - v.start;
  if (len <= 0) return -1;
  return (cur - v.start) / len;
}

/** Repaint one overlay: playback cursor (red) + hover bar (light white). */
function paintOverlay(cd, kind) {
  const canvas = kind === 'wf' ? cd.overlay : cd.specOverlay;
  if (!canvas || !canvas.width) return;
  clearOverlay(canvas);
  const pos = playbackFrac(cd.file);
  if (pos >= 0 && pos <= 1) drawCursor(canvas, pos, '#ff5c5c');
  if (hover.cd === cd && hover.kind === kind && hover.frac >= 0 && hover.frac <= 1) {
    drawCursor(canvas, hover.frac, 'rgba(255,255,255,0.5)');
  }
}

function drawAllCursors() {
  const f = state.files.find((x) => x.id === activeFileId);
  if (!f || !f.parsed) return;
  for (const cd of f.channelDom) {
    if (wfVisible(cd)) paintOverlay(cd, 'wf');
    if (specVisible(cd)) paintOverlay(cd, 'spec');
  }
}

const MAG_PX = 10; // magnetic pull distance to a selection edge (px)

/** Update the hover bar for a plot; magnet-snap to a selection edge when enabled. */
function setHover(cd, kind, rawFrac) {
  if (rawFrac < 0 || rawFrac > 1) { clearHoverOn(cd, kind); return; }
  let frac = rawFrac;
  if (state.snapEnabled && cd.file.selection) {
    const edges = selectionFracsOf(cd.file);
    if (edges) {
      const canvas = kind === 'wf' ? cd.overlay : cd.specOverlay;
      const plotW = Math.max(1, (canvas._cssW || canvas.width) - 46);
      const mag = MAG_PX / plotW;
      if (Math.abs(rawFrac - edges[0]) <= mag) frac = edges[0];
      else if (Math.abs(rawFrac - edges[1]) <= mag) frac = edges[1];
    }
  }
  const prev = hover;
  hover = { cd, kind, frac };
  if (prev.cd && (prev.cd !== cd || prev.kind !== kind)) paintOverlay(prev.cd, prev.kind);
  paintOverlay(cd, kind);
}

function clearHoverOn(cd, kind) {
  if (hover.cd === cd && hover.kind === kind) {
    hover = { cd: null, kind: null, frac: -1 };
    paintOverlay(cd, kind);
  }
}

function clearCursors() {
  for (const f of state.files) {
    for (const cd of f.channelDom) {
      clearOverlay(cd.overlay);
      if (cd.specOverlay) clearOverlay(cd.specOverlay);
    }
  }
}

function clearOverlay(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); // clear the raw device buffer
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// =======================================================================
// Mixed N-channel preview
// =======================================================================
let previewRAF = null;
let previewKey = '';

previewPlayer.onEnded = () => { updatePreviewButton(); updatePreviewProgress(); };

/** Signature of the current selection + rate, to detect when a reload is needed. */
function selectionKey() {
  return state.exportOrder.map((e) => e.fileId + ':' + e.ch).join(',') + '@' + $('#export-sr').value + '|' + state.lengthMode;
}

/** Down-mix all selected channels to a single mono monitor track (averaged). */
function buildPreviewMix() {
  const chans = state.exportOrder
    .map((e) => { const f = state.files.find((x) => x.id === e.fileId); return f ? f.parsed.channels[e.ch] : null; })
    .filter(Boolean);
  if (!chans.length) return null;
  const sampleRate = Math.max(1, parseInt($('#export-sr').value) || 48000);
  const len = state.lengthMode === 'shortest'
    ? chans.reduce((m, c) => Math.min(m, c.length), Infinity)
    : chans.reduce((m, c) => Math.max(m, c.length), 0);
  const mix = new Float32Array(len);
  const inv = 1 / chans.length;
  for (const c of chans) {
    const n = Math.min(c.length, len);
    for (let i = 0; i < n; i++) mix[i] += c[i] * inv;
  }
  return { channels: [mix], sampleRate };
}

function togglePreview() {
  if (!state.exportOrder.length) return;
  if (previewPlayer.playing) {
    previewPlayer.pause();
    updatePreviewButton();
    return;
  }
  const key = selectionKey();
  if (previewKey !== key || !previewPlayer.buffer) {
    const mix = buildPreviewMix();
    if (!mix) return;
    previewPlayer.load('preview', mix.channels, mix.sampleRate);
    previewKey = key;
  }
  stopFilePlayback();
  previewPlayer.play();
  startPreviewLoop();
  updatePreviewButton();
}

function pausePreview() {
  if (previewPlayer.playing) {
    previewPlayer.pause();
    updatePreviewButton();
  }
}

function startPreviewLoop() {
  if (previewRAF) return;
  const tick = () => {
    updatePreviewProgress();
    previewRAF = previewPlayer.playing ? requestAnimationFrame(tick) : null;
  };
  previewRAF = requestAnimationFrame(tick);
}

function updatePreviewButton() {
  $('#preview-btn').textContent = previewPlayer.playing ? '⏸ Pause mix' : '▶ Preview mix';
}

function updatePreviewProgress() {
  const d = previewPlayer.duration || 0;
  const t = previewPlayer.currentTime || 0;
  $('#preview-time').textContent = `${timeStr(t)} / ${timeStr(d)}`;
  $('#preview-prog').style.width = (d ? (t / d) * 100 : 0) + '%';
}

/** Called whenever the export selection changes. */
function updatePreviewControls() {
  const has = state.exportOrder.length > 0;
  const btn = $('#preview-btn');
  const info = $('#preview-info');
  btn.disabled = !has;
  info.textContent = has ? `Mixing ${state.exportOrder.length} channel(s) → mono monitor` : 'Select channels to preview';
  // selection changed → stop any running preview and force a rebuild next play
  if (previewPlayer.playing) previewPlayer.stop();
  previewKey = '';
  updatePreviewButton();
  updatePreviewProgress();
}

/** Stop per-file playback (used when the mixed preview takes over). */
function stopFilePlayback() {
  if (player.playing) {
    player.pause();
    const f = state.files.find((x) => x.id === activeFileId);
    if (f) updatePlayButton(f);
  }
}

// =======================================================================
// Export selection
// =======================================================================
function toggleExport(file, ch, on) {
  const idx = state.exportOrder.findIndex((e) => e.fileId === file.id && e.ch === ch);
  if (on && idx === -1) state.exportOrder.push({ fileId: file.id, ch });
  else if (!on && idx !== -1) state.exportOrder.splice(idx, 1);
  updateExportPanel();
  refreshActivePlayback(file); // keep per-file playback in sync with checks
}

function updateExportPanel() {
  const list = $('#export-list');
  list.innerHTML = '';
  state.exportOrder.forEach((entry, i) => {
    const file = state.files.find((f) => f.id === entry.fileId);
    if (!file) return;
    const row = el('div', { class: 'exp-row' }, [
      el('span', { class: 'exp-idx', textContent: `#${i}` }),
      el('span', { class: 'exp-name', textContent: `${file.name} · Ch ${entry.ch}` }),
      el('button', { class: 'btn tiny ghost', textContent: '↑', onclick: () => moveExport(i, -1) }),
      el('button', { class: 'btn tiny ghost', textContent: '↓', onclick: () => moveExport(i, 1) }),
      el('button', { class: 'btn tiny ghost', textContent: '✕', onclick: () => {
        const f = state.files.find((x) => x.id === entry.fileId);
        state.exportOrder.splice(i, 1);
        syncCheckboxes();
        updateExportPanel();
        if (f) refreshActivePlayback(f);
      } })
    ]);
    list.appendChild(row);
  });

  const count = state.exportOrder.length;
  $('#export-count').textContent = `${count} channel${count === 1 ? '' : 's'} selected`;
  $('#export-btn').disabled = count === 0;
  updatePreviewControls();
  updateAllMixNotes();

  // in auto mode, keep the suggested filename in sync with the channel count
  if ($('#export-auto').checked) {
    $('#export-name').value = autoExportName(count);
  }

  // sample-rate consistency check
  const rates = new Set(state.exportOrder.map((e) => {
    const f = state.files.find((x) => x.id === e.fileId);
    return f ? f.settings.sampleRate : 0;
  }));
  const warn = $('#export-warn');
  if (rates.size > 1) {
    warn.textContent = '⚠ Selected channels have different sample rates. Export uses the rate below; no resampling is performed.';
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
    if (rates.size === 1) $('#export-sr').value = [...rates][0];
  }
}

function moveExport(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.exportOrder.length) return;
  const tmp = state.exportOrder[i];
  state.exportOrder[i] = state.exportOrder[j];
  state.exportOrder[j] = tmp;
  updateExportPanel();
}

function syncCheckboxes() {
  for (const f of state.files) {
    f.channelDom.forEach((cd, ch) => {
      cd.checkbox.checked = state.exportOrder.some((e) => e.fileId === f.id && e.ch === ch);
    });
  }
}

async function doExport() {
  if (state.exportOrder.length === 0) return;
  const sampleRate = Math.max(1, parseInt($('#export-sr').value) || 48000);
  const depthVal = $('#export-depth').value;
  const float = depthVal === 'f32';
  const bitDepth = float ? 32 : parseInt(depthVal);

  const channels = state.exportOrder.map((e) => {
    const f = state.files.find((x) => x.id === e.fileId);
    return f.parsed.channels[e.ch];
  });

  // Warn if selected channels differ in length; let the user decide.
  const lengths = channels.map((c) => c.length);
  const minLen = Math.min(...lengths);
  const maxLen = Math.max(...lengths);
  if (minLen !== maxLen) {
    const sr = sampleRate;
    const shortest = state.lengthMode === 'shortest';
    const tail = shortest
      ? `계속하면 긴 채널은 끝부분이 잘려 가장 짧은 ${minLen.toLocaleString()} 프레임 길이로 저장됩니다.`
      : `계속하면 짧은 채널은 끝부분이 무음으로 채워져 가장 긴 ${maxLen.toLocaleString()} 프레임 길이로 저장됩니다.`;
    const msg =
      `선택한 채널들의 길이가 다릅니다.\n\n` +
      `가장 짧은 채널: ${minLen.toLocaleString()} 프레임 (${timeStr(minLen / sr)})\n` +
      `가장 긴 채널: ${maxLen.toLocaleString()} 프레임 (${timeStr(maxLen / sr)})\n\n` +
      `${tail}\n그대로 저장할까요?`;
    if (!window.confirm(msg)) {
      setStatus('Export canceled — channel lengths differ.');
      return;
    }
  }

  const outName = currentExportName(channels.length);

  const btn = $('#export-btn');
  btn.disabled = true;
  btn.textContent = 'Encoding…';
  await new Promise((r) => setTimeout(r, 10));

  try {
    const wav = encodeWav(channels, sampleRate, { bitDepth, float, fit: state.lengthMode });
    const res = await window.api.saveWav(wav, outName, state.lastSaveDir);
    if (res.saved) {
      state.lastSaveDir = res.dir || state.lastSaveDir;
      // in auto mode, refresh to a new timestamped name; else reflect what was saved
      $('#export-name').value = $('#export-auto').checked
        ? autoExportName(channels.length)
        : res.name;
      setRecentPath(res.path);
      setStatus(`Exported ${channels.length}-channel WAV → ${res.path}`);
    } else {
      setStatus('Export canceled.');
    }
  } catch (err) {
    setStatus('Export failed: ' + err.message);
  } finally {
    btn.textContent = 'Export WAV';
    btn.disabled = false;
  }
}

/** Local timestamp like 20260723_204512 for auto file names. */
function fileTimestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function autoExportName(count) {
  return `export_${count}ch_${fileTimestamp()}.wav`;
}

/** Current filename to save: auto (fresh timestamp) or the manual input value. */
function currentExportName(count) {
  if ($('#export-auto').checked) return autoExportName(count);
  let name = ($('#export-name').value || '').trim();
  if (!name) name = autoExportName(count);
  if (!/\.wav$/i.test(name)) name += '.wav';
  return name;
}

function setRecentPath(p) {
  const box = $('#export-recent');
  box.textContent = p;
  box.title = p;
}

// =======================================================================
// File open / remove
// =======================================================================
async function openFiles() {
  const metas = await window.api.openPcmFiles();
  await ingestFiles(metas);
}

/**
 * Read, parse and render a list of file metadata {path, name, size}.
 * Shared by the Open dialog and drag-and-drop.
 */
async function ingestFiles(metas) {
  let opened = 0;
  for (const meta of metas) {
    let buffer;
    try {
      buffer = await window.api.readFile(meta.path);
    } catch (err) {
      setStatus('Failed to read ' + meta.name + ': ' + err.message);
      continue;
    }
    const file = makeFile(meta, buffer);
    try {
      parseFile(file);
    } catch (err) {
      setStatus('Failed to parse ' + meta.name + ': ' + err.message);
      continue;
    }
    state.files.push(file);
    renderFile(file);
    opened++;
  }
  if (opened) setStatus(`Opened ${opened} file(s).`);
  updateExportPanel();
}

// =======================================================================
// Drag & drop
// =======================================================================
function setupDragAndDrop() {
  const overlay = $('#drop-overlay');
  let depth = 0; // track nested dragenter/leave

  const show = () => overlay.classList.add('active');
  const hide = () => { depth = 0; overlay.classList.remove('active'); };

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    show();
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth--;
    if (depth <= 0) hide();
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    hide();
    const list = e.dataTransfer && e.dataTransfer.files;
    if (!list || !list.length) return;
    const metas = [];
    for (const f of list) {
      let filePath = '';
      try { filePath = window.api.pathForFile(f); } catch (_) {}
      if (!filePath) continue; // skip non-file drops (text, etc.)
      metas.push({ path: filePath, name: f.name, size: f.size });
    }
    if (metas.length) await ingestFiles(metas);
    else setStatus('Nothing to open — drop raw PCM files.');
  });
}

function hasFiles(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types) {
    for (const t of dt.types) if (t === 'Files') return true;
    return false;
  }
  return true;
}

function removeFile(file) {
  if (activeFileId === file.id) { player.stop(); activeFileId = null; }
  unobserveChannels(file);
  state.exportOrder = state.exportOrder.filter((e) => e.fileId !== file.id);
  state.files = state.files.filter((f) => f.id !== file.id);
  file.dom.remove();
  updateExportPanel();
}

function setStatus(msg) {
  $('#status').textContent = msg;
}

// =======================================================================
// Global spectrogram controls
// =======================================================================
function fillSelect(sel, entries, value) {
  for (const [key, labelOrVal] of entries) {
    const o = el('option', { value: String(key), textContent: String(labelOrVal) });
    if (String(key) === String(value)) o.selected = true;
    sel.appendChild(o);
  }
}

// =======================================================================
// New-file setting presets (persisted in localStorage)
// =======================================================================
const PRESET_KEY = 'pcmparser.presets.v1';

function loadPresets() {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || []; }
  catch (_) { return []; }
}
function storePresets(list) {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(list)); } catch (_) {}
}

function renderPresetList(selectedName) {
  const sel = $('#preset-select');
  const list = loadPresets();
  sel.innerHTML = '';
  sel.appendChild(el('option', { value: '', textContent: list.length ? '— select preset —' : '— no presets —' }));
  for (const p of list) {
    const o = el('option', { value: p.name, textContent: p.name });
    if (p.name === selectedName) o.selected = true;
    sel.appendChild(o);
  }
  $('#preset-del').disabled = !sel.value;
}

/** Apply a preset object to the defaults + the def-* inputs. */
function applyDefaults(d) {
  defaults.format = d.format;
  defaults.channels = d.channels;
  defaults.sampleRate = d.sampleRate;
  defaults.headerBytes = d.headerBytes;
  $('#def-format').value = d.format;
  $('#def-channels').value = d.channels;
  $('#def-sr').value = d.sampleRate;
  $('#def-header').value = d.headerBytes;
}

function setupPresets() {
  renderPresetList('');

  $('#preset-select').onchange = (e) => {
    const name = e.target.value;
    $('#preset-del').disabled = !name;
    if (!name) return;
    const p = loadPresets().find((x) => x.name === name);
    if (p) { applyDefaults(p); setStatus(`프리셋 적용됨: ${name}`); }
  };

  const saveCurrent = () => {
    const nameInput = $('#preset-name');
    const typed = (nameInput.value || '').trim();
    const name = typed || `${defaults.format} · ${defaults.channels}ch · ${defaults.sampleRate}Hz`;
    const list = loadPresets().filter((p) => p.name !== name); // overwrite same name
    list.push({
      name,
      format: defaults.format,
      channels: defaults.channels,
      sampleRate: defaults.sampleRate,
      headerBytes: defaults.headerBytes
    });
    storePresets(list);
    nameInput.value = '';
    renderPresetList(name);
    setStatus(`프리셋 저장됨: ${name}`);
  };
  $('#preset-save').onclick = saveCurrent;
  $('#preset-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCurrent(); });

  $('#preset-del').onclick = () => {
    const name = $('#preset-select').value;
    if (!name) return;
    storePresets(loadPresets().filter((p) => p.name !== name));
    renderPresetList('');
    setStatus(`프리셋 삭제됨: ${name}`);
  };
}

function setupSpecControls() {
  const win = $('#spec-window');
  fillSelect(win, Object.entries(WINDOWS), specSettings.windowType);

  const size = $('#spec-size');
  fillSelect(size, [256, 512, 1024, 2048, 4096, 8192].map((n) => [n, n]), specSettings.fftSize);

  const overlap = $('#spec-overlap');
  fillSelect(overlap, [[0, '0%'], [0.5, '50%'], [0.75, '75%'], [0.875, '87.5%']], specSettings.overlap);

  const scale = $('#spec-scale');
  fillSelect(scale, Object.entries(SCALES), specSettings.scale);

  // compute-affecting controls → recompute matrices
  win.onchange = () => { specSettings.windowType = win.value; refreshAllSpectrograms(true); };
  size.onchange = () => { specSettings.fftSize = parseInt(size.value); refreshAllSpectrograms(true); };
  overlap.onchange = () => { specSettings.overlap = parseFloat(overlap.value); refreshAllSpectrograms(true); };

  // render-only controls → just re-render
  scale.onchange = () => { specSettings.scale = scale.value; refreshAllSpectrograms(false); };

  const bindNum = (id, key, fallback) => {
    const inp = $(id);
    inp.onchange = () => {
      const v = inp.value.trim();
      specSettings[key] = v === '' ? fallback : Number(v);
      refreshAllSpectrograms(false);
    };
  };
  bindNum('#spec-fmin', 'fMin', 0);
  bindNum('#spec-fmax', 'fMax', 0);   // blank = auto (Nyquist)
  bindNum('#spec-dbmin', 'dbMin', -100);
  bindNum('#spec-dbmax', 'dbMax', -10);
}

function setupFrControls() {
  fillSelect($('#fr-window'), Object.entries(WINDOWS), frSettings.windowType);
  fillSelect($('#fr-size'), [256, 512, 1024, 2048, 4096, 8192, 16384].map((n) => [n, n]), frSettings.fftSize);
  fillSelect($('#fr-overlap'), [[0, '0%'], [0.5, '50%'], [0.75, '75%'], [0.875, '87.5%']], frSettings.overlap);
  fillSelect($('#fr-scale'), Object.entries(SCALES), frSettings.scale);

  // compute-affecting → recompute the spectrum
  $('#fr-window').onchange = (e) => { frSettings.windowType = e.target.value; refreshAllFr(true); };
  $('#fr-size').onchange = (e) => { frSettings.fftSize = parseInt(e.target.value); refreshAllFr(true); };
  $('#fr-overlap').onchange = (e) => { frSettings.overlap = parseFloat(e.target.value); refreshAllFr(true); };
  // render-only → just re-render
  $('#fr-scale').onchange = (e) => { frSettings.scale = e.target.value; refreshAllFr(false); };

  const bindNum = (id, key, fallback) => {
    const inp = $(id);
    inp.onchange = () => {
      const v = inp.value.trim();
      frSettings[key] = v === '' ? fallback : Number(v);
      refreshAllFr(false);
    };
  };
  bindNum('#fr-fmin', 'fMin', 0);
  bindNum('#fr-fmax', 'fMax', 0);
  bindNum('#fr-dbmin', 'dbMin', -120);
  bindNum('#fr-dbmax', 'dbMax', 0);

  $('#fr-clear').onclick = () => { for (const f of state.files) clearFileSelection(f); };

  const snap = $('#snap-enabled');
  snap.checked = state.snapEnabled;
  snap.onchange = () => { state.snapEnabled = snap.checked; };
}

// =======================================================================
// Wire up global controls
// =======================================================================
window.addEventListener('DOMContentLoaded', () => {
  $('#open-btn').onclick = openFiles;
  $('#export-btn').onclick = doExport;
  $('#preview-btn').onclick = togglePreview;
  $('#preview-bar').addEventListener('click', (ev) => {
    const d = previewPlayer.duration;
    if (!d) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const pos = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    previewPlayer.seek(pos * d);
    updatePreviewProgress();
  });

  // playback gain (applies to per-file play and the mixed preview)
  const gainSlider = $('#gain-slider');
  const applyGain = () => {
    const g = parseFloat(gainSlider.value);
    player.setGain(g);
    previewPlayer.setGain(g);
    $('#gain-val').textContent = Math.round(g * 100) + '%';
  };
  gainSlider.addEventListener('input', applyGain);
  applyGain();

  // length mode: pad to longest vs trim to shortest (mix + export)
  const lenLongest = $('#len-longest');
  const lenShortest = $('#len-shortest');
  const setLengthMode = (mode) => {
    state.lengthMode = mode;
    lenLongest.classList.toggle('active', mode === 'longest');
    lenShortest.classList.toggle('active', mode === 'shortest');
    updateExportPanel(); // refresh warning + invalidate preview so it rebuilds
  };
  lenLongest.onclick = () => setLengthMode('longest');
  lenShortest.onclick = () => setLengthMode('shortest');

  setupDragAndDrop();

  // export filename: auto (timestamped) vs manual
  const nameInput = $('#export-name');
  const autoChk = $('#export-auto');
  const applyAuto = () => {
    nameInput.readOnly = autoChk.checked;
    nameInput.classList.toggle('readonly', autoChk.checked);
    if (autoChk.checked) nameInput.value = autoExportName(state.exportOrder.length);
  };
  autoChk.addEventListener('change', applyAuto);
  applyAuto(); // initialize (auto on by default)

  // default-format controls
  const df = $('#def-format');
  for (const key of Object.keys(FORMATS)) {
    const o = el('option', { value: key, textContent: FORMATS[key].label });
    if (key === defaults.format) o.selected = true;
    df.appendChild(o);
  }
  df.onchange = () => (defaults.format = df.value);
  $('#def-channels').onchange = (e) => (defaults.channels = Math.max(1, parseInt(e.target.value) || 1));
  $('#def-sr').onchange = (e) => (defaults.sampleRate = Math.max(1, parseInt(e.target.value) || 48000));
  $('#def-header').onchange = (e) => (defaults.headerBytes = Math.max(0, parseInt(e.target.value) || 0));

  setupPresets();
  setupSpecControls();
  setupFrControls();
  updateExportPanel();
  setStatus('Open one or more PCM dumps to begin — click “Open PCM files…” or drag files onto the window.');
});

// Canvas resizing is handled precisely by `sizeObserver` (ResizeObserver),
// which reacts to window resizes and any layout change — no window 'resize'
// listener needed.
