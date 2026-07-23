'use strict';

// Analysis window functions for the STFT. Each returns { win, sum }
// where `sum` is the coherent gain (Σ w[n]) used for amplitude normalization.

export const WINDOWS = {
  rectangular:     'Rectangular',
  hann:            'Hann',
  hamming:         'Hamming',
  blackman:        'Blackman',
  'blackman-harris': 'Blackman-Harris',
  bartlett:        'Bartlett (triangular)',
  flattop:         'Flat-top'
};

export function makeWindow(type, N) {
  const win = new Float32Array(N);
  const M = N - 1;
  const cos = (k, n) => Math.cos((2 * Math.PI * k * n) / M);

  switch (type) {
    case 'rectangular':
      win.fill(1);
      break;
    case 'hamming':
      for (let n = 0; n < N; n++) win[n] = 0.54 - 0.46 * cos(1, n);
      break;
    case 'blackman':
      for (let n = 0; n < N; n++) win[n] = 0.42 - 0.5 * cos(1, n) + 0.08 * cos(2, n);
      break;
    case 'blackman-harris':
      for (let n = 0; n < N; n++)
        win[n] = 0.35875 - 0.48829 * cos(1, n) + 0.14128 * cos(2, n) - 0.01168 * cos(3, n);
      break;
    case 'bartlett':
      for (let n = 0; n < N; n++) win[n] = 1 - Math.abs((n - M / 2) / (M / 2));
      break;
    case 'flattop':
      for (let n = 0; n < N; n++)
        win[n] = 0.21557895 - 0.41663158 * cos(1, n) + 0.277263158 * cos(2, n)
               - 0.083578947 * cos(3, n) + 0.006947368 * cos(4, n);
      break;
    case 'hann':
    default:
      for (let n = 0; n < N; n++) win[n] = 0.5 - 0.5 * cos(1, n);
      break;
  }

  let sum = 0;
  for (let n = 0; n < N; n++) sum += win[n];
  return { win, sum };
}
