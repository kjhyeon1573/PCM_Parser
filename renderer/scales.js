'use strict';

// Frequency-axis scales. Each maps a frequency (Hz) to a monotonic scale value
// and back, so a spectrogram row can be mapped to a frequency and vice-versa.

export const SCALES = {
  linear: 'Linear',
  log: 'Logarithmic',
  mel: 'Mel',
  bark: 'Bark'
};

function melFwd(f) { return 2595 * Math.log10(1 + f / 700); }
function melInv(m) { return 700 * (Math.pow(10, m / 2595) - 1); }

function barkFwd(f) {
  // Traunmüller (1990)
  return (26.81 * f) / (1960 + f) - 0.53;
}
function barkInv(z) {
  // invert the Traunmüller expression
  const zc = z + 0.53;
  return (1960 * zc) / (26.81 - zc);
}

export function scaleForward(type, f) {
  switch (type) {
    case 'log': return Math.log10(Math.max(f, 1e-6));
    case 'mel': return melFwd(f);
    case 'bark': return barkFwd(f);
    case 'linear':
    default: return f;
  }
}

export function scaleInverse(type, s) {
  switch (type) {
    case 'log': return Math.pow(10, s);
    case 'mel': return melInv(s);
    case 'bark': return barkInv(s);
    case 'linear':
    default: return s;
  }
}

/** Effective minimum frequency for a scale (log/mel/bark can't start at 0 nicely). */
export function effectiveFMin(type, fMin, nyquist) {
  if (type === 'log') return fMin > 0 ? fMin : Math.max(10, nyquist / 1000);
  return Math.max(0, fMin);
}

function niceNum(range, round) {
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nf;
  if (round) nf = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  else nf = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

const DECADE_TICKS = [
  10, 20, 30, 50, 100, 200, 300, 500,
  1000, 2000, 3000, 5000, 10000, 20000, 30000, 50000, 100000
];

/** Choose sensible frequency tick values for the given range and scale. */
export function freqTicks(type, fMin, fMax) {
  if (type === 'linear') {
    const step = niceNum((fMax - fMin) / 6 || 1, true);
    const ticks = [];
    let t = Math.ceil(fMin / step) * step;
    for (; t <= fMax + 1e-6; t += step) ticks.push(t);
    return ticks;
  }
  // log / mel / bark → 1-2-3-5 decade ticks within range
  return DECADE_TICKS.filter((f) => f >= fMin - 1e-6 && f <= fMax + 1e-6);
}

export function formatHz(f) {
  if (f >= 1000) {
    const k = f / 1000;
    return (Math.round(k * 10) / 10) + 'k';
  }
  return String(Math.round(f));
}
