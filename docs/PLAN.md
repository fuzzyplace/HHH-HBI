# HHH-HBI Plan

## Goal
Muse 2 → real-time cyberpunk visuals + reactive audio. User meditates art into existence on a persistent canvas; capture snapshots.

## Muse 2 inputs → mappings (v0.4)
What each signal is and how far to trust it: `docs/SIGNALS.md`. Primary drivers are the two indices plus the instant events; bands are secondary texture.

| Input | Derived (src/dsp/pipeline.js) | Visual (gpu.js) | Audio (synth.js) |
|---|---|---|---|
| **relax** = α − (β+γ) dB, ear pair, ~2s smoothing | 0..1 (calibrated: open≈0.2, closed≈0.9) | palette mood cyan/violet↔amber/magenta; drag 0.95+0.045·r; trail decay (0.84+0.14·r)^f60 | reverb wet +0.15·r, delta drone −0.04·r |
| **focus** = β − θ dB, forehead pair | 0..1 (calibrated: closed≈0, open≈0.5) | turbulence 0.5+2.6·f; glitch min(0.9, 0.5·f+flash·0.7); RGB shift +0.004·f; bloom 0.5+0.9·f | beta filter cutoff +600Hz·f |
| **Heartbeat** (PPG 3ch → autocorrelation period + phase-locked clock) | `beat` pulse events, `beatPhase` 0..1, `beatConf`, bpm | **paces every view**: PAINT forward drift ∝ bpm + surge per beat; SPRAY field speed ∝ bpm + burst per beat; ORBS swirl rate ∝ bpm + angular surge per beat; HUD ♥ pulses | lub-dub thump (sub 55Hz + audible 140→70Hz body + 280Hz harmonic + 1.5kHz click), drone ducks ~3.5dB per beat; level = beat confidence |
| **Head tilt** (accel) | tilt x/y, smoothed | paint emitter aim (tilt·2.3), camera x 1.2·tilt | beta filter tilt |
| Gyroscope | angular rate | subtle field rotation | — |
| Blink (AF7/AF8 p2p > max(150µV, 1.6× baseline)) | event, 800ms refractory; pauses forehead pair 1s | cyan flash + RGB spike + glitch burst | band-passed noise burst (5ms ramp) |
| Jaw clench (TP9/TP10 30–44Hz > 4× clean baseline) | event, 800ms refractory; pauses all channels 1s | same as blink | same as blink |
| delta / theta / gamma | smoothed rel. power, wide-span scaling | size 0.02+0.02·δ, zoom drift +0.004·δ; noise freq/smear ·θ; data-rain 0.05+0.2·γ | drone voices (small) |
| 4 channels | per-ch dominant band | attractor strengths 0.15+0.5·m | — |
| Battery | % | HUD | — |

Calibration cues: one soft tone at step 1→2, two rising tones at the end (audio on).

### Signal pipeline (v0.4, `src/dsp/pipeline.js`)
- `push/pushPpg/pushMotion` in, `tick()` @10Hz out (one reused result object, incl. `relax`, `focus`, `relaxDb`, `focusDb`, `dB`, `psd`, `held`).
- Quality: σ, 50/60Hz ratio, railing → good / noisy / no contact / railed; unusable channels excluded.
- Band power tracked in dB, smoothed τ≈2s; outputs eased τ≈0.8s. No auto-stretch: pre-calibration indices use fixed spans (relax 8dB, focus 6dB) around a 60s-slow centre.
- Two-step calibration (10s eyes open + 10s eyes closed, clean seconds, 2s settle each) anchors the indices; reports eyes-closed alpha gain (≥3dB strong). Stored as `hbi.calibration.v2`.
- Signal Lab (L): spectrum, 30s index history with artifact markers, per-channel quality.

## Views (V cycles; last choice remembered per browser)
- **SPRAY** (default) — five band emitters (δ violet, θ magenta, α cyan, β amber, γ white) spray 3D particles toward you. Emission ∝ band², relax → softer/longer-lived/wider, focus → faster/tighter, tilt aims the spray, each heartbeat = burst + forward surge, field drifts at heart pace.
- **ORBS** — five glowing band orbs swirl in 3D orbits with soft trails. Size/glow ∝ band, relax → wider/slower, focus → tighter/faster/brighter, tilt leans the orbital plane, each heartbeat = swirl surge + glow.
- **PAINT** — the original feedback-particle painting (busiest view); glitch synth (G) layers over it only.

## Visual stack
three.js r187 WebGPURenderer + TSL (auto WebGL2 fallback): GPU compute particles in curl-ish noise flow, respawning at the tilt-aimed emitter + 4 electrode attractors → ping-pong feedback buffer (painting memory, zoom/rotate/smear, glitch row-tear) → bloom → RGB shift → scanlines/vignette/grain. Data-rain glyph layer. Hydra glitch mode (G) reads relax/focus. 2D fallback (scene.js) follows the same mapping in simplified form.

## Phases
1. **Scaffold (done)**  — Vite app, simulated source, band DSP, canvas scene, synth, snapshot, HUD.
2. **Hardware (code done, awaiting real-headband test — see docs/HARDWARE.md)** — chooser/timeout/cancel errors, auto-reconnect w/ backoff (5 tries) without reopening chooser, SIM keeps running until Muse streams, fallback to SIM on give-up, battery, device name in HUD (ble-integrator).
3. **Signal quality (done)** — artifact rejection, per-channel quality.
3c. **Heart + calm views (done — awaiting real-headband check)** — PPG on all 3 channels (was ambient-only), autocorrelation heart tracker + beat clock pacing everything, audible thump, SPRAY + ORBS views.
3b. **Signal truth (done)** — dB smoothing, relax/focus indices, two-step calibration, Signal Lab (L), docs/SIGNALS.md, heartbeat motion + thump.
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
- Web app via Chrome Web Bluetooth (not native/Electron), deployed as a static site on Vercel. Fallback later: Mind Monitor OSC bridge.
- Muse 2 only (not Muse S / Athena).
- Plain JS, no framework, Canvas2D first; WebGL in phase 4.
- Relax/focus spans and artifact thresholds are tuned on the (now realistic) simulator and need real-headband tuning.
- Focus is "activation" (beta vs theta), not a measure of thinking; muscle tension moves it.
- Local-only, no data leaves the browser.
