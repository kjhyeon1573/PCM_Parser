'use strict';

// PCM sample formats. `bytes` is the size of one sample of one channel.
export const FORMATS = {
  u8:     { label: '8-bit unsigned',        bytes: 1, read: (dv, o) => (dv.getUint8(o) - 128) / 128 },
  s8:     { label: '8-bit signed',          bytes: 1, read: (dv, o) => dv.getInt8(o) / 128 },
  s16le:  { label: '16-bit signed LE',      bytes: 2, read: (dv, o) => dv.getInt16(o, true) / 32768 },
  s16be:  { label: '16-bit signed BE',      bytes: 2, read: (dv, o) => dv.getInt16(o, false) / 32768 },
  u16le:  { label: '16-bit unsigned LE',    bytes: 2, read: (dv, o) => (dv.getUint16(o, true) - 32768) / 32768 },
  s24le:  { label: '24-bit signed LE',      bytes: 3, read: (dv, o) => read24(dv, o, true) / 8388608 },
  s24be:  { label: '24-bit signed BE',      bytes: 3, read: (dv, o) => read24(dv, o, false) / 8388608 },
  s32le:  { label: '32-bit signed LE',      bytes: 4, read: (dv, o) => dv.getInt32(o, true) / 2147483648 },
  s32be:  { label: '32-bit signed BE',      bytes: 4, read: (dv, o) => dv.getInt32(o, false) / 2147483648 },
  f32le:  { label: '32-bit float LE',       bytes: 4, read: (dv, o) => dv.getFloat32(o, true) },
  f32be:  { label: '32-bit float BE',       bytes: 4, read: (dv, o) => dv.getFloat32(o, false) },
  f64le:  { label: '64-bit float LE',       bytes: 8, read: (dv, o) => dv.getFloat64(o, true) }
};

function read24(dv, o, little) {
  let v;
  if (little) {
    v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
  } else {
    v = (dv.getUint8(o) << 16) | (dv.getUint8(o + 1) << 8) | dv.getUint8(o + 2);
  }
  // sign-extend from 24 bits
  if (v & 0x800000) v |= ~0xffffff;
  return v;
}

/**
 * Parse a raw PCM ArrayBuffer into deinterleaved Float32 channels in [-1, 1].
 * @param {ArrayBuffer} buffer
 * @param {object} opts { format, channels, headerBytes }
 * @returns {{ channels: Float32Array[], frameCount: number, bytesUsed: number, bytesDropped: number }}
 */
export function parsePcm(buffer, opts) {
  const fmt = FORMATS[opts.format];
  if (!fmt) throw new Error('Unknown format: ' + opts.format);
  const channels = Math.max(1, opts.channels | 0);
  const headerBytes = Math.max(0, opts.headerBytes | 0);

  const dv = new DataView(buffer);
  const total = buffer.byteLength - headerBytes;
  const frameBytes = fmt.bytes * channels;
  const frameCount = Math.floor(total / frameBytes);
  const bytesUsed = frameCount * frameBytes;

  const out = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frameCount));

  const read = fmt.read;
  const sb = fmt.bytes;
  for (let i = 0; i < frameCount; i++) {
    const base = headerBytes + i * frameBytes;
    for (let c = 0; c < channels; c++) {
      out[c][i] = read(dv, base + c * sb);
    }
  }

  return {
    channels: out,
    frameCount,
    bytesUsed,
    bytesDropped: total - bytesUsed
  };
}

/** Compute peak (max abs) and RMS for a channel — used for quick stats. */
export function channelStats(data) {
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
    sumSq += data[i] * data[i];
  }
  const rms = data.length ? Math.sqrt(sumSq / data.length) : 0;
  return { peak, rms };
}
