'use strict';

// Generate sample raw PCM dumps for testing the parser.
// Usage: node tools/gen-test-pcm.js  (writes into ./samples)

const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'samples');
fs.mkdirSync(outDir, { recursive: true });

const SR = 48000;
const DUR = 2.0; // seconds
const N = Math.floor(SR * DUR);

function sine(freq, amp = 0.6) {
  const a = new Float32Array(N);
  for (let i = 0; i < N; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return a;
}

function sweep(f0, f1, amp = 0.6) {
  const a = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const f = f0 + (f1 - f0) * (t / DUR);
    a[i] = amp * Math.sin(2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * DUR)));
  }
  return a;
}

function toS16LE(chs) {
  const nch = chs.length;
  const buf = Buffer.alloc(N * nch * 2);
  let o = 0;
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < nch; c++) {
      let v = Math.max(-1, Math.min(1, chs[c][i]));
      buf.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  }
  return buf;
}

// Mono files (1 channel each) — for the "combine several mono files" workflow
fs.writeFileSync(path.join(outDir, 'mono_440hz.s16le.pcm'), toS16LE([sine(440)]));
fs.writeFileSync(path.join(outDir, 'mono_1000hz.s16le.pcm'), toS16LE([sine(1000)]));
fs.writeFileSync(path.join(outDir, 'mono_sweep.s16le.pcm'), toS16LE([sweep(200, 12000)]));

// Interleaved stereo file — for the deinterleave workflow
fs.writeFileSync(
  path.join(outDir, 'stereo_interleaved.s16le.pcm'),
  toS16LE([sine(440), sweep(500, 8000)])
);

console.log('Wrote test PCM files to', outDir);
console.log('Format: 16-bit signed LE, sample rate', SR);
