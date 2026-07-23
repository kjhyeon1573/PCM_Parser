'use strict';

/**
 * Encode deinterleaved Float32 channels (values in [-1,1]) into a WAV ArrayBuffer.
 * @param {Float32Array[]} channels  equal-length channel arrays
 * @param {number} sampleRate
 * @param {object} opts { bitDepth: 16|24|32, float: boolean }
 */
export function encodeWav(channels, sampleRate, opts = {}) {
  const bitDepth = opts.bitDepth || 16;
  const float = !!opts.float;
  const numChannels = channels.length;
  const frameCount = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frameCount * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buffer);

  const format = float ? 3 : 1; // 3 = IEEE float, 1 = PCM
  writeStr(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(dv, 8, 'WAVE');
  writeStr(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, format, true);
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitDepth, true);
  writeStr(dv, 36, 'data');
  dv.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < numChannels; c++) {
      const arr = channels[c];
      const s = i < arr.length ? arr[i] : 0;
      off = writeSample(dv, off, s, bitDepth, float);
    }
  }
  return buffer;
}

function writeSample(dv, off, s, bitDepth, float) {
  if (float) {
    dv.setFloat32(off, s, true);
    return off + 4;
  }
  const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
  if (bitDepth === 16) {
    dv.setInt16(off, Math.round(clamped * 32767), true);
    return off + 2;
  } else if (bitDepth === 24) {
    let v = Math.round(clamped * 8388607);
    if (v < 0) v += 0x1000000;
    dv.setUint8(off, v & 0xff);
    dv.setUint8(off + 1, (v >> 8) & 0xff);
    dv.setUint8(off + 2, (v >> 16) & 0xff);
    return off + 3;
  } else if (bitDepth === 32) {
    dv.setInt32(off, Math.round(clamped * 2147483647), true);
    return off + 4;
  }
  throw new Error('Unsupported bit depth: ' + bitDepth);
}

function writeStr(dv, off, s) {
  for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
}
