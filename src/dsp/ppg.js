// Heart tracking from the Muse 2 PPG (64Hz, 3 channels: 0 ambient, 1 infrared, 2 red — muse-js ppgChannelNames).
// Raw PPG is a large unsigned level with a tiny pulse on top that may point up or down. Per channel:
//   1. high-pass (track the slow level) + low-pass ~5Hz → pulse waveform;
//   2. autocorrelation over the last 8s → heart PERIOD and how strongly the waveform repeats (r, 0..1).
//      A true period also repeats at twice its length; a partial repeat (from the dicrotic second bump) doesn't,
//      so each candidate lag is scored on r(L) and r(2L). Noise scores low;
//   3. peaks on the waveform's slope (one sharp edge per beat), with a refractory of 70% of the period,
//      only to TIME each beat.
// The channel with the strongest repetition wins. A phase-locked clock turns detected beats into a
// steady pulse that keeps time through brief dropouts; confidence comes from r.

const FS = 64;
const A_DC = 1 / (0.6 * FS);                        // two cascaded level trackers ≈ 0.25Hz high-pass (kills slow drift)
const A_LP = 1 - Math.exp((-2 * Math.PI * 5) / FS); // ≈ 5Hz low-pass (applied twice)
const ENV_DECAY = Math.exp(-1 / (2 * FS));          // peak envelope decays over ~2s
const HIST = 512;                                   // 8s of waveform for autocorrelation
const LAG_MIN = Math.round(0.33 * FS), LAG_MAX = Math.round(1.6 * FS);   // 37–180 bpm
const ACF_MIN = Math.round(HIST * 0.75);            // ≥6s of waveform before trusting a period
const ACF_EVERY = 0.5;                              // s between period estimates
const IBIS = 8;

export const PPG_CHANNEL_NAMES = ['ambient', 'infrared', 'red'];

/** slope peak detector for one polarity; refractory set from the current period */
class Edge {
  constructor(sign) { this.sign = sign; this.ibis = new Float64Array(IBIS); this.reset(); }
  reset() { this.env = 0; this.z1 = 0; this.z2 = 0; this.lastPeak = -Infinity; this.beats = 0; this.n = 0; this.k = 0; }
  step(slope, t, refractory) {
    const z = this.sign * slope;
    this.env = Math.max(Math.abs(z), this.env * ENV_DECAY);
    if (this.z1 > this.z2 && this.z1 >= z && this.z1 > 0.5 * this.env && this.z1 > 0) {
      const tp = t - 1 / FS, ibi = tp - this.lastPeak;
      if (ibi >= refractory) {
        if (ibi <= 1.6) { this.ibis[this.k] = ibi; this.k = (this.k + 1) % IBIS; this.n = Math.min(IBIS, this.n + 1); }
        this.lastPeak = tp; this.beats++;
      }
    }
    this.z2 = this.z1; this.z1 = z;
  }
  /** spread of recent intervals around the period (lower = steadier timing) */
  spread(period) {
    if (this.n < 3) return Infinity;
    let s = 0;
    for (let i = 0; i < this.n; i++) s += Math.abs(this.ibis[i] - period);
    return s / this.n / period;
  }
}

class Channel {
  constructor() { this.hist = new Float32Array(HIST); this.rs = new Float32Array(2 * LAG_MAX + 2); this.edges = [new Edge(1), new Edge(-1)]; this.reset(); }
  reset() {
    this.init = false; this.dc = 0; this.dc2 = 0; this.lp1 = 0; this.lp2 = 0; this.prev = 0; this.t = 0;
    this.hist.fill(0); this.pos = 0; this.count = 0; this.period = 0; this.r = 0;
    for (const e of this.edges) e.reset();
  }
  push(samples, refractory) {
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (!Number.isFinite(s)) continue;
      if (!this.init) { this.dc = s; this.init = true; }
      this.dc += (s - this.dc) * A_DC;
      const hp1 = s - this.dc;
      this.dc2 += (hp1 - this.dc2) * A_DC;
      this.lp1 += (hp1 - this.dc2 - this.lp1) * A_LP;
      this.lp2 += (this.lp1 - this.lp2) * A_LP;
      this.t += 1 / FS;
      this.hist[this.pos] = this.lp2; this.pos = (this.pos + 1) % HIST; this.count = Math.min(HIST, this.count + 1);
      const slope = this.lp2 - this.prev; this.prev = this.lp2;
      for (const e of this.edges) e.step(slope, this.t, refractory);
    }
  }
  /** normalized autocorrelation → period (s) and repetition strength r */
  acf() {
    this.r = 0; this.period = 0;
    if (this.count < ACF_MIN) return;
    const n = this.count, h = this.hist, start = (this.pos - n + HIST) % HIST, rs = this.rs;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += h[(start + i) % HIST];
    mean /= n;
    for (let lag = LAG_MIN - 1; lag <= 2 * LAG_MAX + 1; lag++) {
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i + lag < n; i++) {
        const a = h[(start + i) % HIST] - mean, b = h[(start + i + lag) % HIST] - mean;
        sxy += a * b; sxx += a * a; syy += b * b;
      }
      rs[lag] = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
    }
    // score each local peak by r(L) and r(2L): only a true period repeats at both
    let bestScore = 0, L = 0;
    for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
      if (rs[lag] <= 0 || rs[lag] < rs[lag - 1] || rs[lag] < rs[lag + 1]) continue;
      let r2 = rs[2 * lag];
      for (let j = 2 * lag - 2; j <= 2 * lag + 2; j++) if (rs[j] > r2) r2 = rs[j];   // ±2 samples for period jitter
      const score = (rs[lag] + Math.max(0, r2)) / 2;
      if (score > bestScore * 1.02) { bestScore = score; L = lag; }
    }
    if (!L) return;
    const y0 = rs[L - 1], y1 = rs[L], y2 = rs[L + 1], d = y0 - 2 * y1 + y2;
    const off = d !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d)) : 0;   // parabolic refine
    this.period = (L + off) / FS; this.r = bestScore;
  }
}

