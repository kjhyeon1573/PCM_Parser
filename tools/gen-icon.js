'use strict';
// Generate the app icon with zero external deps.
// Draws a supersampled master, downsamples to several sizes, PNG-encodes each
// (via Node's built-in zlib), and packs them into a Vista-style PNG .ico.
// Run: node tools/gen-icon.js  ->  build/icon.ico + build/icon.png

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- drawing
const S = 1024; // master (supersampled) resolution
const master = drawMaster(S);

function lerp(a, b, t) { return a + (b - a) * t; }

// signed distance helpers for a rounded rectangle
function roundRectInside(x, y, x0, y0, x1, y1, r) {
  let dx = 0, dy = 0;
  if (x < x0 + r) dx = x0 + r - x; else if (x > x1 - r) dx = x - (x1 - r);
  if (y < y0 + r) dy = y0 + r - y; else if (y > y1 - r) dy = y - (y1 - r);
  return dx * dx + dy * dy <= r * r;
}

function drawMaster(size) {
  const buf = new Uint8Array(size * size * 4); // transparent by default

  const margin = size * 0.055;
  const x0 = margin, y0 = margin, x1 = size - margin, y1 = size - margin;
  const radius = size * 0.20;

  // background gradient (top light-blue -> bottom deep-blue)
  const top = [86, 148, 255];
  const bot = [22, 78, 170];

  // waveform bars (equalizer-like), heights as fraction of half-height
  const bars = [0.28, 0.52, 0.80, 0.44, 1.00, 0.62, 0.86, 0.40, 0.30];
  const barColor = [244, 248, 255];
  const areaX0 = size * 0.215, areaX1 = size * 0.785;
  const cy = size * 0.52;
  const maxHalf = size * 0.26;
  const n = bars.length;
  const slot = (areaX1 - areaX0) / n;
  const barW = slot * 0.52;
  const barR = barW * 0.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!roundRectInside(x, y, x0, y0, x1, y1, radius)) continue;

      // background
      const t = (y - y0) / (y1 - y0);
      let r = lerp(top[0], bot[0], t);
      let g = lerp(top[1], bot[1], t);
      let b = lerp(top[2], bot[2], t);
      // subtle diagonal sheen
      const sheen = 1 + 0.06 * ((x - size / 2) / size - (y - size / 2) / size);
      r *= sheen; g *= sheen; b *= sheen;

      // bars on top
      let onBar = false;
      for (let k = 0; k < n; k++) {
        const bx = areaX0 + slot * (k + 0.5);
        const bh = maxHalf * bars[k];
        if (roundRectInside(x, y, bx - barW / 2, cy - bh, bx + barW / 2, cy + bh, barR)) {
          onBar = true;
          break;
        }
      }
      if (onBar) { r = barColor[0]; g = barColor[1]; b = barColor[2]; }

      buf[i] = clamp8(r);
      buf[i + 1] = clamp8(g);
      buf[i + 2] = clamp8(b);
      buf[i + 3] = 255;
    }
  }
  return { data: buf, size };
}

function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

// ---------------------------------------------------------- downsampling
// Premultiplied box average -> clean edges, correct non-integer factors.
function downsample(src, srcSize, size) {
  const sumR = new Float64Array(size * size);
  const sumG = new Float64Array(size * size);
  const sumB = new Float64Array(size * size);
  const sumA = new Float64Array(size * size);
  const cnt = new Float64Array(size * size);
  const f = size / srcSize;

  for (let sy = 0; sy < srcSize; sy++) {
    const ty = Math.min(size - 1, Math.floor(sy * f));
    for (let sx = 0; sx < srcSize; sx++) {
      const tx = Math.min(size - 1, Math.floor(sx * f));
      const si = (sy * srcSize + sx) * 4;
      const ti = ty * size + tx;
      const a = src[si + 3] / 255;
      sumR[ti] += src[si] * a;
      sumG[ti] += src[si + 1] * a;
      sumB[ti] += src[si + 2] * a;
      sumA[ti] += a;
      cnt[ti] += 1;
    }
  }

  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = sumA[i];
    const o = i * 4;
    if (a > 0) {
      out[o] = clamp8(sumR[i] / a);
      out[o + 1] = clamp8(sumG[i] / a);
      out[o + 2] = clamp8(sumB[i] / a);
      out[o + 3] = clamp8((a / cnt[i]) * 255);
    }
  }
  return out;
}

// -------------------------------------------------------------- PNG encode
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePng(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // raw scanlines with filter byte 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// -------------------------------------------------------------- ICO pack
function packIco(images) {
  // images: [{ size, png:Buffer }]
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: icon
  header.writeUInt16LE(count, 4);

  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const datas = [];
  images.forEach((img, idx) => {
    const e = idx * 16;
    entries[e] = img.size >= 256 ? 0 : img.size;      // width
    entries[e + 1] = img.size >= 256 ? 0 : img.size;  // height
    entries[e + 2] = 0;   // palette
    entries[e + 3] = 0;   // reserved
    entries.writeUInt16LE(1, e + 4);   // planes
    entries.writeUInt16LE(32, e + 6);  // bit count
    entries.writeUInt32LE(img.png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
    datas.push(img.png);
  });
  return Buffer.concat([header, entries, ...datas]);
}

// -------------------------------------------------------------- build
const sizes = [256, 128, 64, 48, 32, 16];
const images = sizes.map((sz) => {
  const rgba = sz === S ? master.data : downsample(master.data, S, sz);
  return { size: sz, png: encodePng(rgba, sz) };
});

const ico = packIco(images);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
fs.writeFileSync(path.join(outDir, 'icon.png'), images[0].png); // 256px PNG

console.log('Wrote build/icon.ico (' + sizes.join(', ') + ') and build/icon.png');
console.log('icon.ico size:', ico.length, 'bytes');
