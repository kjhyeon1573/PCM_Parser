'use strict';

import { FFT } from './fft.js';
import { makeWindow } from './windows.js';
import { scaleForward, scaleInverse, effectiveFMin, freqTicks, formatHz } from './scales.js';

// Axis gutters — kept equal to the waveform/spectrogram so the plot lines up.
export const FR_LEFT = 46;
export const FR_BOTTOM = 18;

/**
 * Magnitude spectrum (dB) of a signal region [start, end). If the region is
 * longer than the FFT, overlapping windowed frames are power-averaged (Welch),
 * otherwise a single zero-padded windowed FFT is used. 0 dB = full-scale tone.
 *
 * @returns {{ db: Float32Array, bins: number, fftSize: number, frames: number }}
 */
export function frequencyResponse(data, start, end, opts = {}) {
  const fftSize = opts.fftSize || 2048;
  const bins = fftSize / 2;
  const s0 = Math.max(0, Math.min(data.length, start | 0));
  const s1 = Math.max(s0, Math.min(data.length, end | 0));
  const len = s1 - s0;

  const { win, sum } = makeWindow(opts.windowType || 'hann', fftSize);
  const fft = new FFT(fftSize);
  const frame = new Float32Array(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const norm = 2 / (sum || 1);
  const power = new Float64Array(bins);
  let count = 0;

  if (len <= 0) return { db: new Float32Array(bins).fill(-120), bins, fftSize, frames: 0 };

  if (len < fftSize) {
    for (let i = 0; i < fftSize; i++) { const idx = s0 + i; frame[i] = idx < s1 ? data[idx] * win[i] : 0; }
    fft.forward(frame, re, im);
    for (let b = 0; b < bins; b++) { const m = Math.hypot(re[b], im[b]) * norm; power[b] += m * m; }
    count = 1;
  } else {
    const overlap = Math.min(0.95, Math.max(0, opts.overlap ?? 0.5));
    const hop = Math.max(1, Math.round(fftSize * (1 - overlap)));
    for (let off = s0; off + fftSize <= s1; off += hop) {
      for (let i = 0; i < fftSize; i++) frame[i] = data[off + i] * win[i];
      fft.forward(frame, re, im);
      for (let b = 0; b < bins; b++) { const m = Math.hypot(re[b], im[b]) * norm; power[b] += m * m; }
      count++;
    }
  }

  const db = new Float32Array(bins);
  const c = count || 1;
  for (let b = 0; b < bins; b++) db[b] = 10 * Math.log10(power[b] / c + 1e-12);
  return { db, bins, fftSize, frames: count };
}

/** Render a magnitude spectrum as a line plot (frequency x-axis, dB y-axis). */
export function renderFreqResponse(canvas, resp, opts = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = canvas._dpr || 1;
  const W = canvas._cssW || canvas.width;
  const H = canvas._cssH || canvas.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const plotX = FR_LEFT;
  const plotW = Math.max(1, W - FR_LEFT);
  const plotH = Math.max(1, H - FR_BOTTOM);
  const sampleRate = opts.sampleRate || 48000;
  const scale = opts.scale || 'log';
  const dbMin = opts.dbMin ?? -120;
  const dbMax = opts.dbMax ?? 0;
  const nyq = sampleRate / 2;

  let fMin = effectiveFMin(scale, opts.fMin ?? 0, nyq);
  let fMax = opts.fMax > 0 ? Math.min(opts.fMax, nyq) : nyq;
  if (fMax <= fMin) { fMin = effectiveFMin(scale, 0, nyq); fMax = nyq; }

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = opts.background || '#141821';
  ctx.fillRect(0, 0, W, H);

  const sMin = scaleForward(scale, fMin);
  const sMax = scaleForward(scale, fMax);
  const dbSpan = (dbMax - dbMin) || 1;
  const yFor = (db) => { let t = (dbMax - db) / dbSpan; if (t < 0) t = 0; else if (t > 1) t = 1; return t * plotH; };

  // dB gridlines + labels (left)
  ctx.font = '9px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const dbStep = dbSpan <= 24 ? 6 : dbSpan <= 60 ? 10 : dbSpan <= 140 ? 20 : 40;
  for (let db = Math.ceil(dbMin / dbStep) * dbStep; db <= dbMax + 1e-6; db += dbStep) {
    const y = yFor(db);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plotX, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke();
    ctx.fillStyle = 'rgba(200,206,216,0.85)';
    ctx.textAlign = 'right';
    ctx.fillText(db.toFixed(0), plotX - 4, Math.min(plotH - 5, Math.max(6, y)));
  }

  // frequency gridlines + labels (bottom)
  const ticks = freqTicks(scale, fMin, fMax);
  ctx.textBaseline = 'top';
  for (const f of ticks) {
    const x = plotX + ((scaleForward(scale, f) - sMin) / ((sMax - sMin) || 1)) * plotW;
    if (x < plotX - 1 || x > W + 1) continue;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, plotH); ctx.stroke();
    ctx.fillStyle = 'rgba(200,206,216,0.85)';
    ctx.textAlign = 'center';
    ctx.fillText(formatHz(f), Math.min(W - 10, Math.max(plotX + 10, x)), plotH + 3);
  }

  // the response curve
  if (resp && resp.db) {
    const bins = resp.bins, fftSize = resp.fftSize;
    ctx.strokeStyle = opts.color || '#7dd3fc';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let px = 0; px <= plotW; px++) {
      const s = sMin + (px / plotW) * (sMax - sMin);
      const f = scaleInverse(scale, s);
      let binF = (f * fftSize) / sampleRate;
      if (binF < 0) binF = 0; else if (binF > bins - 1) binF = bins - 1;
      const b0 = binF | 0, b1 = Math.min(bins - 1, b0 + 1), fr = binF - b0;
      const db = resp.db[b0] * (1 - fr) + resp.db[b1] * fr;
      const x = plotX + px, y = yFor(db);
      if (px === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(160,170,185,0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('dB', 3, 3);
}
