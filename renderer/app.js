'use strict';

import { FORMATS, parsePcm, channelStats } from './pcm.js';
import { drawWaveform, drawCursor, WF_LEFT, WF_BOTTOM } from './waveform.js';
import { computeSpectrogramMatrix, renderSpectrogram } from './spectrogram.js';
import { hilbertEnvelope } from './hilbert.js';
import { WINDOWS } from './windows.js';
import { SCALES } from './scales.js';
import { Player } from './player.js';
import { encodeWav } from './wav.js';

const WF_HEIGHT = 120; // waveform canvas height (incl. axes gutters)

const SPEC_HEIGHT = 260;

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

const state = {
  files: [],          // see makeFile()
  exportOrder: [],    // [{ fileId, ch }]
  nextId: 1,
  lastSaveDir: '',    // remembered folder for the save dialog
  nameEdited: false   // true once the user hand-edits the export filename
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
    channelDom: []
  };
}

function parseFile(file) {
  file.parsed = parsePcm(file.buffer, file.settings);
  file.stats = file.parsed.channels.map(channelStats);
  file.view = { start: 0, end: file.parsed.frameCount }; // reset zoom to full
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
  const w = Math.max(200, canvas.parentElement.clientWidth);
  canvas.width = w;
  canvas.height = height;
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
      if (!wfVisible(cd) || cd.base.width === w) continue; // unchanged/hidden → skip
      sizeCanvas(cd.base, WF_HEIGHT);
      sizeCanvas(cd.overlay, WF_HEIGHT);
      drawChannelWaveform(cd);
      cursorsDirty = true;
    } else if (target._kind === 'spec') {
      if (!specVisible(cd) || cd.specCanvas.width === w) continue;
      sizeCanvas(cd.specCanvas, SPEC_HEIGHT);
      ensureMatrix(cd);
      renderChannelSpec(cd);
    }
  }
  if (cursorsDirty) drawAllCursors();
}

