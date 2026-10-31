const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

export class Synth {
  ctx = null;
  async start() {
    if (this.ctx) return;
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain(); this.master.gain.value = 0;
    this.master.gain.setTargetAtTime(0.35, ctx.currentTime, 1.5);
    this.pan = ctx.createStereoPanner();
    this.comp = ctx.createDynamicsCompressor();
    // gentle bus limiter: keeps drone + heartbeat thump from clipping into master
    this.comp.threshold.value = -14; this.comp.knee.value = 18;
    this.comp.ratio.value = 4; this.comp.attack.value = 0.004; this.comp.release.value = 0.2;
    this.dry = ctx.createGain(); this.wet = ctx.createGain(); this.wet.gain.value = 0.3;
    this.verb = ctx.createConvolver(); this.verb.buffer = this.impulse(3.2);
    this.bus = ctx.createGain();
    this.bus.connect(this.dry).connect(this.pan);
    this.bus.connect(this.verb).connect(this.wet).connect(this.pan);
    this.pan.connect(this.comp).connect(this.master).connect(ctx.destination);
    // drone sub-bus: all sustained voices feed this, so a beat can sidechain-duck the
    // drone bed (droneBus.gain dip) WITHOUT touching the heartbeat thump, which taps
    // this.bus directly. droneBus.gain is the duck target (1 = nominal).
    this.droneBus = ctx.createGain(); this.droneBus.gain.value = 1;
    this.droneBus.connect(this.bus);

    this.voices = {};
    const mk = (name, type, freq, filt) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
      const g = ctx.createGain(); g.gain.value = 0;
      let node = o;
      let f = null;
      if (filt) { f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filt; o.connect(f); node = f; }
      node.connect(g); g.connect(this.droneBus); o.start();
      this.voices[name] = { o, g, f };
      return { o, g, f };
    };
    mk('delta', 'sine', 55);
    mk('theta', 'triangle', 165, 900);
    mk('alpha', 'sine', 220); mk('alpha2', 'sine', 329.63);
    mk('beta', 'sawtooth', 440, 600);
    const gam = mk('gamma', 'sine', 880);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 6;
    const lg = ctx.createGain(); lg.gain.value = 0.02; lfo.connect(lg).connect(gam.g.gain); lfo.start();
    this.noiseBuf = this.noise(0.4);
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
    const b = s.bands, V = this.voices;
    this.set(V.theta.g.gain, 0.02 + 0.12 * b.theta, 0.4);
    this.set(V.theta.f.frequency, 400 + 1200 * b.theta, 0.4);
    this.set(V.alpha.g.gain, 0.02 + 0.14 * b.alpha, 0.4);
    this.set(V.alpha2.g.gain, 0.01 + 0.1 * b.alpha, 0.5);
    this.set(V.beta.g.gain, 0.005 + 0.045 * b.beta, 0.3);
    this.set(V.gamma.g.gain, 0.003 + 0.03 * b.gamma, 0.3);
    // relax/focus (0..1, may be undefined → neutral 0.5): modest shaping, heartbeat stays priority
    const relax = clamp(s.relax == null ? 0.5 : s.relax);
    const focus = clamp(s.focus == null ? 0.5 : s.focus);
    this.set(this.wet.gain, 0.2 + 0.5 * b.alpha + 0.15 * relax, 0.6);   // relax → wetter
    this.set(V.beta.f.frequency, 300 + 2500 * b.beta + 800 * clamp(s.tilt.y + 0.5) + 600 * focus, 0.3); // focus → brighter
    this.set(V.delta.g.gain, 0.05 + 0.35 * b.delta - 0.04 * relax, 0.4); // relax → softer drone
    this.set(this.pan.pan, clamp(s.asym * 2, -0.8, 0.8), 0.4);
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
