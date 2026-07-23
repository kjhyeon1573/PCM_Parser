# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-23

Initial release. A Windows/Electron GUI for inspecting raw (headerless) PCM
audio dumps and exporting selected channels to a single N-channel WAV.

### Added
- **File loading**
  - Open one or more raw PCM files via a dialog or by **dragging files onto the window**.
  - Per-file, user-selectable sample format: 8/16/24/32-bit signed/unsigned,
    32/64-bit float, little/big-endian, sample rate, channel count, and a
    header-bytes offset to skip.
  - Handles both **mono-per-file** and **interleaved multichannel** files
    (automatic deinterleaving).
- **Waveform**
  - Per-channel min/max peak waveform with amplitude (left) and time (bottom) axes,
    and click-to-seek.
  - **Zoom & pan**: mouse wheel zooms at the pointer, drag to pan, and ± / Reset
    buttons; the playback cursor and axes follow the zoom (shared across a file's channels).
  - **Hilbert amplitude envelope** (RMS-like) overlay toggle per channel.
  - Per-channel view mode: **Waveform / Spectrogram / Both**.
- **Preview playback**
  - Per-file play / pause / seek via the Web Audio API, with a synced cursor.
  - **Mixed N-channel preview**: monitor the selected export channels
    down-mixed to a mono track, with a seekable progress bar.
- **Spectrogram**
  - Per-channel STFT spectrogram (magma colormap) with global controls:
    - Window type: Rectangular, Hann, Hamming, Blackman, Blackman-Harris,
      Bartlett, Flat-top.
    - FFT/window size (256–8192) and overlap (0–87.5%).
    - Frequency scale: **linear, logarithmic, mel, bark**.
    - Adjustable frequency range and dB (color) range.
    - Frequency (Hz) and time axes.
  - dBFS normalization (a full-scale tone reads ~0 dB) independent of window/size.
- **Live updates**
  - Changing a file's format/channels/sample-rate/header re-parses and redraws
    its waveforms and spectrograms, including the sample-rate-aware Hz axis.
  - Canvases track window/layout size changes via a `ResizeObserver`.
- **Export**
  - Tick channels across any open files, reorder them, and export as an
    N-channel WAV (16/24/32-bit PCM or 32-bit float).
  - Editable output filename and remembered save directory; the recent save
    path is shown after export.
  - Warns before saving when selected channels differ in length (shorter
    channels are padded with trailing silence) or sample rate (no resampling).
- **App icon** generated procedurally with zero external dependencies
  (`npm run icon`).
- **Tooling**: sample generator (`tools/gen-test-pcm.js`), logic unit tests
  (`tools/test.mjs`, 54 assertions), and an Electron renderer smoke test
  (`tools/smoke-electron.js`).

[1.0.0]: https://github.com/kjhyeon1573/PCM_Parser/releases/tag/v1.0.0
