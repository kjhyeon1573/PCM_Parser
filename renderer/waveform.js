'use strict';

/**
 * Draw a min/max peak waveform of a Float32 channel onto a canvas.
 * Draws one vertical min..max bar per pixel column for fast, accurate rendering
 * of arbitrarily long signals.
 */
export function drawWaveform(canvas, data, opts = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const mid = h / 2;

  ctx.clearRect(0, 0, w, h);

  // background
  ctx.fillStyle = opts.background || '#141821';
  ctx.fillRect(0, 0, w, h);

  // center line
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();

  if (!data || data.length === 0) return;

  const n = data.length;
  const samplesPerPx = n / w;

  ctx.strokeStyle = opts.color || '#4ea1ff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const start = Math.floor(x * samplesPerPx);
    const end = Math.min(n, Math.floor((x + 1) * samplesPerPx));
    let min = 1, max = -1;
    if (end <= start) {
      const v = data[Math.min(n - 1, start)];
      min = max = v;
    } else {
      for (let i = start; i < end; i++) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    const y1 = mid - max * mid;
    const y2 = mid - min * mid;
    ctx.moveTo(x + 0.5, y1);
    ctx.lineTo(x + 0.5, Math.max(y2, y1 + 1));
  }
  ctx.stroke();
}

/** Draw a vertical playback cursor at a normalized [0,1] position. */
export function drawCursor(canvas, pos, color = '#ff5c5c') {
  const ctx = canvas.getContext('2d');
  const x = Math.round(pos * canvas.width) + 0.5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvas.height);
  ctx.stroke();
  ctx.restore();
}
