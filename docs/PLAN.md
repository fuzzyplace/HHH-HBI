# HHH-HBI Plan

## Goal
Muse 2 → real-time cyberpunk visuals + reactive audio. User meditates art into existence on a persistent canvas; capture snapshots.

## Muse 2 inputs → mappings (v0.5)
What each signal is and how far to trust it: `docs/SIGNALS.md`. Design rule: **artful monitoring of real data** — organic fluid ink delivered by cyborg machinery. Nothing moves, paints or sounds on its own.

| Input | Derived (src/dsp/pipeline.js, main.js) | Visual (INK: ink.js + arms.js) | Audio (synth.js) |
|---|---|---|---|
| **Readiness gate** (main.js) | `idle` no EEG for 1.5s · `contact` <3 sensors good/noisy · `uncalibrated` no calibration this source session (Enter reuses saved baseline) · `live` | before live: water still, arms dormant showing status lights only; every view frozen | band chord silent until live (fade τ1.5s); no thump |
| **4 EEG sensors** TP9 / AF7 / AF8 / TP10 | per-channel band levels `ch[i]`, quality label + score, artifact `held[i]` | each sensor = an injector arm at its real head position (top-down, nose up); 5 band-coloured dye streams per site, amount ∝ ch[i][band] × quality score; none on no contact / railed / held | — |
| Contact quality | good / noisy / no contact / railed / off | arm status light: green / amber / red slow blink / red / off; dock sensor map same colours | — |
| **Bands** δ θ α β γ | smoothed rel. power 0..1 | dye colour δ violet, θ magenta, α cyan, β amber, γ white | binaural pair per band (L carrier, R carrier+beat): δ C3 +2Hz, θ G3 +6Hz, α C4 +10Hz, β E4 +18Hz, γ G4 +40Hz; gain 0.01+0.11·level^1.3 (τ1s); δ/θ octave layer for speakers |
| **relax** = α − (β+γ) dB, ear pair | 0..1 (calibrated: open≈0.2, closed≈0.9) | higher viscosity, softer slower diffusion | reverb wet 0.12+0.28·r |
| **focus** = β − θ dB, forehead pair | 0..1 (calibrated: closed≈0, open≈0.5) | stronger vorticity → finer curls | octave layer 0.2+0.25·f (brighter) |
| **Heartbeat** (PPG 3ch → autocorrelation + phase-locked clock; pulses only at lock ≥0.25) | `beat` events, `beatPhase`, `beatConf`, bpm | **the only thing that moves the water**: radial velocity pulse from the forehead PPG site ∝ conf; dye burst per beat; arms plunge/dose; pump arm light pulses red. No lock → no motion (no default pace) | lub-dub thump ∝ conf, chord ducks ~3.5dB per beat |
| **Gyroscope** | yaw / pitch / roll rate | gentle body force: current follows head; roll → slow rotation (smoothed, capped) | — |
| Head tilt (accel) | tilt x/y | SPRAY aim / PAINT emitter aim | — |
| Blink / clench / motion artifact | events, 800ms refractory; holds (blink: forehead pair, clench/motion: all) | the held sensor's arm glitches (RGB-split ghosts, jitter, scanlines, stuttering light) and its ink pauses; motion glitches all arms; blink → small disturbance at forehead sites | band-passed noise burst |
| Battery | % | dock | — |

(Removed in v0.5: left/right asymmetry → stereo pan — it would smear the binaural pairs.)

Calibration cues: one soft tone at step 1→2, two rising tones at the end (audio on).

### Signal pipeline (v0.4, `src/dsp/pipeline.js`)
- `push/pushPpg/pushMotion` in, `tick()` @20Hz out (one reused result object, incl. `relax`, `focus`, `relaxDb`, `focusDb`, `dB`, `psd`, `held`).
- Quality: σ, 50/60Hz ratio, railing → good / noisy / no contact / railed; unusable channels excluded.
- Band power tracked in dB, smoothed τ≈2s; outputs eased τ≈0.8s. No auto-stretch: pre-calibration indices use fixed spans (relax 8dB, focus 6dB) around a 60s-slow centre.
- Two-step calibration (10s eyes open + 10s eyes closed, clean seconds, 2s settle each) anchors the indices; reports eyes-closed alpha gain (≥3dB strong). Stored as `hbi.calibration.v2`.
- Signal Lab (L): spectrum, 30s index history with artifact markers, per-channel quality.

