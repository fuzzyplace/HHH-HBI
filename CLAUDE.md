# HHH-HBI — Human Brain Interface

Real-time cyberpunk audio-visual instrument driven by Muse 2 EEG/PPG/motion. Browser app (Vite, vanilla JS, Canvas2D, WebAudio, Web Bluetooth via muse-js). Part of Hackers Healing Hackers (H.H.H.).

## Rules
- Every input has a simulated equivalent (`src/input/simulated.js`). App must run with zero hardware.
- Source interface: `on(evt, fn)`, `start()`, `stop()`. Events: `eeg{ch,samples}`, `ppg{ch,samples}`, `accel{x,y,z}`, `gyro{x,y,z}`, `battery(pct)`. Channels: 0=TP9 1=AF7 2=AF8 3=TP10.
- DSP outputs normalized 0..1 band values; visuals/audio consume only the `state` object built in `main.js`. No raw-sample access outside `src/dsp`.
- Never block the render loop. No allocations in per-frame hot paths where avoidable.
- Audio starts only after user gesture. Keep master gain ≤ 0.5; no sudden peaks (use setTargetAtTime).
- Wellness framing: this is an art/meditation tool, not a medical device. No diagnostic claims.
- Mapping table lives in `docs/PLAN.md`. Change mapping → update table.

## Commands
- `npm run dev` — dev server (Web Bluetooth needs Chrome/Edge on https or localhost)
- `npm run build` — production build

## Subagents (`.claude/agents/`)
dsp-engineer, visual-artist, audio-designer, ble-integrator, qa-reviewer. Delegate by file ownership; one agent per directory.
