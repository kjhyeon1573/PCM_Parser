'use strict';

import { FFT } from './fft.js';
import { makeWindow } from './windows.js';
import { scaleForward, scaleInverse, effectiveFMin, freqTicks, formatHz } from './scales.js';

// Layout of the spectrogram canvas (device pixels). Kept equal to the
// waveform's gutters so the two plots line up in "Both" mode.
export const LEFT_GUTTER = 46;
export const BOTTOM_GUTTER = 18;

/**
 * STFT magnitude matrix (dB), independent of display/scale/range settings.
 * Recompute only when the window, size, overlap, or signal changes.
 *
 * @returns {{ mags: Float32Array, cols: number, bins: number, fftSize: number, hop: number }}
 */
export function computeSpectrogramMatrix(data, opts = {}) {
  const fftSize = opts.fftSize || 1024;
  const overlap = Math.min(0.95, Math.max(0, opts.overlap ?? 0.75));
  const maxCols = opts.maxCols || 2000;
  const { win, sum } = makeWindow(opts.windowType || 'hann', fftSize);
  const bins = fftSize / 2;

  let hop = Math.max(1, Math.round(fftSize * (1 - overlap)));
  const span = Math.max(0, data.length - fftSize);
  const naturalCols = Math.floor(span / hop) + 1;
  if (naturalCols > maxCols) hop = Math.max(hop, Math.ceil(span / maxCols));
  const cols = Math.max(1, Math.floor(span / hop) + 1);

  const fft = new FFT(fftSize);
  const frame = new Float32Array(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const mags = new Float32Array(cols * bins);
  const norm = 2 / (sum || 1);

  for (let c = 0; c < cols; c++) {
    const off = c * hop;
    for (let i = 0; i < fftSize; i++) {
      const idx = off + i;
      frame[i] = idx < data.length ? data[idx] * win[i] : 0;
    }
    fft.forward(frame, re, im);
    const base = c * bins;
    for (let b = 0; b < bins; b++) {
      const m = Math.sqrt(re[b] * re[b] + im[b] * im[b]) * norm;
      mags[base + b] = 20 * Math.log10(m + 1e-9);
    }
  }
  return { mags, cols, bins, fftSize, hop };
}

/**
 * Build the frequency-mapped spectrogram image. This depends on the matrix,
 * frequency scale/range and dB range — but NOT on the time window, so panning
 * and zooming in time only needs a cheap re-crop (see paintSpectrogram).
 *
 * @returns {{ off, plotH, cols, hop, scale, fMin, fMax, sMin, sMax }}
 */
export function buildSpectrogramImage(matrix, opts = {}) {
  const sampleRate = opts.sampleRate || 48000;
  const scale = opts.scale || 'linear';
  const dbMin = opts.dbMin ?? -100;
  const dbMax = opts.dbMax ?? -10;
  const canvasHeight = opts.canvasHeight || 200;
  const plotH = Math.max(1, canvasHeight - BOTTOM_GUTTER);
  const nyquist = sampleRate / 2;

  let fMin = effectiveFMin(scale, opts.fMin ?? 0, nyquist);
  let fMax = opts.fMax > 0 ? Math.min(opts.fMax, nyquist) : nyquist;
  if (fMax <= fMin) { fMin = effectiveFMin(scale, 0, nyquist); fMax = nyquist; }

  const bins = matrix.bins;
  const sMax = scaleForward(scale, fMax);
  const sMin = scaleForward(scale, fMin);
  const dbSpan = (dbMax - dbMin) || 1;

  const img = new ImageData(matrix.cols, plotH);
  const px = img.data;
  const denomRow = plotH - 1 || 1;
  for (let row = 0; row < plotH; row++) {
    const s = sMax - (sMax - sMin) * (row / denomRow); // top row = fMax
    const f = scaleInverse(scale, s);
    let binF = (f / nyquist) * (bins - 1);
    if (binF < 0) binF = 0; else if (binF > bins - 1) binF = bins - 1;
    const b0 = binF | 0;
    const b1 = b0 + 1 < bins ? b0 + 1 : b0;
    const fr = binF - b0;
    for (let c = 0; c < matrix.cols; c++) {
      const base = c * bins;
      const dbv = matrix.mags[base + b0] * (1 - fr) + matrix.mags[base + b1] * fr;
      let t = (dbv - dbMin) / dbSpan;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const rgb = magma(t);
      const p = (row * matrix.cols + c) * 4;
      px[p] = rgb[0]; px[p + 1] = rgb[1]; px[p + 2] = rgb[2]; px[p + 3] = 255;
    }
  }
  const off = document.createElement('canvas');
  off.width = matrix.cols; off.height = plotH;
  off.getContext('2d').putImageData(img, 0, 0);

  return { off, plotH, cols: matrix.cols, hop: matrix.hop, scale, fMin, fMax, sMin, sMax };
}

/**
 * Paint a prebuilt spectrogram image onto a canvas, cropped to a time window
 * [viewStart, viewEnd) (samples), with frequency (left) and time (bottom) axes.
 */
export function paintSpectrogram(canvas, image, opts = {}) {
  const ctx = canvas.getContext('2d');
  // HiDPI: buffer is dpr× the CSS size; draw in CSS-pixel logical coordinates.
  const dpr = canvas._dpr || 1;
  const W = canvas._cssW || canvas.width;
  const H = canvas._cssH || canvas.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const plotX = LEFT_GUTTER;
  const plotW = Math.max(1, W - LEFT_GUTTER);
  const plotH = Math.max(1, H - BOTTOM_GUTTER);
  const sampleRate = opts.sampleRate || 48000;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const hop = image.hop || 1;
  const totalSamples = image.cols * hop;
  const vStart = Math.max(0, opts.viewStart ?? 0);
  const vEnd = Math.min(totalSamples, opts.viewEnd ?? totalSamples);
  let colStart = vStart / hop;
  let colEnd = vEnd / hop;
  if (colEnd <= colStart) colEnd = colStart + 1e-3;
  colStart = Math.max(0, Math.min(image.cols, colStart));
  colEnd = Math.max(colStart + 1e-3, Math.min(image.cols, colEnd));

  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(image.off, colStart, 0, colEnd - colStart, image.off.height, plotX, 0, plotW, plotH);

  drawFreqAxis(ctx, { scale: image.scale, fMin: image.fMin, fMax: image.fMax, sMin: image.sMin, sMax: image.sMax, plotX, plotW, W, plotH, denomRow: plotH - 1 || 1 });
  drawTimeAxis(ctx, { startSec: vStart / sampleRate, durSec: (vEnd - vStart) / sampleRate, plotX, plotW, plotH, W });
}

/** Convenience: build + paint in one call (full time view). Used by tests. */
export function renderSpectrogram(canvas, matrix, opts = {}) {
  const image = buildSpectrogramImage(matrix, { ...opts, canvasHeight: canvas.height });
  const totalSamples = matrix.cols * matrix.hop;
  paintSpectrogram(canvas, image, {
    sampleRate: opts.sampleRate,
    viewStart: opts.viewStart ?? 0,
    viewEnd: opts.viewEnd ?? totalSamples
  });
}

function drawFreqAxis(ctx, o) {
  const ticks = freqTicks(o.scale, o.fMin, o.fMax);
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const f of ticks) {
    const s = scaleForward(o.scale, f);
    const row = ((o.sMax - s) / ((o.sMax - o.sMin) || 1)) * o.denomRow;
    if (row < 0 || row > o.plotH) continue;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(o.plotX, row + 0.5);
    ctx.lineTo(o.W, row + 0.5);
    ctx.stroke();
    const label = formatHz(f);
    const y = Math.min(o.plotH - 6, Math.max(6, row));
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, y - 7, o.plotX - 2, 14);
    ctx.fillStyle = 'rgba(230,235,245,0.95)';
    ctx.textAlign = 'right';
    ctx.fillText(label, o.plotX - 5, y);
  }
  ctx.fillStyle = 'rgba(160,170,185,0.9)';
  ctx.textAlign = 'left';
  ctx.fillText('Hz', 3, 8);
}