export class HeartTracker {
  constructor(channels = 3) { this.ch = Array.from({ length: channels }, () => new Channel()); this.reset(); }
  reset() {
    for (const c of this.ch) c.reset();
    this.best = -1; this.edge = null; this.bestName = ''; this.seen = 0; this.acfT = 0;
    this.period = 0; this.r = 0; this.bpm = 0; this.conf = 0; this.phase = 0;
  }
  push(ch, samples) {
    if (ch < 0 || ch >= this.ch.length) return;
    this.ch[ch].push(samples, this.period ? 0.7 * this.period : 0.33);
  }

  /** advance by dt seconds; returns the number of clock pulses to play this step */
  step(dt) {
    this.acfT += dt;
    if (this.acfT >= ACF_EVERY) {
      this.acfT = 0;
      let top = -1;
      for (let c = 0; c < this.ch.length; c++) { this.ch[c].acf(); if (top < 0 || this.ch[c].r > this.ch[top].r) top = c; }
      if (top >= 0 && (this.best < 0 || this.ch[top].r > this.ch[this.best].r + 0.1)) { this.best = top; this.edge = null; }
      const c = this.best >= 0 ? this.ch[this.best] : null;
      this.r = c ? c.r : 0;
      if (c && c.period && c.r > 0.4) this.period = this.period ? this.period + (c.period - this.period) * 0.5 : c.period;
      if (c && this.period) {
        // timing polarity: whichever edge beats most steadily at the period (sticky unless clearly better)
        const [e0, e1] = c.edges, s0 = e0.spread(this.period), s1 = e1.spread(this.period);
        const pick = s0 <= s1 ? e0 : e1, other = pick === e0 ? e1 : e0;
        if (!this.edge || (this.edge !== pick && pick.spread(this.period) < 0.7 * other.spread(this.period))) { this.edge = pick; this.seen = pick.beats; }
        this.bestName = `${PPG_CHANNEL_NAMES[this.best] || this.best}${this.edge.sign < 0 ? '−' : '+'}`;
      }
    }
    const target = this.period ? Math.max(0, Math.min(1, (this.r - 0.5) / 0.35)) : 0;
    this.conf += (target - this.conf) * (1 - Math.exp(-dt / (target > this.conf ? 1.5 : 4)));
    if (!this.period) return 0;
    this.bpm = 60 / this.period;

    const detected = this.edge ? this.edge.beats - this.seen : 0;
    if (this.edge) this.seen = this.edge.beats;
    // phase-locked clock: each detection nudges at most ±0.08 cycle toward the beat, the clock carries it between
    this.phase += dt / this.period;
    for (let i = 0; i < detected; i++) { const e = this.phase > 0.5 ? this.phase - 1 : this.phase; this.phase -= Math.max(-0.08, Math.min(0.08, e * 0.4)); }
    let pulses = 0;
    while (this.phase >= 1) { this.phase -= 1; if (this.conf >= 0.25) pulses++; }
    return pulses;
  }
}

/** legacy single-channel wrapper (docs/dsp-smoke.mjs) */
export class HeartRate {
  constructor(onBeat) { this.onBeat = onBeat; this.t = new HeartTracker(1); this.bpm = 0; }
  push(samples) { this.t.push(0, samples); const n = this.t.step(samples.length / FS); this.bpm = this.t.conf >= 0.25 ? this.t.bpm : 0; for (let i = 0; i < n; i++) this.onBeat?.(); }
}
