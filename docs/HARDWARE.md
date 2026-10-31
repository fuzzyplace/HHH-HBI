# Muse 2 — Live Testing

Connection uses **muse-js** (github.com/urish/muse-js, open source, Web Bluetooth). Our `src/input/muse.js` is only an adapter: muse-js observables → app events. No custom BLE code.

## Pairing / setup
1. Chrome or Edge (desktop) on `http://localhost:5173` or https. Not Firefox/Safari.
2. **Do NOT pair the Muse in macOS System Settings → Bluetooth.** Web Bluetooth connects directly; an OS-level pairing can hold the link and hide the device from Chrome. If you already paired it there, choose "Forget This Device".
3. Close the Muse phone app / Mind Monitor (or turn phone Bluetooth off) — Muse 2 accepts one BLE connection.
4. macOS: System Settings → Privacy & Security → Bluetooth → allow Chrome/Edge.
5. `cd ~/HHH-HBI && npm install && npm run dev` → open http://localhost:5173
6. Power Muse on (lights pulsing = advertising). Click **Connect Muse 2** → pick `Muse-XXXX` in the Chrome chooser → Pair. PPG (heart) is enabled automatically.

## Connection behaviour
- Connect has a 15s timeout once a device is chosen (time spent in the chooser does not count).
- **Auto-reconnect:** if the link drops unexpectedly, the app reconnects to the same device without reopening the chooser. Backoff 1s, 2s, 4s, 8s, 8s — max 5 attempts. Visuals keep running on the last values meanwhile.
- After 5 failed attempts the source emits `disconnect` and the app falls back to SIM. Click **Connect Muse 2** to start again.
- Clicking away / switching to SIM stops the Muse source and cancels any pending reconnect.
- The device name (`Muse-XXXX`) is shown for UI only; device IDs/addresses are never logged or stored.

## Error messages
| Message | Fix |
|---|---|
| Web Bluetooth unavailable — use Chrome or Edge on localhost/https | Wrong browser, or page opened via a LAN IP over http. Use Chrome/Edge on localhost or https. |
| No device selected | Chooser was cancelled, or no Muse showed up. Power-cycle the Muse, close the phone app, retry. |
| Bluetooth is off or unavailable — turn Bluetooth on and retry | Turn on Mac Bluetooth; check Chrome has Bluetooth permission (setup step 4). |
| Bluetooth blocked — click Connect directly, on localhost/https | Chooser must come from a click on a secure origin. |
| Muse connection timed out | Muse found but GATT never finished. Power-cycle Muse (hold button until off, then on), move closer, retry. |
| Muse disconnected — back to SIM | Reconnect gave up. Check battery/range, then Connect again. |

## Troubleshooting
- `chrome://bluetooth-internals` → Devices: confirm the Muse is advertising and whether something else holds the connection; "Forget" stale entries.
- Muse not in the chooser: close the Muse/Mind Monitor app on every phone/tablet, un-pair from macOS Bluetooth settings, power-cycle the headband.
- Frequent drops: low battery (HUD 🔋), distance > ~3m, or USB 3 / Wi-Fi 2.4GHz interference near the Mac.
- Flat or noisy signal: see contact dots below — fit and skin contact matter more than anything in software.

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
- Auto-reconnect covers short drops (5 attempts); after that, fallback to SIM and reconnect manually.
- Fallback option if Web Bluetooth is flaky: BrainFlow (maintained, `MUSE_2_BOARD`) via a local Node→WebSocket bridge.
