'use strict';

// Iterative in-place radix-2 Cooley-Tukey FFT. Size must be a power of two.
export class FFT {
  constructor(size) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT size must be a power of 2');
    this.size = size;
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    // bit-reversal table
    this.rev = new Uint32Array(size);
    let bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let x = i, r = 0;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r;
    }
  }

  /**
   * Forward FFT of real input. Writes into supplied re/im scratch buffers (length = size).
   * @param {Float32Array} input real samples (length = size)
   * @param {Float32Array} re scratch
   * @param {Float32Array} im scratch
   */
  forward(input, re, im) {
    const n = this.size;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      re[i] = input[rev[i]];
      im[i] = 0;
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        let k = 0;
        for (let j = i; j < i + half; j++) {
          const c = this.cos[k];
          const s = this.sin[k];
          const tre = re[j + half] * c - im[j + half] * s;
          const tim = re[j + half] * s + im[j + half] * c;
          re[j + half] = re[j] - tre;
          im[j + half] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
          k += step;
        }
      }
    }
  }
}

/** Precomputed Hann window of a given length. */
export function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}
