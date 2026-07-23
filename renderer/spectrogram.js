'use strict';

import { FFT } from './fft.js';
import { makeWindow } from './windows.js';
import { scaleForward, scaleInverse, effectiveFMin, freqTicks, formatHz } from './scales.js';

// Layout of the spectrogram canvas (device pixels).
export const LEFT_GUTTER = 46;
export const BOTTOM_GUTTER = 18;

/**
 * STFT magnitude matrix (dB), independent of display/scale/range settings.
 * Recompute only when the window, size, overlap, or signal changes.
 *
 * @returns {{ mags: Float32Array, cols: number, bins: number, fftSize: number, hop: number }}
 *          mags is laid out [col * bins + bin] in dBFS (0 dB = full-scale tone).
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
  const norm = 2 / (sum || 1); // coherent-gain normalization → dBFS

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
 * Render a magnitude matrix onto a canvas with a chosen frequency scale,
 * frequency range, and dB range — including frequency (left) and time (bottom) axes.
 */
export function renderSpectrogram(canvas, matrix, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const plotX = LEFT_GUTTER, plotY = 0;
  const plotW = Math.max(1, W - LEFT_GUTTER);
  const plotH = Math.max(1, H - BOTTOM_GUTTER);

  const sampleRate = opts.sampleRate || 48000;
  const scale = opts.scale || 'linear';
  const dbMin = opts.dbMin ?? -100;
  const dbMax = opts.dbMax ?? -10;
  const durationSec = opts.durationSec || 0;
  const nyquist = sampleRate / 2;

  let fMin = effectiveFMin(scale, opts.fMin ?? 0, nyquist);
  let fMax = opts.fMax > 0 ? Math.min(opts.fMax, nyquist) : nyquist;
  if (fMax <= fMin) { fMin = effectiveFMin(scale, 0, nyquist); fMax = nyquist; }

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const bins = matrix.bins;
  const sMax = scaleForward(scale, fMax);
  const sMin = scaleForward(scale, fMin);
  const dbSpan = (dbMax - dbMin) || 1;

  // Build an offscreen image of cols × plotH by mapping each output row to a
  // frequency (per scale) and interpolating the matrix bins.
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
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, matrix.cols, plotH, plotX, plotY, plotW, plotH);

  drawFreqAxis(ctx, { scale, fMin, fMax, sMin, sMax, plotX, plotH, denomRow });
  drawTimeAxis(ctx, { durationSec, plotX, plotW, plotH, W });
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
    ctx.lineTo(ctx.canvas.width, row + 0.5);
    ctx.stroke();
    // label with a small dark backing for legibility
    const label = formatHz(f);
    const y = Math.min(o.plotH - 6, Math.max(6, row));
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, y - 7, o.plotX - 2, 14);
    ctx.fillStyle = 'rgba(230,235,245,0.95)';
    ctx.textAlign = 'right';
    ctx.fillText(label, o.plotX - 5, y);
  }
  // axis unit
  ctx.fillStyle = 'rgba(160,170,185,0.9)';
  ctx.textAlign = 'left';
  ctx.fillText('Hz', 3, 8);
}

function drawTimeAxis(ctx, o) {
  if (!o.durationSec) return;
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(200,206,216,0.9)';
  ctx.textBaseline = 'top';
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const frac = i / n;
    const x = o.plotX + frac * o.plotW;
    const tsec = frac * o.durationSec;
    ctx.textAlign = i === 0 ? 'left' : i === n ? 'right' : 'center';
    const xx = i === 0 ? o.plotX + 2 : i === n ? o.W - 2 : x;
    ctx.fillText(tsec.toFixed(2) + 's', xx, o.plotH + 3);
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
