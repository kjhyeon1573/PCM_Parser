# PCM Parser

Windows / Electron GUI for inspecting **raw (headerless) PCM audio dumps** and
exporting selected channels from multiple files into a single N-channel WAV.

## Features
- Open one or more raw PCM files at once — via the **Open** button or by **dragging files onto the window**
- Per-file, user-selectable format: 8/16/24/32-bit signed/unsigned, 32/64-bit float, LE/BE, sample rate, channel count, and a header-bytes offset to skip
  - Save new-file settings as named **presets** (persisted across sessions)
- Handles both **mono-per-file** and **interleaved multichannel** files (auto-deinterleaved)
- Per-channel **waveform** (min/max peak) with amplitude + time axes and click-to-seek
  - **Time zoom & pan** (wheel/drag over the plot) is linked between the waveform and spectrogram
  - **Vertical-axis zoom & pan** (wheel/drag over the left axis): amplitude for the waveform, frequency for the spectrogram, each with its own reset
  - **Hilbert amplitude envelope** (RMS-like) overlay toggle
  - Per-channel view mode: **Waveform / Spectrogram / Both** (unified height)
- Per-channel **plot toggle** and per-file **plot height** (drag the card's bottom edge)
- **Region analysis**: drag to select a time range → its **frequency response** plots below (Welch-averaged); drag the selection edges to resize; **snap** a new selection to another file's range for alignment
- Plot gestures: drag = select · click = seek · edge = resize · Shift+drag = pan · wheel = zoom
- **Preview playback** — per-file play/pause/seek (also **click the spectrogram** to seek); **only the checked channels are audible**; adjustable **playback gain**. Plus a **mixed N-channel preview** of the export selection
- **HiDPI-crisp** canvases (waveform, spectrogram, axes)
- Per-channel **spectrogram** (STFT, magma colormap) on demand, with global controls:
  window type (Hann/Hamming/Blackman/Blackman-Harris/Bartlett/Flat-top/Rectangular),
  FFT/window size, overlap, frequency scale (**linear / log / mel / bark**),
  frequency range and dB range — with Hz + time axes
- Changing a file's format/channels/sample-rate/header re-parses and **redraws its
  waveforms and spectrograms** (including the frequency axis) automatically
- Tick channels across any files → reorder → **export as an N-channel WAV** (16/24/32-bit PCM or 32-bit float)

## Requirements
- Node.js (installed: v24.x) and npm

## Run
```powershell
npm install      # first time only
npm start
```

## Try it with sample data
```powershell
node tools/gen-test-pcm.js   # writes 4 test PCMs into ./samples (16-bit LE, 48000 Hz)
```
Open them in the app with Format = `16-bit signed LE`, Sample rate = `48000`.
Use `stereo_interleaved.s16le.pcm` with Channels = `2` to see deinterleaving.

## App icon
The icon is generated procedurally (no external tools) into `build/icon.ico`
(+ `build/icon.png`). Regenerate after editing `tools/gen-icon.js`:
```powershell
npm run icon
```

## Build a Windows installer
```powershell
npm run dist     # electron-builder → NSIS installer under ./dist (uses build/icon.ico)
```

## Tests
```powershell
node tools/test.mjs            # logic unit tests (PCM parse, WAV encode, FFT)
npx electron tools/smoke-electron.js   # renderer load smoke test
```

## Project layout
| Path | Purpose |
|------|---------|
| `main.js` | Electron main process, file dialogs & IO over IPC |
| `preload.js` | Exposes safe `window.api` to the renderer |
| `renderer/pcm.js` | Format table + raw-PCM → Float32 channel parsing |
| `renderer/fft.js` | Radix-2 FFT + Hann window |
| `renderer/spectrogram.js` | STFT spectrogram image |
| `renderer/waveform.js` | Waveform + cursor canvas rendering |
| `renderer/player.js` | Web Audio playback |
| `renderer/wav.js` | WAV encoder |
| `renderer/app.js` | UI + application logic |
| `tools/` | Test data generator and tests |

## Notes / limitations
- Export does **not** resample. If selected channels have different sample rates,
  the app warns and writes at the chosen rate.
- If selected channels differ in **length**, a confirmation dialog appears before
  saving; on confirm, shorter channels are padded with trailing silence to the
  longest channel. Cancel aborts the export.
