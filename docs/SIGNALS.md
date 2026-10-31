# What HBI actually measures

HBI is an art and meditation instrument, not a medical or diagnostic device. This page says plainly what the Muse 2 picks up, how much each reading can be trusted, and how it becomes sound and image — so you can check it against your own experience.

## The sensors

| Sensor | Where | Rate | What it really picks up |
|---|---|---|---|
| EEG TP9 / TP10 | behind the ears | 256 Hz | brain rhythm (best for **alpha**), plus jaw/temple muscle |
| EEG AF7 / AF8 | forehead | 256 Hz | brain rhythm, plus **eye movement and blinks** (very large) and brow muscle |
| PPG | forehead | 64 Hz | blood-volume pulse → **heartbeat** |
| Accelerometer | headband | ~52 Hz | head tilt (gravity direction) |
| Gyroscope | headband | ~52 Hz | head turning speed |

EEG at the scalp is tiny (roughly 5–50 µV). Muscle and eye signals are often 10× bigger, so a lot of the work is telling them apart.

## How reliable each reading is

| Reading | Reliability | Why |
|---|---|---|
| **Heartbeat** (PPG) | high when still | a regular optical pulse; motion and a loose fit weaken it |
| **Blink** | high | eye blinks are huge on the forehead sensors |
| **Jaw clench** | high | muscle floods 30–44 Hz on the ear sensors |
| **Head tilt / turn** | high | direct motion sensors |
| **Relax** — alpha rising with eyes closed / calm | **medium–high** | the most robust brain effect a consumer headband can see; usually 3–10 dB, clearest behind the ears |
| **Focus** — beta vs theta | **low–medium** | real but small; easily confused with brow and jaw tension. Treat it as "activation", not "thinking hard" |
| Individual bands (delta…gamma) | low | single-band power moves a lot moment to moment; gamma on a Muse is mostly muscle |

What this means in practice: **closing your eyes and settling is the one brain change you should clearly see.** Blinks, clenches, heartbeats and head movement respond instantly. "Concentrating" moves Focus only a little and slowly, and tensing your face moves it more.

## The heartbeat

The Muse 2 shines light into your forehead and measures how much comes back (PPG). It reports three channels: **ambient** (room light — no pulse), **infrared** and **red**. The pulse is a tiny ripple on a large raw level and may point up or down.

1. Each channel is high-passed (removes the slow level) and low-passed (~5 Hz) to leave the pulse shape.
2. **Autocorrelation** over the last 8 s finds the period at which the shape repeats. A true heartbeat also repeats at twice that period; the second bump inside each beat doesn't, so it can't double the rate. Room light and noise don't repeat, so they score low.
3. The channel that repeats most strongly is used; its sharpest edge times each beat.
4. A **beat clock** runs at that rate and is nudged toward each detected beat, so the pace stays steady through a missed beat or a brief movement. Lock confidence (shown on hover over ♥) comes from how strongly the pulse repeats; below 25% there's no thump and the views fall back to a slow breathing pace.

Expect the lock within ~6–10 s of sitting still with the headband snug on your forehead. Talking, chewing and moving weaken it.

## From raw signal to the two indices

1. **Spectrum** — each channel's last 1 s (256 samples) is windowed and FFT'd 10× per second.
2. **Quality** per channel: signal size (σ), 50/60 Hz mains hum, and saturation. Labels: good / noisy / no contact / railed. Channels that aren't usable are left out.
3. **Artifacts**
   - blink (forehead spike) → pauses only the forehead pair for 1 s; the ear pair keeps flowing;
   - clench (30–44 Hz burst on the ear pair) or fast head motion → pauses all channels for 1 s;
   - each blink/clench also fires a flash + noise burst.
4. **Band power in dB**, smoothed over ~2 s. A single 1 s window is mostly noise; this smoothing is what stops the bars jumping randomly.
5. **Indices** (in dB):
   - **Relax** = alpha − (beta + gamma), from the ear pair (falls back to any good channel).
   - **Focus** = beta − theta, from the forehead pair.
6. **Scaling to 0..1** — nothing is auto-stretched (stretching is what made noise look like activity):
   - before calibration: a fixed span around your slowly-moving average (Relax ±4 dB, Focus ±3 dB);
   - after calibration: anchored to your own eyes-open and eyes-closed levels (below).

Response time: Relax/Focus need **~2–4 s** to move. That's the price of not being noise. Instant feedback comes from blink, clench, heartbeat and head tilt.

## Calibration (C) — ~25 s

| Step | You do | It learns |
|---|---|---|
| 1 · eyes open (10 s clean) | look softly at one point, stay still | your "busy" level |
| 2 · eyes closed (10 s clean) | close your eyes, relax — two rising tones mean done | your "calm" level |

Each step ignores its first 2 s and pauses on blinks/movement. Afterwards:
- **Relax**: eyes open ≈ 0.2, eyes closed ≈ 0.9.
- **Focus**: eyes closed ≈ 0, eyes open ≈ 0.5, more activated → toward 1.
- It reports **eyes-closed alpha gain**: ≥ 3 dB = clear signal, 1–3 dB = weak (improve ear-sensor contact), < 1 dB = not detected (check fit and recalibrate).

The calibration is stored only in this browser (`hbi.calibration.v2`: four dB numbers, the alpha gain and a timestamp — no device ID).

## Verify it yourself — Signal Lab (L)

The Signal Lab shows the averaged spectrum (1–45 Hz), the last 30 s of Relax and Focus with blink/clench markers, the raw index values in dB and per-channel quality.

1. Sit still with eyes open for 15 s. Note the curve around 8–12 Hz.
2. Close your eyes for 15 s. **The 8–12 Hz bump should rise and Relax climb.** If it doesn't, the headband isn't reading brain rhythm well — fix contact behind the ears (a little water helps, move hair) before trusting anything else.
3. Clench your jaw: the right end of the spectrum lifts and a magenta marker appears.
4. Blink: a cyan marker appears; Relax should not jump.

## How it becomes art

- **Relax → colour and calm**: palette (cool cyan/violet when calm, hot amber/magenta when not), longer trails, smoother flow.
- **Focus → energy**: turbulence, glitch, RGB split, sparks.
- **Heartbeat → pace**: the heart clock sets how fast every view moves, and each beat is a surge (burst of spray, swirl of orbs, push forward in PAINT) with a thump you can hear when audio is on.
- **Views**: SPRAY (band generators spraying particles), ORBS (swirling band orbs), PAINT (the original, busiest). Press V to switch.
- **Head tilt → where the paint goes**: new paint is emitted where your head points.
- Bands and per-channel values only add small texture.

Full mapping table: `docs/PLAN.md`.