## Views (V cycles; last choice remembered per browser; all gated by readiness)
- **INK** (default) — WebGL2 stable-fluid "ink in water" with four cyborg injector arms (one per sensor) and a PPG pump arm; see table above.
- **SPRAY** — five band emitters spray 3D particles; motion only on beat surges, bursts per beat.
- **ORBS** — five band orbs; swirl only on beat surges.
- **PAINT** — the original feedback-particle painting; beat-stepped zoom; glitch synth (G) layers over it only.

UI: one bottom-centre dock (status, steps, sensor map, band key, relax/focus, controls). H hides it for immersive mode. M mutes; sound starts on the first click/key.

## Guided sessions + playback (`src/session/`)
- **Begin session (R)** (only when Live; length 1/3/5/10 min): eyes open 30s → eyes closed N min → eyes open 30s. A falling 5…1 countdown (one tone per second, G-A-C-D-E pentatonic descending) leads into eyes closed; a low bell marks it. In the last 5s of eyes closed, rising tones count 1…5, then a two-note chime means open your eyes. Banner top-centre (dims while eyes are closed); Esc ends early.
- **Recording**: the derived `state` stream (bands, per-channel bands/quality/holds, relax, focus, heart, tilt/gyro, readiness, eyes-open/closed phase, alpha dB) at 20Hz + beat/blink events. No raw samples, no device IDs. Saved in this browser only (IndexedDB `hbi/sessions`, newest 8); **Export** downloads JSON on click.
- **Summary** after a session: eyes-closed vs eyes-open relax, alpha dB difference, heart rate (live seconds only).
- **Play back (P)**: the recording drives the current view and the sound exactly as live (beats, artifacts, arm lights); replay bar shows progress with open/closed markers. Esc/P stops.

## Visual stack
three.js r187 WebGPURenderer + TSL (auto WebGL2 fallback): GPU compute particles in curl-ish noise flow, respawning at the tilt-aimed emitter + 4 electrode attractors → ping-pong feedback buffer (painting memory, zoom/rotate/smear, glitch row-tear) → bloom → RGB shift → scanlines/vignette/grain. Data-rain glyph layer. Hydra glitch mode (G) reads relax/focus. 2D fallback (scene.js) follows the same mapping in simplified form.

## Phases
1. **Scaffold (done)**  — Vite app, simulated source, band DSP, canvas scene, synth, snapshot, HUD.
2. **Hardware (code done, awaiting real-headband test — see docs/HARDWARE.md)** — chooser/timeout/cancel errors, auto-reconnect w/ backoff (5 tries) without reopening chooser, SIM keeps running until Muse streams, fallback to SIM on give-up, battery, device name in HUD (ble-integrator).
3. **Signal quality (done)** — artifact rejection, per-channel quality.
3c. **Heart + calm views (done — awaiting real-headband check)** — PPG on all 3 channels (was ambient-only), autocorrelation heart tracker + beat clock pacing everything, audible thump, SPRAY + ORBS views.
3d. **INK + binaural (done — awaiting real-headband check)** — readiness gate, fluid ink view with cyborg injector arms, binaural band chord on by default + mute, bottom dock, beat-only motion everywhere.
3e. **Sessions + depth (done — awaiting real-headband check)** — guided open/closed session with countdown tones, recording + playback + export, INK colour/depth, PAINT impasto.
3b. **Signal truth (done)** — dB smoothing, relax/focus indices, two-step calibration, Signal Lab (L), docs/SIGNALS.md, heartbeat motion + thump.
4. **Art depth** — WebGL/shader layer, palette themes, brush modes, session recording to video/GIF (visual-artist).
5. **Sound depth** — scales/modes, granular textures, generative melody from alpha/theta (audio-designer).
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
