'use strict';

import { FFT } from './fft.js';

/**
 * Amplitude envelope of a real signal via the Hilbert transform.
 * Builds the analytic signal (positive frequencies doubled, negatives zeroed)
 * and returns its magnitude |x + j·H{x}| — the instantaneous amplitude.
 *
 * @param {Float32Array} data
 * @param {object} opts { smooth } — optional moving-average length (samples)
 *                        to turn the raw envelope into an RMS-like curve.
 * @returns {Float32Array} envelope (same length as input, values ≥ 0)
 */
export function hilbertEnvelope(data, opts = {}) {
  const N = data.length;
  if (N === 0) return new Float32Array(0);

  let M = 1;
  while (M < N) M <<= 1; // next power of two ≥ N (zero-padded)

  const fft = new FFT(M);
  const re = new Float32Array(M);
  const im = new Float32Array(M);
  re.set(data);

  fft.fftInPlace(re, im, false); // forward FFT of the (real) signal

  // Analytic-signal multiplier: h[0]=1, h[N/2]=1, h[1..N/2-1]=2, rest=0
  const half = M >> 1;
  for (let k = 1; k < half; k++) { re[k] *= 2; im[k] *= 2; }
  for (let k = half + 1; k < M; k++) { re[k] = 0; im[k] = 0; }

  fft.fftInPlace(re, im, true); // inverse → analytic signal in re/im

  const env = new Float32Array(N);
  for (let i = 0; i < N; i++) env[i] = Math.hypot(re[i], im[i]);

  const smooth = opts.smooth | 0;
  return smooth > 1 ? boxSmooth(env, smooth) : env;
}

/** Centered moving-average smoothing via a prefix sum (edge-clamped window). */
function boxSmooth(x, win) {
  const N = x.length;
  const half = win >> 1;
  const prefix = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) prefix[i + 1] = prefix[i] + x[i];
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(N - 1, i + half);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}
