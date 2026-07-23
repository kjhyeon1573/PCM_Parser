'use strict';

import { FORMATS, parsePcm, channelStats } from './pcm.js';
import { drawWaveform, drawCursor } from './waveform.js';
import { computeSpectrogramMatrix, renderSpectrogram } from './spectrogram.js';
import { WINDOWS } from './windows.js';
import { SCALES } from './scales.js';
import { Player } from './player.js';
import { encodeWav } from './wav.js';

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
    channelDom: [] // per channel: { base, overlay, checkbox, specWrap, specCanvas }
  };
}

function parseFile(file) {
  file.parsed = parsePcm(file.buffer, file.settings);
  file.stats = file.parsed.channels.map(channelStats);
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
      if (cd.base.width === w) continue;         // width unchanged → skip
      sizeCanvas(cd.base, 90);
      sizeCanvas(cd.overlay, 90);
      drawWaveform(cd.base, cd.data, { color: '#4ea1ff' });
      cursorsDirty = true;
    } else if (target._kind === 'spec') {
      if (!cd.open || cd.specCanvas.width === w) continue;
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
    // remember which channels currently show a spectrogram so we can restore them
    const openChannels = new Set(
      file.channelDom.filter((cd) => cd.open).map((cd) => cd.ch)
    );
    settings.format = formatSel.value;
    settings.channels = Math.max(1, parseInt(chInput.value) || 1);
    settings.sampleRate = Math.max(1, parseInt(srInput.value) || 48000);
    settings.headerBytes = Math.max(0, parseInt(hdrInput.value) || 0);
    parseFile(file);
    // signal changed → waveforms redraw and spectrograms recompute + re-render
    // with the new sample-rate-aware Hz axis
    rebuildChannels(file, info, openChannels);
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

function rebuildChannels(file, infoSpan, reopenChannels = null) {
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
    const checked = state.exportOrder.some((e) => e.fileId === file.id && e.ch === ch);
    const checkbox = el('input', { type: 'checkbox', checked });
    checkbox.onchange = () => toggleExport(file, ch, checkbox.checked);

    const st = file.stats[ch];
    const label = el('div', { class: 'ch-label' }, [
      checkbox,
      el('span', { textContent: ` Ch ${ch}` }),
      el('span', { class: 'muted small', textContent: ` peak ${st.peak.toFixed(3)} rms ${st.rms.toFixed(3)}` })
    ]);

    const wfWrap = el('div', { class: 'wf-wrap' });
    const base = el('canvas', { class: 'wf-base' });
    const overlay = el('canvas', { class: 'wf-overlay' });
    wfWrap.appendChild(base);
    wfWrap.appendChild(overlay);

    const specBtn = el('button', { class: 'btn tiny ghost', textContent: 'Spectrogram' });
    const specWrap = el('div', { class: 'spec-wrap hidden' });
    const specCanvas = el('canvas', { class: 'spec' });
    specWrap.appendChild(specCanvas);

    // per-channel spectrogram controller
    const cd = {
      base, overlay, checkbox, specWrap, specCanvas, specBtn, wfWrap,
      data, file, ch,
      open: false,
      matrix: null,
      matrixKey: ''
    };
    // observe containers so canvases track any size change
    wfWrap._cd = cd; wfWrap._kind = 'wf';
    specWrap._cd = cd; specWrap._kind = 'spec';
    sizeObserver.observe(wfWrap);
    sizeObserver.observe(specWrap);

    specBtn.onclick = () => {
      if (cd.open) closeChannelSpec(cd);
      else openChannelSpec(cd);
    };

    const row = el('div', { class: 'ch-row' }, [
      label,
      wfWrap,
      el('div', { class: 'ch-actions' }, [specBtn]),
      specWrap
    ]);
    chWrap.appendChild(row);

    // seek on waveform click
    wfWrap.addEventListener('click', (ev) => {
      const rect = wfWrap.getBoundingClientRect();
      const pos = (ev.clientX - rect.left) / rect.width;
      seekTo(file, pos);
    });

    file.channelDom.push(cd);

    // draw after in DOM (needs clientWidth)
    requestAnimationFrame(() => {
      sizeCanvas(base, 90);
      sizeCanvas(overlay, 90);
      drawWaveform(base, data, { color: '#4ea1ff' });
      if (reopenChannels && reopenChannels.has(ch)) openChannelSpec(cd);
    });
  });
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
  if (!cd.open) return;
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

function openChannelSpec(cd) {
  cd.open = true;
  cd.specWrap.classList.remove('hidden');
  cd.specBtn.classList.add('active');
  cd.specBtn.textContent = 'Computing…';
  sizeCanvas(cd.specCanvas, SPEC_HEIGHT);
  // compute asynchronously so the UI can paint the "computing" state
  setTimeout(() => {
    ensureMatrix(cd);
    renderChannelSpec(cd);
    cd.specBtn.textContent = 'Spectrogram';
  }, 10);
}

function closeChannelSpec(cd) {
  cd.open = false;
  cd.specWrap.classList.add('hidden');
  cd.specBtn.classList.remove('active');
}

/** Re-render (and optionally recompute) every open spectrogram. */
function refreshAllSpectrograms(recompute) {
  for (const f of state.files) {
    for (const cd of f.channelDom) {
      if (!cd.open) continue;
      if (recompute) cd.matrixKey = ''; // force ensureMatrix to recompute
      cd.specBtn.textContent = 'Computing…';
    }
  }
  // do the heavy work after the paint
  setTimeout(() => {
    for (const f of state.files) {
      for (const cd of f.channelDom) {
        if (!cd.open) continue;
        sizeCanvas(cd.specCanvas, SPEC_HEIGHT);
        ensureMatrix(cd);
        renderChannelSpec(cd);
        cd.specBtn.textContent = 'Spectrogram';
      }
    }
  }, 10);
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

function seekTo(file, pos) {
  pausePreview();
  if (activeFileId !== file.id) {
    player.load(file.id, file.parsed.channels, file.settings.sampleRate);
    activeFileId = file.id;
  }
  player.seek(pos * player.duration);
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
  const pos = player.duration ? player.currentTime / player.duration : 0;
  clearCursors();
  for (const cd of f.channelDom) {
    drawCursor(cd.overlay, pos);
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
