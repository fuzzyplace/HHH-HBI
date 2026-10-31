# HHH-HBI Plan

## Goal
Muse 2 → real-time cyberpunk visuals + reactive audio. User meditates art into existence on a persistent canvas; capture snapshots.

## Muse 2 inputs → mappings
| Input | Derived | Visual | Audio |
|---|---|---|---|
| EEG delta 1–4Hz | rel. power | deep violet nebula glow, radius | sub drone A1 (55Hz) sine |
| EEG theta 4–8Hz | rel. power | magenta flowing ribbons | triangle 165Hz, slow filter sweep |
| EEG alpha 8–13Hz | rel. power | cyan concentric rings (calm) | sine pair 220/330Hz, reverb send up |
| EEG beta 13–30Hz | rel. power | amber glitch/scanlines | filtered saw 440Hz, cutoff ↑ |
| EEG gamma 30–44Hz | rel. power | white spark particles | high sine 880Hz w/ tremolo |
| 4 channels TP9/AF7/AF8/TP10 | per-ch dominant band | four lobe nodes, hue = dominant band | L/R pan from left–right asymmetry |
| PPG | BPM + beats | ring pulse on beat | soft kick on beat |
| Accelerometer | head tilt | parallax offset of field | filter tilt |
| Gyroscope | angular rate | field rotation | — |
| Blink / jaw clench (AF7/AF8 spike) | event | chromatic flash + glitch | noise burst |
| Battery | % | HUD | — |
Canvas uses alpha trails so the piece accumulates; Snapshot = PNG download.

## Visual stack (v0.2)
three.js r187 WebGPURenderer + TSL (auto WebGL2 fallback): GPU compute particles (262k WebGPU / 65k WebGL) in curl-ish noise flow + 4 electrode attractors → ping-pong feedback buffer (painting memory, max-blend, zoom/rotate/smear, glitch row-tear) → bloom → RGB shift → scanlines/vignette/grain. EEG-driven data-rain glyph layer. Hydra-synth glitch mode (G). Adaptive resolution when frames >24ms.

| Input | GPU visual |
|---|---|
| delta | particle size, feedback zoom |
| theta | noise frequency, feedback smear |
| alpha | damping (laminar flow), trail length, calm palette (cyan→violet) |
| beta | turbulence, glitch row-tear, RGB split |
| gamma | sparks/bloom strength, data-rain density |
| 4 channels | attractor strengths at TP9/AF7/AF8/TP10 positions |
| PPG beat | radial pressure pulse |
| blink/clench | cyan flash + RGB spike + glitch burst |
| accel / gyro | camera drift / field rotation |

## Phases
1. **Scaffold (done)**  — Vite app, simulated source, band DSP, canvas scene, synth, snapshot, HUD.
2. **Hardware (ready to test — see docs/HARDWARE.md)** — muse-js connect, real PPG/motion, reconnect, battery, signal-quality (ble-integrator).
3. **Signal quality** — artifact rejection, per-user baseline calibration (30s eyes-closed), adaptive normalization (dsp-engineer).
4. **Art depth** — WebGL/shader layer, palette themes, brush modes, session recording to video/GIF (visual-artist).
5. **Sound depth** — scales/modes, binaural option, granular textures, generative melody from alpha/theta (audio-designer).
6. **Polish & share** — snapshot gallery, session export (JSON + PNG), install as PWA, H.H.H. branding (qa-reviewer + all).

## Agent ownership
- dsp-engineer: `src/dsp/`
- visual-artist: `src/visuals/`, `src/style.css`, `index.html`
- audio-designer: `src/audio/`
- ble-integrator: `src/input/muse.js`
- qa-reviewer: read-only review + tests across repo

## Assumptions (correct me)
- Web app via Chrome Web Bluetooth (not native/Electron). Fallback later: Mind Monitor OSC bridge.
- Muse 2 only (not Muse S / Athena).
- Plain JS, no framework, Canvas2D first; WebGL in phase 4.
- Relative band power with adaptive min/max normalization is "good enough" until calibration lands.
- Local-only, no data leaves the browser.
