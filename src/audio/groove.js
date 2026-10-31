// GROOVE — deep, organic tech house generated from the user's signals.
// The heart sets the tempo: tempo = heart bpm × 1.5 or × 2 (whichever lands nearest 122), and each real
// heartbeat nudges the grid toward the nearest 8th note, so heartbeats fall on kicks / offbeats.
// Each band plays a part: delta → rolling bass, theta → pad, alpha → plucks, beta → open hats,
// gamma → 16th hats, focus → claps + brighter bass, relax → delay/reverb wet. Breath swells a noise wash;
// harmony resolves the harmony (root bass, bell plucks, shimmer pad). Nothing plays without a pulse lock.
// Lookahead scheduler on ctx.currentTime; every per-note node is stopped + disconnected onended.

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const PENT = [0, 2, 4, 7, 9];                       // C major pentatonic (sits on the C-major band chord)
const C2 = 65.41;
const hz = (base, semis) => base * Math.pow(2, semis / 12);
// bass: semitone offsets per 16th (null = rest) — off-beat roll with a little lift into the next bar
const BASS = [null, null, 0, 0, null, null, 0, 12, null, null, 0, 0, null, 7, 0, -3];
const PAD = [0, 4, 7, 11, 14];                      // Cmaj9 voicing (C E G B D)
const SHIMMER = [19, 23];                           // G + B an octave up (harmony)
const LOOK = 0.12, TICK_MS = 25;

