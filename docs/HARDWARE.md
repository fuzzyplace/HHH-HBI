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

## Check it's working (dock)
- Status reads `MUSE 2`; the step line walks connect → fit → calibrate → **Live**, and the bright button always shows the next step. The screen stays dark and still until Live — that's intended.
- Stream line (open ⋯): **EEG ≈256Hz · PPG ≈64Hz · IMU ≈17/s** (IMU counts packets). 0 = not streaming. `· artifact hold` appears for ~1s after a blink/clench/movement.
- Sensor map TP9 / AF7 / AF8 / TP10: green good, amber noisy, red no contact or railed, magenta = artifact hold. The matching injector arm lights show the same.
- Fix red/amber: wet forehead + behind-ear sensors slightly, move hair, sit still ~20s.
- Use **headphones** for the binaural effect. Sound starts on your first click/key; M mutes.

## Test script (~10 min)
Open DevTools console first. Run `hbiDiag()` after each block and paste the output back — it counts events since you connected (signal stats only, no device IDs).

| # | Do | Expect |
|---|---|---|
| 1 | Connect, sit still 60s eyes open | all 4 dots green; EEG ≈256Hz; `rejectedPct` roughly 20–40% (each natural blink holds ~1s — tell me if it feels frozen); blink count ≈ your natural blinks |
| 2 | Blink hard ×5, ~3s apart | +5 blinks (one per blink), flash + noise burst each |
| 3 | Clench jaw ×3, 1s each, ~3s apart | +3 clench, few/no extra blinks |
| 4 | Hold a clench 6s | 1 clench, then visuals resume after ~3–4s (sustained level becomes the new normal) |
| 5 | Nod / turn head quickly ×3 | `artifact hold` flickers; no blink/clench storm |
| 6 | Lift one ear sensor off for 10s, then reseat | that dot goes red/amber; at most 1 event; visuals keep moving on the other channels; recovers after reseat |
| 7 | Click once (sound starts), press C: step 1 eyes open (look at one point), step 2 eyes closed until two rising tones | ~25s total; message reports eyes-closed alpha gain — **paste it to me** (≥3 dB = clear) |
| 8 | Press L (Signal Lab). Eyes open 15s, then closed 15s | 8–12Hz bump rises and RELAX climbs with eyes closed; FOCUS drops |
| 9 | Sit still 30s, audio on, headband snug on forehead | ♥ shows a number within ~10s (hover: lock % and channel); a thump per beat; the view surges in time — compare with your pulse at the wrist |
| 9b | In INK (default), watch while live | each arm injects its own colours; lift one ear sensor → that arm goes red and its ink stops; blink → forehead arms glitch; nothing moves between heartbeats except drift |
| 9c | Press V through SPRAY → ORBS → PAINT | dominant band dominates SPRAY/ORBS; motion only on heartbeats |
| 9d | Once Live: pick 1 min, press R. Follow the tones (eyes closed after the 5…1 countdown, open at the chime) | summary shows relax higher and alpha + dB with eyes closed — **paste it to me**; P replays it with ink + sound |
| 9e | Press J (PLAY), turn head left/right, nod, blink, clench | stylus arm follows your head (tell me if left/right or up/down is reversed); blink drops ink; clench ripples. In playback (P) head turn scrubs, nod pauses |
| 9f | Press B, breathe with the arms for 2 min | SYNC climbs after ~30s if your pulse is locked; gold bloom when it holds — **paste `hbiDiag()`** |
| 9g | Press N (GROOVE) with headphones | tempo follows your heart; kicks land on heartbeats; bands shape bass/hats/arps |
| 10 | Reload page | dark until fit is OK; step offers Enter to reuse the saved baseline |
| 11 | Tilt head left/right/up/down slowly | new paint appears toward where you tilt |

Optional visual checks: tilt/nod → camera drift; S → PNG snapshot; G → glitch-synth mode.

## Debug URL flags
- `?webgl` force WebGL2 backend · `?particles=65536` override count · `?debug=scene` raw particles, no feedback/post
- Console: `hbi` = scene, `sim` = simulator, `hbiDiag()` = signal/test readout

## Known gaps (next)
- Thresholds are simulator-tuned: blink `150µV / 1.6×`, clench `4×` 30–44Hz power, motion `45°/s` / `0.25g`, quality σ `1.5 / 60–150µV` — all in `src/dsp/pipeline.js`. Tune from `hbiDiag()` output.
- Each artifact holds bands for 1s (one FFT window); with natural blinking that's ~25–40% hold time. If visuals feel sticky, shorten the hold or only reject the frontal channels on blinks.
- Auto-reconnect covers short drops (5 attempts); after that, fallback to SIM and reconnect manually.
- Fallback option if Web Bluetooth is flaky: BrainFlow (maintained, `MUSE_2_BOARD`) via a local Node→WebSocket bridge.
