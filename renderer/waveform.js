'use strict';

// Axis gutters (device pixels). Kept equal to the spectrogram's gutters so the
// two plots line up in "Both" mode. left = amplitude scale, bottom = time scale.
export const WF_LEFT = 46;
export const WF_BOTTOM = 18;

/**
 * Draw a min/max peak waveform of a Float32 channel, zoomed to a sample window
 * [start, end) (time) and an amplitude window [center-range, center+range]
 * (vertical), with amplitude (left) and time (bottom) axes and an optional
 * Hilbert amplitude envelope overlay.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Float32Array} data
 * @param {object} opts { start, end, sampleRate, ampCenter, ampRange,
 *                        color, background, envelope, envelopeColor }
 */
export function drawWaveform(canvas, data, opts = {}) {
  const ctx = canvas.getContext('2d');
  // HiDPI: buffer is dpr× the CSS size; draw in CSS-pixel logical coordinates.
  const dpr = canvas._dpr || 1;
  const w = canvas._cssW || canvas.width;
  const h = canvas._cssH || canvas.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const plotX = WF_LEFT;
  const plotW = Math.max(1, w - WF_LEFT);
  const plotH = Math.max(1, h - WF_BOTTOM);
  const mid = plotH / 2;

  const start = Math.max(0, opts.start ?? 0);
  const end = Math.min(data ? data.length : 0, opts.end ?? (data ? data.length : 0));
  const sr = opts.sampleRate || 48000;
  const center = opts.ampCenter ?? 0;
  const range = opts.ampRange || 1;

  // amplitude → y within the plot; k = (amp-center)/range in [-1,1] fills the plot
  const yFor = (amp) => mid - ((amp - center) / range) * mid;
  const clampY = (y) => (y < 0 ? 0 : y > plotH ? plotH : y);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = opts.background || '#141821';
  ctx.fillRect(0, 0, w, h);

  // ---- amplitude axis (left gutter) + horizontal gridlines ----
  ctx.font = '9px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  const dec = range < 0.1 ? 3 : 2;
  for (const k of [1, 0.5, 0, -0.5, -1]) {
    const y = mid - k * mid;
    const ampVal = center + k * range;
    ctx.strokeStyle = k === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(200,206,216,0.85)';
    ctx.fillText(ampVal.toFixed(dec), plotX - 4, Math.min(plotH - 5, Math.max(6, y)));
  }

  if (data && end > start) {
    const n = end - start;
    const samplesPerPx = n / plotW;

    // ---- waveform ----
    ctx.strokeStyle = opts.color || '#4ea1ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < plotW; x++) {
      const s0 = start + Math.floor(x * samplesPerPx);
      const s1 = Math.min(end, start + Math.floor((x + 1) * samplesPerPx));
      let min = Infinity, max = -Infinity;
      if (s1 <= s0) {
        const v = data[Math.min(end - 1, s0)];
        min = max = v;
      } else {
        for (let i = s0; i < s1; i++) {
          const v = data[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      const px = plotX + x + 0.5;
      const y1 = clampY(yFor(max));
      const y2 = clampY(yFor(min));
      ctx.moveTo(px, y1);
      ctx.lineTo(px, Math.max(y2, y1 + 1));
    }
    ctx.stroke();

    // ---- Hilbert amplitude envelope (mirrored around amplitude 0) ----
    if (opts.envelope && opts.envelope.length) {
      const env = opts.envelope;
      const upper = new Float32Array(plotW);
      for (let x = 0; x < plotW; x++) {
        const s0 = start + Math.floor(x * samplesPerPx);
        const s1 = Math.min(end, start + Math.floor((x + 1) * samplesPerPx));
        let peak = 0;
        const b = Math.max(s0 + 1, s1);
        for (let i = s0; i < b && i < env.length; i++) if (env[i] > peak) peak = env[i];
        upper[x] = peak;
      }
      const col = opts.envelopeColor || '#ffcf5c';
      ctx.fillStyle = 'rgba(255,207,92,0.13)';
      ctx.beginPath();
      ctx.moveTo(plotX + 0.5, clampY(yFor(upper[0])));
      for (let x = 1; x < plotW; x++) ctx.lineTo(plotX + x + 0.5, clampY(yFor(upper[x])));
      for (let x = plotW - 1; x >= 0; x--) ctx.lineTo(plotX + x + 0.5, clampY(yFor(-upper[x])));
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.25;
      for (const sign of [1, -1]) {
        ctx.beginPath();
        for (let x = 0; x < plotW; x++) {
          const y = clampY(yFor(sign * upper[x]));
          if (x === 0) ctx.moveTo(plotX + x + 0.5, y); else ctx.lineTo(plotX + x + 0.5, y);
        }
        ctx.stroke();
      }
    }

    // ---- time axis (bottom gutter) ----
    ctx.fillStyle = 'rgba(200,206,216,0.85)';
    ctx.textBaseline = 'top';
    const startSec = start / sr;
    const durSec = n / sr;
    const nT = 6;
    for (let i = 0; i <= nT; i++) {
      const frac = i / nT;
      const x = plotX + frac * plotW;
      const t = startSec + frac * durSec;
      ctx.textAlign = i === 0 ? 'left' : i === nT ? 'right' : 'center';
      const xx = i === 0 ? plotX + 1 : i === nT ? w - 1 : x;
      ctx.fillText(t.toFixed(durSec < 1 ? 3 : 2) + 's', xx, plotH + 3);
    }
  }
}

/** Draw a vertical playback cursor at a normalized [0,1] position within the plot. */
export function drawCursor(canvas, pos, color = '#ff5c5c') {
  const ctx = canvas.getContext('2d');
  const dpr = canvas._dpr || 1;
  const w = canvas._cssW || canvas.width;
  const h = canvas._cssH || canvas.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const plotW = w - WF_LEFT;
  const x = Math.round(WF_LEFT + pos * plotW) + 0.5;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, h - WF_BOTTOM);
  ctx.stroke();
}
