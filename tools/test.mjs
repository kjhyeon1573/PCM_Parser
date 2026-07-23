// Logic smoke tests for the pure (non-DOM) modules.
// Run: node tools/test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parsePcm, channelStats } from '../renderer/pcm.js';
import { encodeWav } from '../renderer/wav.js';
import { FFT, hannWindow } from '../renderer/fft.js';
import { makeWindow, WINDOWS } from '../renderer/windows.js';
import { scaleForward, scaleInverse, freqTicks } from '../renderer/scales.js';
import { computeSpectrogramMatrix } from '../renderer/spectrogram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  PASS ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}
function near(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, `${msg} (${a} ~= ${b})`); }

function toAB(buf) { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }

// dominant frequency of a signal via the provided FFT
function dominantFreq(data, sr) {
  let size = 1;
  while (size * 2 <= data.length && size < 16384) size *= 2;
  const fft = new FFT(size);
  const win = hannWindow(size);
  const frame = new Float32Array(size);
  for (let i = 0; i < size; i++) frame[i] = data[i] * win[i];
  const re = new Float32Array(size), im = new Float32Array(size);
  fft.forward(frame, re, im);
  let best = 0, bestMag = -1;
  for (let b = 1; b < size / 2; b++) {
    const m = re[b] * re[b] + im[b] * im[b];
    if (m > bestMag) { bestMag = m; best = b; }
  }
  return (best * sr) / size;
}

console.log('== PCM parse: interleaved stereo ==');
{
  const buf = fs.readFileSync(path.join(root, 'samples', 'stereo_interleaved.s16le.pcm'));
  const r = parsePcm(toAB(buf), { format: 's16le', channels: 2, headerBytes: 0 });
  ok(r.channels.length === 2, '2 channels deinterleaved');
  ok(r.frameCount === 96000, `frameCount 96000 (got ${r.frameCount})`);
  ok(r.bytesDropped === 0, 'no bytes dropped');
  near(dominantFreq(r.channels[0], 48000), 440, 20, 'ch0 dominant ~440Hz');
  const s0 = channelStats(r.channels[0]);
  near(s0.peak, 0.6, 0.02, 'ch0 peak ~0.6');
}

console.log('== PCM parse: mono ==');
{
  const buf = fs.readFileSync(path.join(root, 'samples', 'mono_1000hz.s16le.pcm'));
  const r = parsePcm(toAB(buf), { format: 's16le', channels: 1, headerBytes: 0 });
  ok(r.frameCount === 96000, `frameCount 96000 (got ${r.frameCount})`);
  near(dominantFreq(r.channels[0], 48000), 1000, 20, 'dominant ~1000Hz');
}

console.log('== header-bytes skip ==');
{
  const base = fs.readFileSync(path.join(root, 'samples', 'mono_440hz.s16le.pcm'));
  const withHdr = Buffer.concat([Buffer.from('JUNKHDR!'), base]); // 8-byte fake header
  const r = parsePcm(toAB(withHdr), { format: 's16le', channels: 1, headerBytes: 8 });
  ok(r.frameCount === 96000, `frameCount 96000 after skipping header (got ${r.frameCount})`);
  near(dominantFreq(r.channels[0], 48000), 440, 20, 'dominant ~440Hz after header skip');
}

console.log('== WAV encode/roundtrip: 2ch 16-bit ==');
{
  const a = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
  const b = new Float32Array([0.1, -0.1, 0.2, -0.2, 0.3, -0.3]);
  const wav = encodeWav([a, b], 48000, { bitDepth: 16 });
  const dv = new DataView(wav);
  const str = (o, n) => String.fromCharCode(...new Uint8Array(wav, o, n));
  ok(str(0, 4) === 'RIFF', 'RIFF header');
  ok(str(8, 4) === 'WAVE', 'WAVE header');
  ok(dv.getUint16(22, true) === 2, 'numChannels = 2');
  ok(dv.getUint32(24, true) === 48000, 'sampleRate = 48000');
  ok(dv.getUint16(34, true) === 16, 'bitDepth = 16');
  const dataSize = dv.getUint32(40, true);
  ok(dataSize === 6 * 2 * 2, `data chunk size ${dataSize}`);
  // first interleaved frame: a[0]=0, b[0]=0.1 -> round(0.1*32767)=3277
  ok(dv.getInt16(44, true) === 0, 'frame0 ch0 == 0');
  near(dv.getInt16(46, true), 3277, 1, 'frame0 ch1 ~3277');
  // clipping: a[3]=1 -> 32767 ; a[4]=-1 -> -32767
  ok(dv.getInt16(44 + 3 * 4, true) === 32767, 'a[3]=1 clamps to 32767');
}