function unobserveChannels(file) {
  for (const cd of file.channelDom) {
    if (cd.wfWrap) sizeObserver.unobserve(cd.wfWrap);
    if (cd.specWrap) sizeObserver.unobserve(cd.specWrap);
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
  const timeLabel = el('span', { class: 'time' });
  const info = el('span', { class: 'muted info' });

  applyBtn.onclick = () => {
    // remember each channel's view mode + envelope state so we can restore them
    const restore = { mode: new Map(), env: new Set() };
    for (const cd of file.channelDom) {
      restore.mode.set(cd.ch, cd.mode);
      if (cd.envOn) restore.env.add(cd.ch);
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
  card._chWrap = chWrap;
  card._playBtn = playBtn;
  card._timeLabel = timeLabel;

  filesEl().appendChild(card);
  rebuildChannels(file, info);
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

    requestAnimationFrame(() => {
      sizeCanvas(cd.base, WF_HEIGHT);
      sizeCanvas(cd.overlay, WF_HEIGHT);
      if (restoreEnv) enableEnvelope(cd, true);
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

  const head = el('label', { class: 'ch-head' }, [checkbox, el('span', { textContent: ` Ch ${ch}` })]);
  const peakLine = el('div', { class: 'ch-stat muted small', textContent: `peak ${st.peak.toFixed(3)}` });
  const rmsLine = el('div', { class: 'ch-stat muted small', textContent: `rms ${st.rms.toFixed(3)}` });

  const btnWf = el('button', { class: 'btn tiny ghost active', textContent: 'Waveform' });
  const btnSpec = el('button', { class: 'btn tiny ghost', textContent: 'Spectrogram' });
  const btnBoth = el('button', { class: 'btn tiny ghost', textContent: 'Both' });
  const modes = el('div', { class: 'ch-modes' }, [btnWf, btnSpec, btnBoth]);

  const side = el('div', { class: 'ch-side' }, [head, peakLine, rmsLine, modes]);

  // ---- right side: waveform panel + spectrogram panel ----
  const envBtn = el('button', { class: 'btn tiny ghost', textContent: 'RMS env' });
  const zoomOut = el('button', { class: 'btn tiny ghost', textContent: '−' });
  const zoomIn = el('button', { class: 'btn tiny ghost', textContent: '+' });
  const zoomReset = el('button', { class: 'btn tiny ghost', textContent: 'Reset' });
  const viewLabel = el('span', { class: 'muted small wf-view' });
  const wfToolbar = el('div', { class: 'wf-toolbar' }, [
    envBtn, zoomOut, zoomIn, zoomReset, viewLabel,
    el('span', { class: 'muted small wf-hint', textContent: 'wheel: zoom · drag: pan' })
  ]);

  const wfWrap = el('div', { class: 'wf-wrap' });
  const base = el('canvas', { class: 'wf-base' });
  const overlay = el('canvas', { class: 'wf-overlay' });
  wfWrap.appendChild(base);
  wfWrap.appendChild(overlay);
  const wfPanel = el('div', { class: 'wf-panel' }, [wfToolbar, wfWrap]);

  const specStatus = el('div', { class: 'spec-status muted small hidden', textContent: 'Computing…' });
  const specCanvas = el('canvas', { class: 'spec' });
  const specWrap = el('div', { class: 'spec-wrap hidden' }, [specStatus, specCanvas]);

  const main = el('div', { class: 'ch-main' }, [wfPanel, specWrap]);

  const row = el('div', { class: 'ch-row' }, [side, main]);
  chWrap.appendChild(row);

  const cd = {
    file, data, ch,
    checkbox, base, overlay, wfWrap, wfPanel, viewLabel,
    specWrap, specCanvas, specStatus,
    btnWf, btnSpec, btnBoth, envBtn,
    mode: 'waveform',
    envOn: false, envelope: null, envKey: '',
    matrix: null, matrixKey: '', specRendered: false
  };

  // view-mode buttons
  btnWf.onclick = () => setChannelMode(cd, 'waveform');
  btnSpec.onclick = () => setChannelMode(cd, 'spectrogram');
  btnBoth.onclick = () => setChannelMode(cd, 'both');
  envBtn.onclick = () => toggleEnvelope(cd);
  zoomOut.onclick = () => zoomFile(file, 1 / 0.6);
  zoomIn.onclick = () => zoomFile(file, 0.6);
  zoomReset.onclick = () => resetZoom(file);

  // observe for resizing
  wfWrap._cd = cd; wfWrap._kind = 'wf';
  specWrap._cd = cd; specWrap._kind = 'spec';
  sizeObserver.observe(wfWrap);
  sizeObserver.observe(specWrap);

  setupWaveformInteraction(cd);
  return cd;
}

// =======================================================================
// Channel view mode (waveform / spectrogram / both)
// =======================================================================
function specVisible(cd) { return cd.mode === 'spectrogram' || cd.mode === 'both'; }
function wfVisible(cd) { return cd.mode === 'waveform' || cd.mode === 'both'; }

function setChannelMode(cd, mode) {
  cd.mode = mode;
  cd.btnWf.classList.toggle('active', mode === 'waveform');
  cd.btnSpec.classList.toggle('active', mode === 'spectrogram');
  cd.btnBoth.classList.toggle('active', mode === 'both');

  cd.wfPanel.classList.toggle('hidden', !wfVisible(cd));
  cd.specWrap.classList.toggle('hidden', !specVisible(cd));

  if (wfVisible(cd)) {
    requestAnimationFrame(() => {
      sizeCanvas(cd.base, WF_HEIGHT);
      sizeCanvas(cd.overlay, WF_HEIGHT);
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
    color: '#4ea1ff',
    envelope: cd.envOn ? cd.envelope : null
  });
  updateViewLabel(cd);
}

function updateViewLabel(cd) {
  const v = cd.file.view;
  const sr = cd.file.settings.sampleRate;
  cd.viewLabel.textContent = `${(v.start / sr).toFixed(3)}–${(v.end / sr).toFixed(3)}s`;
}

function redrawFileWaveforms(file) {
  for (const cd of file.channelDom) {
    if (wfVisible(cd)) drawChannelWaveform(cd);
  }
  drawAllCursors();
}

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
  redrawFileWaveforms(file);
}

function resetZoom(file) {
  file.view = { start: 0, end: file.parsed.frameCount };
  redrawFileWaveforms(file);
}

function setupWaveformInteraction(cd) {
  const file = cd.file;
  const wfWrap = cd.wfWrap;

  // wheel = zoom centered on the pointer (within the plot area, past the axis gutter)
  wfWrap.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = wfWrap.getBoundingClientRect();
    const plotW = Math.max(1, rect.width - WF_LEFT);
    const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left - WF_LEFT) / plotW));
    zoomFile(file, ev.deltaY < 0 ? 0.8 : 1.25, frac);
  }, { passive: false });

  // drag = pan; a click without movement = seek
  let drag = null;
  wfWrap.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const rect = wfWrap.getBoundingClientRect();
    wfWrap.setPointerCapture(ev.pointerId);
    drag = { x0: ev.clientX, width: Math.max(1, rect.width - WF_LEFT), v0: { ...file.view }, moved: false };
  });
  wfWrap.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x0;
    if (Math.abs(dx) > 3) drag.moved = true;
    const len = drag.v0.end - drag.v0.start;
    const ds = -(dx / drag.width) * len;
    clampView(file, drag.v0.start + ds, drag.v0.end + ds);
    redrawFileWaveforms(file);
  });
  const endDrag = (ev) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    const rect = wfWrap.getBoundingClientRect();
    drag = null;
    if (!wasDrag) {
      const plotW = Math.max(1, rect.width - WF_LEFT);
      const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left - WF_LEFT) / plotW));
      const v = file.view;
      const sample = v.start + frac * (v.end - v.start);
      seekFileSeconds(file, sample / file.settings.sampleRate);
    }
  };
  wfWrap.addEventListener('pointerup', endDrag);
  wfWrap.addEventListener('pointercancel', () => { drag = null; });
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

