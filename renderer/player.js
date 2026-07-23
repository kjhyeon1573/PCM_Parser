'use strict';

/**
 * Simple single-track Web Audio player. Plays a set of Float32 channels
 * (mixed down to the output device) with play/pause/seek and a position callback.
 */
export class Player {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.sampleRate = 48000;
    this.startedAt = 0;      // ctx time when playback (re)started
    this.offset = 0;         // seconds into the buffer where playback started
    this.playing = false;
    this.onEnded = null;
    this.ownerId = null;     // which file id currently owns the player
  }

  _ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this.ctx;
  }

  /** Load deinterleaved Float32 channels at a given sample rate for playback. */
  load(ownerId, channels, sampleRate) {
    this.stop();
    const ctx = this._ensureCtx();
    this.sampleRate = sampleRate;
    this.ownerId = ownerId;
    const len = channels[0] ? channels[0].length : 0;
    const buf = ctx.createBuffer(Math.max(1, channels.length), Math.max(1, len), sampleRate);
    for (let c = 0; c < channels.length; c++) {
      buf.copyToChannel(channels[c], c);
    }
    this.buffer = buf;
    this.offset = 0;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  get currentTime() {
    if (!this.ctx || !this.buffer) return 0;
    if (this.playing) {
      return Math.min(this.duration, this.offset + (this.ctx.currentTime - this.startedAt));
    }
    return this.offset;
  }

  play() {
    if (!this.buffer) return;
    const ctx = this._ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    if (this.playing) return;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(ctx.destination);
    src.onended = () => {
      if (this._stopping) return;
      this.playing = false;
      this.offset = 0;
      if (this.onEnded) this.onEnded();
    };
    const startOffset = Math.min(this.offset, this.duration);
    src.start(0, startOffset);
    this.source = src;
    this.startedAt = ctx.currentTime;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime;
    this._stopSource();
    this.playing = false;
  }

  stop() {
    this._stopSource();
    this.playing = false;
    this.offset = 0;
  }

  seek(seconds) {
    const t = Math.max(0, Math.min(this.duration, seconds));
    const wasPlaying = this.playing;
    this._stopSource();
    this.offset = t;
    this.playing = false;
    if (wasPlaying) this.play();
  }

  _stopSource() {
    if (this.source) {
      this._stopping = true;
      try { this.source.stop(); } catch (e) {}
      try { this.source.disconnect(); } catch (e) {}
      this.source = null;
      this._stopping = false;
    }
  }
}
