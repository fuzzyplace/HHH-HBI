const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const MASTER = 0.35;   // never above 0.5
// band → [carrier Hz, binaural beat Hz, octave-layer gain]: a C-major chord, beats at each band's rhythm
const VOICES = {
  delta: [130.81, 2, 0.3], theta: [196.0, 6, 0.3], alpha: [261.63, 10, 0], beta: [329.63, 18, 0], gamma: [392.0, 40, 0],
};

export class Synth {
  ctx = null;
  muted = false;
  async start() {
    if (this.ctx) return;
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain(); this.master.gain.value = 0;
    this.master.gain.setTargetAtTime(this.muted ? 0 : MASTER, ctx.currentTime, 1.5);
    this.comp = ctx.createDynamicsCompressor();
    // gentle bus limiter: keeps the chord + heartbeat thump from clipping into master
    this.comp.threshold.value = -14; this.comp.knee.value = 18;
    this.comp.ratio.value = 4; this.comp.attack.value = 0.004; this.comp.release.value = 0.2;
    this.dry = ctx.createGain(); this.wet = ctx.createGain(); this.wet.gain.value = 0.2;
    this.verb = ctx.createConvolver(); this.verb.buffer = this.impulse(3.2);   // 2-ch IR: L→L, R→R, binaural kept
    this.bus = ctx.createGain();
    // no StereoPanner anywhere: it would smear the left/right binaural pairs
    this.bus.connect(this.dry).connect(this.comp);
    this.bus.connect(this.verb).connect(this.wet).connect(this.comp);
    this.comp.connect(this.master).connect(ctx.destination);
    // drone sub-bus: the band chord feeds this, so a beat can duck the chord (droneBus.gain dip)
    // WITHOUT touching the heartbeat thump, which taps this.bus directly.
    this.droneBus = ctx.createGain(); this.droneBus.gain.value = 1;
    this.droneBus.connect(this.bus);

    // one binaural pair per band: left ear = carrier, right ear = carrier + the band's beat rate
    this.voices = {};
    for (const [band, [hz, beat, oct]] of Object.entries(VOICES)) {
      const g = ctx.createGain(); g.gain.value = 0;
      const merge = ctx.createChannelMerger(2);
      for (const [ch, f] of [[0, hz], [1, hz + beat]]) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        o.connect(merge, 0, ch); o.start();
      }
      merge.connect(g);
      let og = null;
      if (oct) {   // quiet octave layer (both ears) so laptop speakers can hear the low voices
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = hz * 2;
        og = ctx.createGain(); og.gain.value = oct; o.connect(og).connect(g); o.start();
      }
      g.connect(this.droneBus);
      this.voices[band] = { g, og };
    }
    this.noiseBuf = this.noise(0.4);
  }
  setMuted(m) {
    this.muted = !!m;
    if (this.ctx) this.set(this.master.gain, this.muted ? 0 : MASTER, 0.3);
  }
  impulse(sec) {
    const ctx = this.ctx, n = ctx.sampleRate * sec, b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.5); }
    return b;
  }
  noise(sec) {
    const ctx = this.ctx, n = ctx.sampleRate * sec, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  set(p, v, tc = 0.25) { p.setTargetAtTime(v, this.ctx.currentTime, tc); }
  update(s) {
    if (!this.ctx) return;
    const live = s.ready === 'live', b = s.bands, V = this.voices;
    // your brain plays the chord: each band's voice follows its level, only once synced
    for (const band in V) this.set(V[band].g.gain, live ? 0.01 + 0.11 * Math.pow(clamp(b[band]), 1.3) : 0, live ? 1 : 1.5);
    const relax = clamp(s.relax == null ? 0.5 : s.relax);
    const focus = clamp(s.focus == null ? 0.5 : s.focus);
    this.set(this.wet.gain, 0.12 + 0.28 * relax, 1);                      // relax → wetter (capped: dry stays dominant)
    for (const band of ['delta', 'theta']) this.set(V[band].og.gain, 0.2 + 0.25 * focus, 1);   // focus → brighter
  }
  // one heartbeat pulse at time t0, scaled by amp. Three layers so it reads on BOTH
  // tiny laptop/phone speakers and headphones:
  //   1. sub body (~55→48Hz sine)  — felt weight on headphones/subs
  //   2. mid body (~140→70Hz tri + soft 2nd harmonic) — the audible "thump" on laptops,
  //      which reproduce almost nothing below ~150Hz
  //   3. transient click (~1.5kHz bandpass noise, ~3ms) — attack definition, low level
  // All envelopes ramp (no hard onset); every node is stopped + disconnected via onended.
  thump(t0, amp) {
    const ctx = this.ctx, bus = this.bus;
    // 1. sub body: sine pitch-drop ~55 → 48 Hz
    const sub = ctx.createOscillator(), sg = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(55, t0); sub.frequency.exponentialRampToValueAtTime(48, t0 + 0.08);
    sg.gain.setValueAtTime(0, t0);
    sg.gain.linearRampToValueAtTime(0.26 * amp, t0 + 0.006);        // ~6ms attack
    sg.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.22);        // ~220ms decay
    sub.connect(sg).connect(bus); sub.start(t0); sub.stop(t0 + 0.25);
    sub.onended = () => sg.disconnect();
    // 2a. mid body: triangle pitch-drop ~140 → 70 Hz — carries the thump on laptop speakers
    const mid = ctx.createOscillator(), mg = ctx.createGain();
    mid.type = 'triangle';
    mid.frequency.setValueAtTime(140, t0); mid.frequency.exponentialRampToValueAtTime(70, t0 + 0.07);
    mg.gain.setValueAtTime(0, t0);
    mg.gain.linearRampToValueAtTime(0.22 * amp, t0 + 0.005);
    mg.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.17);        // ~170ms decay
    mid.connect(mg).connect(bus); mid.start(t0); mid.stop(t0 + 0.2);
    mid.onended = () => mg.disconnect();
    // 2b. soft 2nd harmonic (~280 → 140 Hz) — adds presence without harshness
    const h2 = ctx.createOscillator(), hg = ctx.createGain();
    h2.type = 'sine';
    h2.frequency.setValueAtTime(280, t0); h2.frequency.exponentialRampToValueAtTime(140, t0 + 0.07);
    hg.gain.setValueAtTime(0, t0);
    hg.gain.linearRampToValueAtTime(0.08 * amp, t0 + 0.005);
    hg.gain.exponentialRampToValueAtTime(0.0006, t0 + 0.11);        // ~110ms decay
    h2.connect(hg).connect(bus); h2.start(t0); h2.stop(t0 + 0.14);
    h2.onended = () => hg.disconnect();
    // 3. transient click: short bandpassed-noise around 1.5kHz for attack definition
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), kg = ctx.createGain();
    src.buffer = this.noiseBuf; f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = 1.0;
    kg.gain.setValueAtTime(0, t0);
    kg.gain.linearRampToValueAtTime(0.05 * amp, t0 + 0.0015);       // ~1.5ms attack
    kg.gain.exponentialRampToValueAtTime(0.0004, t0 + 0.028);       // ~26ms decay → ~3ms perceived click
    src.connect(f).connect(kg).connect(bus); src.start(t0); src.stop(t0 + 0.05);
    src.onended = () => { f.disconnect(); kg.disconnect(); };
  }
  // briefly duck the drone bed so the heartbeat cuts through (sidechain feel): ~3.5dB dip
  // for ~150ms, all via setTargetAtTime. Only touches droneBus — never the thump.
  duck(t0) {
    const g = this.droneBus.gain;
    g.cancelScheduledValues(t0);
    g.setTargetAtTime(0.66, t0, 0.02);           // dip ~3.5dB, fast
    g.setTargetAtTime(1.0, t0 + 0.15, 0.08);     // recover over ~150ms+
  }
  beat(strength = 1) {
    if (!this.ctx) return;
    const amp = clamp(strength);
    if (amp <= 0) return;                         // strength 0 → play nothing
    const t = this.ctx.currentTime;
    this.duck(t);                                 // sidechain the drone once per beat
    this.thump(t, amp);                           // lub (full)
    this.thump(t + 0.13, amp * 0.6);              // dub (~0.6×, +130ms)
  }
  /** soft sine bell for eyes-closed guidance (calibration step changes); n tones, rising */
  cue(n = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    for (let i = 0; i < n; i++) {
      const t = ctx.currentTime + i * 0.22, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 660 * (1 + i * 0.25);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.06, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      o.connect(g).connect(this.bus); o.start(t); o.stop(t + 0.55);
      o.onended = () => g.disconnect();
    }
  }
  blink() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noiseBuf; f.type = 'bandpass'; f.frequency.value = 3000; f.Q.value = 4;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.08, t + 0.005);   // ~5ms ramp, no hard onset
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    src.connect(f).connect(g).connect(this.bus); src.start(t); src.stop(t + 0.4);
    src.onended = () => { f.disconnect(); g.disconnect(); };
  }
}