console.log('== WAV encode: 32-bit float ==');
{
  const a = new Float32Array([0.123456, -0.75]);
  const wav = encodeWav([a], 44100, { bitDepth: 32, float: true });
  const dv = new DataView(wav);
  ok(dv.getUint16(20, true) === 3, 'format tag = 3 (float)');
  near(dv.getFloat32(44, true), 0.123456, 1e-6, 'float sample preserved');
}

console.log('== differing lengths pad to longest ==');
{
  const a = new Float32Array([1, 1, 1, 1]);
  const b = new Float32Array([1, 1]);
  const wav = encodeWav([a, b], 8000, { bitDepth: 16 });
  const dv = new DataView(wav);
  ok(dv.getUint32(40, true) === 4 * 2 * 2, 'padded to 4 frames');
  ok(dv.getInt16(44 + 3 * 4 + 2, true) === 0, 'short channel padded with silence');
}

console.log('== window functions ==');
{
  ok(Object.keys(WINDOWS).length >= 6, `${Object.keys(WINDOWS).length} window types available`);
  const rect = makeWindow('rectangular', 8);
  ok(rect.sum === 8, 'rectangular sum = N');
  const hann = makeWindow('hann', 1024);
  ok(hann.win[0] < 1e-6 && hann.win[1023] < 1e-6, 'hann endpoints ~0');
  ok(Math.abs(hann.win[512] - 1) < 0.01, 'hann centre ~1');
  const bh = makeWindow('blackman-harris', 512);
  ok(bh.sum > 0 && bh.sum < 512, 'blackman-harris sum in range');
}

console.log('== frequency scales roundtrip ==');
{
  for (const type of ['linear', 'log', 'mel', 'bark']) {
    for (const f of [50, 440, 1000, 8000, 20000]) {
      const back = scaleInverse(type, scaleForward(type, f));
      near(back, f, Math.max(0.5, f * 0.001), `${type} inverse(forward(${f}))`);
    }
  }
  // monotonic
  ok(scaleForward('mel', 100) < scaleForward('mel', 200), 'mel monotonic');
  ok(scaleForward('bark', 100) < scaleForward('bark', 200), 'bark monotonic');
  const ticks = freqTicks('log', 20, 20000);
  ok(ticks.length >= 4 && ticks.every((t) => t >= 20 && t <= 20000), 'log ticks within range');
}

console.log('== STFT matrix: peak bin tracks tone ==');
{
  const SR = 48000, N = 8192, freq = 3000;
  const sig = new Float32Array(N);
  for (let i = 0; i < N; i++) sig[i] = 0.8 * Math.sin((2 * Math.PI * freq * i) / SR);
  const m = computeSpectrogramMatrix(sig, { windowType: 'hann', fftSize: 1024, overlap: 0.75 });
  ok(m.cols > 1, `matrix has ${m.cols} columns`);
  ok(m.bins === 512, 'bins = fftSize/2');
  // peak bin of a middle column
  const col = Math.floor(m.cols / 2);
  let best = 0, bestVal = -Infinity;
  for (let b = 0; b < m.bins; b++) {
    const v = m.mags[col * m.bins + b];
    if (v > bestVal) { bestVal = v; best = b; }
  }
  const expectBin = Math.round((freq / (SR / 2)) * (m.bins - 1));
  near(best, expectBin, 2, `peak bin ~${expectBin} for ${freq}Hz`);
  ok(bestVal > -6, `peak level near 0 dBFS (got ${bestVal.toFixed(1)} dB)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