function renderChannelSpec(cd) {
  const dur = cd.file.parsed.frameCount / cd.file.settings.sampleRate;
  renderSpectrogram(cd.specCanvas, cd.matrix, {
    sampleRate: cd.file.settings.sampleRate,
    scale: specSettings.scale,
    fMin: specSettings.fMin,
    fMax: specSettings.fMax,
    dbMin: specSettings.dbMin,
    dbMax: specSettings.dbMax,
    durationSec: dur
  });
}

/** Ensure the spectrogram is computed and rendered (async), then shown. */
function showChannelSpec(cd, recompute) {
  cd.specStatus.classList.remove('hidden');
  cd.specCanvas.classList.add('dim');
  if (recompute) cd.matrixKey = '';
  setTimeout(() => {
    sizeCanvas(cd.specCanvas, SPEC_HEIGHT);
    ensureMatrix(cd);
    renderChannelSpec(cd);
    cd.specRendered = true;
    cd.specStatus.classList.add('hidden');
    cd.specCanvas.classList.remove('dim');
  }, 10);
}

/** Re-render (and optionally recompute) every visible spectrogram. */
function refreshAllSpectrograms(recompute) {
  for (const f of state.files) {
    for (const cd of f.channelDom) {
      if (specVisible(cd)) showChannelSpec(cd, recompute);
    }
  }
}

// =======================================================================
// Playback
// =======================================================================
function togglePlay(file, btn, timeLabel) {
  if (activeFileId !== file.id) {
    player.load(file.id, file.parsed.channels, file.settings.sampleRate);
    activeFileId = file.id;
  }
  if (player.playing) {
    player.pause();
  } else {
    pausePreview();
    player.play();
    startCursorLoop();
  }
  updatePlayButton(file, btn, timeLabel);
}

