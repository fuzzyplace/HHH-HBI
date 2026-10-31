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

    this.voices = {};
    const mk = (name, type, freq, filt) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
      const g = ctx.createGain(); g.gain.value = 0;
      let node = o;
      let f = null;
      if (filt) { f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filt; o.connect(f); node = f; }
      node.connect(g); g.connect(this.bus); o.start();
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
  // one heartbeat pulse at time t0, scaled by amp: deep body + soft low-mid knock
  thump(t0, amp) {
    const ctx = this.ctx;
    // deep warm body: triangle pitch-drop ~58 → 45 Hz
    const o = ctx.createOscillator(), bg = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(58, t0); o.frequency.exponentialRampToValueAtTime(45, t0 + 0.09);
    bg.gain.setValueAtTime(0, t0);
    bg.gain.linearRampToValueAtTime(0.30 * amp, t0 + 0.005);        // ~5ms attack
    bg.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.23);        // ~230ms decay
    o.connect(bg).connect(this.bus); o.start(t0); o.stop(t0 + 0.26);
    o.onended = () => bg.disconnect();
    // soft low-mid knock for definition on laptop speakers: lowpassed noise burst
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), kg = ctx.createGain();
    src.buffer = this.noiseBuf; f.type = 'lowpass'; f.frequency.value = 200; f.Q.value = 0.7;
    kg.gain.setValueAtTime(0, t0);
    kg.gain.linearRampToValueAtTime(0.11 * amp, t0 + 0.004);
    kg.gain.exponentialRampToValueAtTime(0.0006, t0 + 0.07);
    src.connect(f).connect(kg).connect(this.bus); src.start(t0); src.stop(t0 + 0.1);
    src.onended = () => { f.disconnect(); kg.disconnect(); };
  }
  beat() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.thump(t, 1.0);              // lub
    this.thump(t + 0.12, 0.55);      // softer dub (~120ms later)
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
