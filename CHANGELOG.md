# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-07-24

### Added
- **Frequency response of a selected region**: drag on a waveform or spectrogram
  to select a time range, and a magnitude spectrum plots below the channel's
  plots (same size). Long regions are Welch power-averaged across overlapping
  windows. A dedicated control bar (window, size, overlap, scale, freq range,
  dB range) sits under the Spectrogram bar.
- **Selection band** drawn on the waveform and spectrogram; **drag its left/right
  edge to resize** the range (the cursor becomes a resize handle near an edge).
- **Snap to another track's range**: a new selection snaps to another file's
  selected range (grid aligned to its start and length), so the same time window
  can be compared across files. Checkbox in the Freq-response bar, on by default.
- **Length mode** for mixing/export: a 2-tab toggle to fit selected channels to
  the **longest (pad with silence)** or **shortest (trim)** channel.

### Changed
- Plot gestures: **drag = select a range**, **click = seek**, **drag a selection
  edge = resize**, **Shift+drag = pan** (previously plain-drag panned and
  Shift+drag selected).

[1.3.0]: https://github.com/kjhyeon1573/PCM_Parser/releases/tag/v1.3.0

## [1.2.0] - 2026-07-24

### Added
- **Playback gain** slider (0–400%) that applies live to both per-file playback
  and the mixed preview (via a Web Audio GainNode).
- **Per-channel plot toggle** (`plot`): turn a channel's plots off to hide its
  peak/rms, view-mode buttons, and waveform/spectrogram, leaving just the checkbox.
- **Adjustable plot height per file**: drag the card's bottom edge up/down to
  resize that file's waveform/spectrogram panels (the handle tracks the cursor).
- **Auto file-name control**: an `auto` checkbox toggles automatic naming; the
  auto name is now `export_<N>ch_<YYYYMMDD_HHMMSS>.wav` (timestamp regenerated at
  save time). Uncheck to edit the name manually.

### Changed
- **HiDPI rendering**: canvases are now backed by a `devicePixelRatio`-scaled
  buffer, so waveforms, spectrograms, axes and cursors render crisply on scaled
  displays.

### Fixed
- **Seeking during playback** no longer stops or jumps: a stale `onended` from
  the superseded audio source could reset playback state; the source lifecycle
  is now guarded so seeking continues smoothly from the new position.
- **Plots/handle clipped off-screen** with 3+ channels in Both mode or several
  files: file cards no longer shrink and clip their content (`flex-shrink: 0`),
  so the plot list scrolls and every card's resize handle stays reachable.

[1.2.0]: https://github.com/kjhyeon1573/PCM_Parser/releases/tag/v1.2.0

## [1.1.1] - 2026-07-23

### Fixed
- **Multichannel playback dropped channels beyond the second.** Per-file playback
  built an N-channel buffer with unchecked channels zero-filled; for channel
  counts without a defined speaker layout (3, 5, …) the Web Audio "speakers"
  down-mix falls back to "discrete", which keeps only the first two channels and
  drops the rest — so e.g. only the last channel of a 3-channel file was silent.
  Playback now uses only the checked channels (1 → mono, 2 → stereo, >2 → summed
  to mono) so every checked channel is audible.

### Added
- A red **"▶ Nch → mono downmix"** note next to a file's Play button when more
  than two of its channels are checked (playback is summed to mono).

[1.1.1]: https://github.com/kjhyeon1573/PCM_Parser/releases/tag/v1.1.1

## [1.1.0] - 2026-07-23

### Added
- **Per-file playback plays only the checked channels** — unchecked channels are
  muted; toggling a channel's checkbox updates the audio live (position preserved).
  Playing with no channels checked shows a hint instead.
- **Spectrogram click-to-seek** with a playback cursor overlay, matching the waveform.
- **Linked time zoom/pan**: zooming or panning the time axis on either the waveform
  or the spectrogram moves both together (shared per-file view).
- **Vertical-axis zoom & pan** on each plot: scroll over the left axis to zoom about
  its center, drag the left axis to pan — amplitude for the waveform, frequency for
  the spectrogram — each with its own reset button (⟲ time / ⟲ amp / ⟲ freq).
- **New-file setting presets**: save the current format/channels/sample-rate/header
  as a named preset (＋), pick one from the list to apply, or delete it. Presets
  persist across sessions (localStorage).

### Changed
- Waveform and spectrogram panels now share a unified height and aligned axis gutters.
- Spectrogram rendering split into a cached frequency-mapped image plus a cheap
  time-crop paint, so panning/zooming in time no longer recomputes the STFT.

[1.1.0]: https://github.com/kjhyeon1573/PCM_Parser/releases/tag/v1.1.0

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
