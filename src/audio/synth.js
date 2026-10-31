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
    this.set(V.delta.g.gain, 0.05 + 0.35 * b.delta, 0.4);
    this.set(V.theta.g.gain, 0.02 + 0.12 * b.theta, 0.4);
    this.set(V.theta.f.frequency, 400 + 1200 * b.theta, 0.4);
    this.set(V.alpha.g.gain, 0.02 + 0.14 * b.alpha, 0.4);
    this.set(V.alpha2.g.gain, 0.01 + 0.1 * b.alpha, 0.5);
    this.set(V.beta.g.gain, 0.005 + 0.045 * b.beta, 0.3);
    this.set(V.beta.f.frequency, 300 + 2500 * b.beta + 800 * clamp(s.tilt.y + 0.5), 0.3);
    this.set(V.gamma.g.gain, 0.003 + 0.03 * b.gamma, 0.3);
    this.set(this.wet.gain, 0.2 + 0.5 * b.alpha, 0.6);
    this.set(this.pan.pan, clamp(s.asym * 2, -0.8, 0.8), 0.4);
  }
  beat() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g).connect(this.bus); o.start(t); o.stop(t + 0.3);
  }
  blink() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noiseBuf; f.type = 'bandpass'; f.frequency.value = 3000; f.Q.value = 4;
    g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    src.connect(f).connect(g).connect(this.bus); src.start(t); src.stop(t + 0.4);
  }
}
