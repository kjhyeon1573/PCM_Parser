'use strict';

// Axis gutters (device pixels): left = amplitude scale, bottom = time scale.
export const WF_LEFT = 40;
export const WF_BOTTOM = 16;

/**
 * Draw a min/max peak waveform of a Float32 channel, zoomed to a sample window
 * [start, end), with amplitude (left) and time (bottom) axes, and an optional
 * Hilbert amplitude envelope overlay. One vertical min..max bar per pixel column.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Float32Array} data
 * @param {object} opts { start, end, sampleRate, color, background, envelope, envelopeColor }
 */
export function drawWaveform(canvas, data, opts = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  const plotX = WF_LEFT;
  const plotW = Math.max(1, w - WF_LEFT);
  const plotH = Math.max(1, h - WF_BOTTOM);
  const mid = plotH / 2;

  const start = Math.max(0, opts.start ?? 0);
  const end = Math.min(data ? data.length : 0, opts.end ?? (data ? data.length : 0));
  const sr = opts.sampleRate || 48000;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = opts.background || '#141821';
  ctx.fillRect(0, 0, w, h);

  // ---- amplitude axis (left gutter) + horizontal gridlines ----
  ctx.font = '9px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (const amp of [1, 0.5, 0, -0.5, -1]) {
    const y = mid - amp * mid;
    ctx.strokeStyle = amp === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(200,206,216,0.85)';
    ctx.fillText(amp.toFixed(1), plotX - 4, Math.min(plotH - 5, Math.max(6, y)));
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
      let min = 1, max = -1;
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
      const y1 = mid - max * mid;
      const y2 = mid - min * mid;
      ctx.moveTo(px, y1);
      ctx.lineTo(px, Math.max(y2, y1 + 1));
    }
    ctx.stroke();

    // ---- Hilbert amplitude envelope (mirrored around center) ----
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
      ctx.moveTo(plotX + 0.5, mid - upper[0] * mid);
      for (let x = 1; x < plotW; x++) ctx.lineTo(plotX + x + 0.5, mid - upper[x] * mid);
      for (let x = plotW - 1; x >= 0; x--) ctx.lineTo(plotX + x + 0.5, mid + upper[x] * mid);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.25;
      for (const sign of [-1, 1]) {
        ctx.beginPath();
        for (let x = 0; x < plotW; x++) {
          const y = mid + sign * upper[x] * mid;
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
  const plotW = canvas.width - WF_LEFT;
  const x = Math.round(WF_LEFT + pos * plotW) + 0.5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvas.height - WF_BOTTOM);
  ctx.stroke();
  ctx.restore();
}