function seekFileSeconds(file, seconds) {
  pausePreview();
  if (activeFileId !== file.id) {
    player.load(file.id, file.parsed.channels, file.settings.sampleRate);
    activeFileId = file.id;
  }
  player.seek(seconds);
  if (!player.playing) drawAllCursors();
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

function drawAllCursors() {
  const f = state.files.find((x) => x.id === activeFileId);
  if (!f || !f.parsed) return;
  clearCursors();
  const sr = f.settings.sampleRate;
  const curSample = player.currentTime * sr;
  const v = f.view;
  const len = v.end - v.start;
  if (len <= 0) return;
  const pos = (curSample - v.start) / len; // map to the current zoom window
  if (pos < 0 || pos > 1) return;           // playhead outside the visible range
  for (const cd of f.channelDom) {
    if (wfVisible(cd)) drawCursor(cd.overlay, pos);
  }
}

function clearCursors() {
  for (const f of state.files) {
    for (const cd of f.channelDom) {
      const ctx = cd.overlay.getContext('2d');
      ctx.clearRect(0, 0, cd.overlay.width, cd.overlay.height);
    }
  }
}

// =======================================================================
// Mixed N-channel preview
// =======================================================================
let previewRAF = null;
let previewKey = '';

previewPlayer.onEnded = () => { updatePreviewButton(); updatePreviewProgress(); };

/** Signature of the current selection + rate, to detect when a reload is needed. */
function selectionKey() {
  return state.exportOrder.map((e) => e.fileId + ':' + e.ch).join(',') + '@' + $('#export-sr').value;
}

/** Down-mix all selected channels to a single mono monitor track (averaged). */
function buildPreviewMix() {
  const chans = state.exportOrder
    .map((e) => { const f = state.files.find((x) => x.id === e.fileId); return f ? f.parsed.channels[e.ch] : null; })
    .filter(Boolean);
  if (!chans.length) return null;
  const sampleRate = Math.max(1, parseInt($('#export-sr').value) || 48000);
  const len = chans.reduce((m, c) => Math.max(m, c.length), 0);
  const mix = new Float32Array(len);
  const inv = 1 / chans.length;
  for (const c of chans) {
    for (let i = 0; i < c.length; i++) mix[i] += c[i] * inv;
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
      } })
    ]);
    list.appendChild(row);
  });

  const count = state.exportOrder.length;
  $('#export-count').textContent = `${count} channel${count === 1 ? '' : 's'} selected`;
  $('#export-btn').disabled = count === 0;
  updatePreviewControls();

  // keep the suggested filename in sync with the channel count
  // until the user hand-edits it
  if (!state.nameEdited) {
    $('#export-name').value = defaultExportName(count);
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
    const msg =
      `선택한 채널들의 길이가 다릅니다.\n\n` +
      `가장 짧은 채널: ${minLen.toLocaleString()} 프레임 (${timeStr(minLen / sr)})\n` +
      `가장 긴 채널: ${maxLen.toLocaleString()} 프레임 (${timeStr(maxLen / sr)})\n\n` +
      `계속하면 짧은 채널은 끝부분이 무음으로 채워져 ${maxLen.toLocaleString()} 프레임 길이로 저장됩니다.\n` +
      `그대로 저장할까요?`;
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
    const wav = encodeWav(channels, sampleRate, { bitDepth, float });
    const res = await window.api.saveWav(wav, outName, state.lastSaveDir);
    if (res.saved) {
      state.lastSaveDir = res.dir || state.lastSaveDir;
      state.nameEdited = true;
      $('#export-name').value = res.name;
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

function defaultExportName(count) {
  return `export_${count}ch.wav`;
}

/** Current filename from the input, sanitized and guaranteed to end in .wav */
function currentExportName(count) {
  let name = ($('#export-name').value || '').trim();
  if (!name) name = defaultExportName(count);
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
  setupDragAndDrop();

  // track manual edits to the export filename
  const nameInput = $('#export-name');
  nameInput.addEventListener('input', () => {
    // if the user clears it, fall back to auto-naming again
    state.nameEdited = nameInput.value.trim() !== '';
  });

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

  setupSpecControls();
  updateExportPanel();
  setStatus('Open one or more PCM dumps to begin — click “Open PCM files…” or drag files onto the window.');
});

// Canvas resizing is handled precisely by `sizeObserver` (ResizeObserver),
// which reacts to window resizes and any layout change — no window 'resize'
// listener needed.
