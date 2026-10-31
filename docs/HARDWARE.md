# Muse 2 — Live Testing

Connection uses **muse-js** (github.com/urish/muse-js, open source, Web Bluetooth). Our `src/input/muse.js` is only an adapter: muse-js observables → app events. No custom BLE code.

## Setup
1. Chrome or Edge on macOS (Web Bluetooth). Not Firefox/Safari.
2. Close the Muse mobile app / Mind Monitor — Muse allows one BLE connection.
3. `cd ~/HHH-HBI && npm install && npm run dev` → open http://localhost:5173
4. Power Muse on (lights pulsing). Click **Connect Muse 2** → pick `Muse-XXXX` in the Chrome dialog.
5. macOS: System Settings → Privacy & Security → Bluetooth → allow Chrome.

## Check it's working (HUD)
- Status reads `MUSE 2 · WebGPU` (or WebGL2).
- Stream line: **EEG ≈256Hz · PPG ≈64Hz · IMU ≈17/s** (IMU counts packets). 0 = not streaming.
- Contact dots TP9 / AF7 / AF8 / TP10: green good (σ 1.5–60µV), amber noisy, red no contact. Hover for σ.
- Fix red/amber: wet forehead + behind-ear sensors slightly, move hair, sit still ~20s.

## Test script (~5 min)
| Do | Expect |
|---|---|
| Sit still, eyes open | beta/gamma moderate, amber glitch rows, faster particles |
| Close eyes 30s, relax | alpha bar up, cyan/violet palette, longer trails, more reverb |
| Blink hard ×3 | cyan flash + RGB split + noise burst (adaptive threshold, 0.8s cooldown) |
| Clench jaw | gamma spike → sparks/bloom, possibly blink trigger |
| Tilt head L/R, nod | camera drift / field rotation |
| Breathe slowly | ♥ BPM from PPG; pink pulse per beat (heart readout may take ~10s) |
| Press S | PNG snapshot |
| Press G | glitch-synth (Hydra) mode |

## Debug URL flags
- `?webgl` force WebGL2 backend · `?particles=65536` override count · `?debug=scene` raw particles, no feedback/post
- Console: `hbi` = scene, `sim` = simulator

## Known gaps (next)
- No per-user calibration yet — normalization adapts over ~30–60s; ranges reset on connect.
- Blink threshold is heuristic; tune `1.6x` / `150µV` in `src/main.js` from real data.
- Disconnect → auto-fallback to SIM; reconnect manually.
- Fallback option if Web Bluetooth is flaky: BrainFlow (maintained, `MUSE_2_BOARD`) via a local Node→WebSocket bridge.