function drawTimeAxis(ctx, o) {
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(200,206,216,0.9)';
  ctx.textBaseline = 'top';
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const frac = i / n;
    const x = o.plotX + frac * o.plotW;
    const tsec = o.startSec + frac * o.durSec;
    ctx.textAlign = i === 0 ? 'left' : i === n ? 'right' : 'center';
    const xx = i === 0 ? o.plotX + 2 : i === n ? o.W - 2 : x;
    ctx.fillText(tsec.toFixed(o.durSec < 1 ? 3 : 2) + 's', xx, o.plotH + 3);
  }
}

// Approximate "magma" colormap (perceptually uniform, dark→bright).
function magma(t) {
  const stops = [
    [0.0, 0, 0, 4], [0.13, 28, 16, 68], [0.25, 79, 18, 123], [0.38, 129, 37, 129],
    [0.5, 181, 54, 122], [0.63, 229, 80, 100], [0.75, 251, 135, 97],
    [0.88, 254, 194, 135], [1.0, 252, 253, 191]
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const f = (t - a[0]) / (b[0] - a[0]);
      return [
        (a[1] + (b[1] - a[1]) * f) | 0,
        (a[2] + (b[2] - a[2]) * f) | 0,
        (a[3] + (b[3] - a[3]) * f) | 0
      ];
    }
  }
  return [252, 253, 191];
}