export class Groove {
  constructor(synth) {
    const ctx = (this.ctx = synth.ctx);
    this.synth = synth;
    this.out = ctx.createGain(); this.out.gain.value = 0;
    this.out.connect(synth.bus);
    this.duck = ctx.createGain(); this.duck.connect(this.out);          // sidechained group: bass + pad
    // dotted-8th feedback delay for plucks
    this.dly = ctx.createDelay(2); this.fb = ctx.createGain(); this.fb.gain.value = 0.35;
    this.dlyWet = ctx.createGain(); this.dlyWet.gain.value = 0.3;
    this.dlyF = ctx.createBiquadFilter(); this.dlyF.type = 'lowpass'; this.dlyF.frequency.value = 3200;
    this.dly.connect(this.dlyF).connect(this.fb).connect(this.dly);
    this.dlyF.connect(this.dlyWet).connect(this.out);
    this.plk = ctx.createGain(); this.plk.connect(this.out); this.plk.connect(this.dly);
    // breath wash: looped noise through a moving band-pass
    this.breathSrc = ctx.createBufferSource(); this.breathSrc.buffer = this._noise(2); this.breathSrc.loop = true;
    this.breathF = ctx.createBiquadFilter(); this.breathF.type = 'bandpass'; this.breathF.Q.value = 0.8; this.breathF.frequency.value = 500;
    this.breathG = ctx.createGain(); this.breathG.gain.value = 0;
    this.breathSrc.connect(this.breathF).connect(this.breathG).connect(synth.bus); this.breathSrc.start();

    this.p = { bands: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 }, focus: 0.5, relax: 0.5, harmony: 0, conf: 0 };
    this.mode = 'chord'; this.active = false; this.timer = null;
    this.tempo = 122; this.mult = 2; this.step = 0; this.next = 0; this.arpIdx = 5; this.idleSince = 0; this.seen = 0;
    this.onKick = null;
  }
  _noise(sec) {
    const ctx = this.ctx, n = ctx.sampleRate * sec, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  get sixteenth() { return 60 / this.tempo / 4; }

  /** every frame: signals + whether groove should play (mode groove, live, pulse lock) */
  update(s, groove) {
    this.seen = performance.now();
    const b = s.bands, p = this.p;
    for (const k in p.bands) p.bands[k] = clamp(b[k] || 0);
    p.focus = clamp(s.focus ?? 0.5); p.relax = clamp(s.relax ?? 0.5); p.harmony = clamp(s.harmony || 0); p.conf = clamp(s.beatConf || 0);
    const t = this.ctx.currentTime;
    const want = groove && s.ready === 'live' && s.bpm > 0;
    if (want) this._retarget(s.bpm);
    if (want && !this.active) {   // start a fresh bar just ahead of now
      this.active = true; this.step = 0; this.next = t + 0.06;
      this.out.gain.cancelScheduledValues(t); this.out.gain.setTargetAtTime(0.9, t, 0.6);
      if (!this.timer) this.timer = setInterval(() => this._schedule(), TICK_MS);
    } else if (!want && this.active) {   // fade out over ~2 bars, then stop scheduling
      this.active = false; this.idleSince = t;
      this.out.gain.setTargetAtTime(0, t, 0.9);
    }
    if (!this.active && this.timer && t - this.idleSince > 4) { clearInterval(this.timer); this.timer = null; }
    // breath wash (only in groove mode)
    const br = s.breath, on = groove && s.ready === 'live' && br?.on;
    this.breathG.gain.setTargetAtTime(on ? 0.018 + 0.05 * br.level : 0, t, 0.25);
    this.breathF.frequency.setTargetAtTime(300 + 1400 * (br?.level || 0), t, 0.25);
    this.dlyWet.gain.setTargetAtTime(0.15 + 0.4 * p.relax, t, 1);
  }
  /** tempo from the heart: ×1.5 or ×2, whichever is nearer 122 (sticky), glide ≤ ~1 BPM per bar */
  _retarget(bpm) {
    const d = m => Math.abs(bpm * m - 122);
    if (d(this.mult === 2 ? 1.5 : 2) + 6 < d(this.mult)) this.mult = this.mult === 2 ? 1.5 : 2;
    this.target = clamp(bpm * this.mult, 100, 140);
  }
  /** a real heartbeat just happened: pull the grid ~20% toward the nearest 8th note */
  onHeart() {
    if (!this.active) return;
    const t = this.ctx.currentTime - 0.03, e8 = this.sixteenth * 2;   // ~DSP tick latency
    // grid point (8th) nearest to t, measured from the next scheduled 16th
    let k = (t - this.next) / e8; const off = (k - Math.round(k)) * e8;
    this.next += clamp(off * 0.2, -0.02, 0.02);
  }

  _schedule() {
    const ctx = this.ctx;
    if (!this.active) return;
    // hidden tab (no frames → no fresh signals) or update() stalled: fade out rather than play stale parts
    if (document.hidden || performance.now() - this.seen > 500) {
      this.active = false; this.idleSince = ctx.currentTime; this.out.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
      clearInterval(this.timer); this.timer = null; return;
    }
    if (this.next < ctx.currentTime) this.next = ctx.currentTime + 0.02;   // tab was throttled: don't burst-catch-up
    while (this.next < ctx.currentTime + LOOK) {
      if (this.target) this.tempo += clamp(this.target - this.tempo, -0.06, 0.06);
      this._play(this.step, this.next);
      this.next += this.sixteenth; this.step = (this.step + 1) % 32;
    }
  }

  _play(s, t) {
    const p = this.p, B = p.bands, s16 = s % 16, H = p.harmony;
    if (s16 % 4 === 0) this._kick(t, 0.55 + 0.4 * p.conf);
    if (s16 % 4 === 2) this._hat(t, 0.05 + 0.12 * B.beta, 0.11, 7500);
    if (s16 % 2 === 1 && Math.random() < 0.15 + 0.75 * B.gamma) this._hat(t, 0.025 + 0.03 * B.gamma, 0.03, 9500);
    if ((s16 === 4 || s16 === 12) && p.focus > 0.15) this._clap(t, 0.05 + 0.12 * p.focus);
    const bn = BASS[s16];
    if (bn !== null) this._bass(t, H > 0.6 ? (bn === 12 ? 12 : 0) : bn, 0.1 + 0.16 * (0.3 + B.delta));
    if (s === 0 || s === 16) this._pad(t, 0.012 + 0.03 * (0.3 + B.theta), H);
    if (Math.random() < 0.08 + 0.7 * Math.pow(B.alpha, 1.2) + 0.25 * H) this._pluck(t, H);
  }

  _env(g, t, peak, a, d) {
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0005, t + a + d);
  }
  _done(src, ...nodes) { src.onended = () => { src.disconnect(); for (const n of nodes) n.disconnect(); }; }

  _kick(t, amp) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    this._env(g, t, 0.7 * amp, 0.003, 0.38);
    o.connect(g).connect(this.out); o.start(t); o.stop(t + 0.45); this._done(o, g);
    const c = ctx.createBufferSource(), cf = ctx.createBiquadFilter(), cg = ctx.createGain();   // soft click for definition
    c.buffer = this.synth.noiseBuf; cf.type = 'highpass'; cf.frequency.value = 2500;
    this._env(cg, t, 0.04 * amp, 0.001, 0.012);
    c.connect(cf).connect(cg).connect(this.out); c.start(t); c.stop(t + 0.03); this._done(c, cf, cg);
    // sidechain pump: bass + pad + band chord dip on each kick
    for (const gp of [this.duck.gain, this.synth.droneBus.gain]) {
      gp.setTargetAtTime(0.35, t, 0.008); gp.setTargetAtTime(1, t + 0.06, 0.09);
    }
    this.onKick?.(Math.max(0, t - ctx.currentTime));
  }
  _hat(t, amp, dec, f) {
    const ctx = this.ctx, src = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.synth.noiseBuf; src.playbackRate.value = 1 + Math.random() * 0.1;
    fl.type = 'highpass'; fl.frequency.value = f;
    this._env(g, t, amp, 0.002, dec);
    src.connect(fl).connect(g).connect(this.out); src.start(t, Math.random() * 0.2); src.stop(t + dec + 0.05); this._done(src, fl, g);
  }
  _clap(t, amp) {
    const ctx = this.ctx, src = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.synth.noiseBuf; fl.type = 'bandpass'; fl.frequency.value = 1400; fl.Q.value = 1.2;
    g.gain.setValueAtTime(0, t);
    for (const d of [0, 0.011, 0.022]) { g.gain.linearRampToValueAtTime(amp, t + d + 0.001); g.gain.linearRampToValueAtTime(amp * 0.25, t + d + 0.009); }
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.2);
    src.connect(fl).connect(g).connect(this.synth.bus); src.start(t); src.stop(t + 0.25); this._done(src, fl, g);   // claps get the reverb
  }
  _bass(t, semis, amp) {
    const ctx = this.ctx, f = hz(C2, semis), dur = this.sixteenth * 0.9;
    const sub = ctx.createOscillator(), saw = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain(), sg = ctx.createGain();
    sub.type = 'sine'; sub.frequency.value = f; saw.type = 'sawtooth'; saw.frequency.value = f;
    sg.gain.value = 0.35;
    lp.type = 'lowpass'; lp.Q.value = 6;
    const cut = 180 + 1400 * this.p.focus;
    lp.frequency.setValueAtTime(cut * 2.2, t); lp.frequency.exponentialRampToValueAtTime(cut * 0.6, t + dur);
    this._env(g, t, amp, 0.004, dur + 0.05);
    sub.connect(g); saw.connect(sg).connect(lp).connect(g); g.connect(this.duck);
    for (const o of [sub, saw]) { o.start(t); o.stop(t + dur + 0.1); }
    this._done(sub, g); this._done(saw, sg, lp);
  }
  _pad(t, amp, H) {
    const ctx = this.ctx, bar = this.sixteenth * 16, lp = ctx.createBiquadFilter(), g = ctx.createGain();
    lp.type = 'lowpass'; lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(350 + 1800 * this.p.bands.theta, t);
    lp.frequency.linearRampToValueAtTime(500 + 2400 * this.p.bands.theta + 800 * H, t + bar);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + bar * 0.4); g.gain.setTargetAtTime(0, t + bar * 1.6, bar * 0.3);
    lp.connect(g).connect(this.duck);
    const notes = H > 0.3 ? PAD.concat(SHIMMER) : PAD, oscs = [];
    for (const n of notes) for (const det of [-7, 7]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(130.81, n); o.detune.value = det;
      o.connect(lp); o.start(t); o.stop(t + bar * 2.6); oscs.push(o);
    }
    let left = oscs.length;
    for (const o of oscs) o.onended = () => { o.disconnect(); if (--left === 0) { lp.disconnect(); g.disconnect(); } };
  }
  _pluck(t, H) {
    const ctx = this.ctx;
    this.arpIdx = clamp(this.arpIdx + [-2, -1, 1, 1, 2][Math.floor(Math.random() * 5)], 0, 9);
    const deg = PENT[this.arpIdx % 5] + 12 * Math.floor(this.arpIdx / 5);
    const f = hz(261.63, deg + (H > 0.6 ? 12 : 0));
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), g2 = ctx.createGain();
    o.type = H > 0.6 ? 'sine' : 'triangle'; o.frequency.value = f;
    o2.type = 'sine'; o2.frequency.value = f * (H > 0.6 ? 2.76 : 2);   // bell partial in harmony
    g2.gain.value = H > 0.6 ? 0.35 : 0.15;
    const dec = H > 0.6 ? 0.9 : 0.22;
    this._env(g, t, 0.03 + 0.03 * this.p.bands.alpha, 0.003, dec);
    o.connect(g); o2.connect(g2).connect(g); g.connect(this.plk);
    for (const x of [o, o2]) { x.start(t); x.stop(t + dec + 0.05); }
    this._done(o, g); this._done(o2, g2);
    this.dly.delayTime.setTargetAtTime(this.sixteenth * 3, t, 0.5);   // dotted 8th follows tempo
  }
}
