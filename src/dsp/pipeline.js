import { FS, N, BANDS, BAND_NAMES, hann, fft } from './bands.js';
import { HeartRate } from './ppg.js';

// One entry point for all signal math. main.js pushes raw samples in and reads `tick()` results out.
// Outputs are normalized 0..1 values plus discrete events — this is an art/meditation tool, not a measurement device.
//
// Why it is built this way (see docs/SIGNALS.md):
//  - a single 1s FFT window's band power is mostly noise, so band power is tracked in dB and smoothed over ~2s;
//  - nothing is auto-stretched to fill 0..1 (that turned noise into "activity"); indices use fixed dB spans;
//  - the two readable indices are relax (alpha vs beta+gamma) and focus (beta vs theta);
//  - calibration is two steps (eyes open, eyes closed) and anchors those indices to the person's own levels.

const NB = BAND_NAMES.length;
const BI = Object.fromEntries(BAND_NAMES.map((k, i) => [k, i]));
const binRange = ([lo, hi]) => [Math.ceil((lo * N) / FS), Math.ceil((hi * N) / FS)];   // [start, end) bins
const BAND_BINS = BAND_NAMES.map(k => binRange(BANDS[k]));
const TOTAL_BINS = binRange([1, 44]);
const HIGH_BINS = binRange([30, 44]);
const LINE_BINS = [binRange([49, 52]), binRange([59, 62])];
export const PSD_BINS = 46;                  // 0..45Hz at 1Hz/bin, for the Signal Lab
const PSD_SCALE = 2 / (FS * hann.reduce((a, w) => a + w * w, 0));   // |X|² → µV²/Hz

const CAL_VERSION = 2;
const HOLD_MS = 1000;              // one FFT window: an artifact contaminates the next second of that channel's spectrum
const REFRACTORY_MS = 800;
const RAIL_UV = 990;               // muse-js µV range is about ±1000
const FRONTAL = [1, 2], TEMPORAL = [0, 3];   // AF7/AF8 (blink, focus), TP9/TP10 (clench, relax)
const USABLE_SCORE = 0.25;         // 'noisy' channels below this stay out of everything
const CLENCH_ADAPT_TICKS = 30;     // high-frequency level held >3s is the new normal, not a clench
const TAU_POW = 2.0;               // s — smoothing of per-band dB power
const TAU_PSD = 1.5;               // s — smoothing of the displayed spectrum
const TAU_OUT = 0.8;               // s — easing of the 0..1 outputs
const TAU_CENTER = 60;             // s — pre-calibration slow centre of each index
const RELAX_SPAN_DB = 8, FOCUS_SPAN_DB = 6;   // pre-calibration: dB that moves an index across its range
const CAL_SETTLE_S = 2;            // each calibration step ignores its first 2s (window refill + settling in)
const MIN_SPAN_DB = 1;             // below this the open/closed difference is too small to anchor on

const zeros = () => Object.fromEntries(BAND_NAMES.map(k => [k, 0]));
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (dt, tau) => 1 - Math.exp(-dt / tau);
const dB = p => 10 * Math.log10(p + 1e-12);
const dBsum = (a, b) => 10 * Math.log10(10 ** (a / 10) + 10 ** (b / 10));
const relaxOf = L => L[BI.alpha] - dBsum(L[BI.beta], L[BI.gamma]);
const focusOf = L => L[BI.beta] - L[BI.theta];
const alphaOf = L => L[BI.alpha];

/** adaptive min/max → 0..1 with a wide minimum span, so small wobble is not stretched to full scale */
class RangeNorm {
  constructor(minSpan = 0.12, decay = 0.999) { this.lo = new Float64Array(NB); this.hi = new Float64Array(NB); this.init = false; this.minSpan = minSpan; this.decay = decay; }
  reset() { this.init = false; }
  apply(v, out) {
    for (let b = 0; b < NB; b++) {
      if (!this.init) { this.lo[b] = v[b] - this.minSpan / 2; this.hi[b] = v[b] + this.minSpan / 2; }
      const span = this.hi[b] - this.lo[b];
      this.lo[b] = Math.min(v[b], this.lo[b] + span * (1 - this.decay));
      this.hi[b] = Math.max(v[b], this.hi[b] - span * (1 - this.decay));
      const w = Math.max(this.minSpan, this.hi[b] - this.lo[b]), mid = (this.lo[b] + this.hi[b]) / 2;
      out[b] = clamp01((v[b] - (mid - w / 2)) / w);
    }
    this.init = true;
  }
}

export class SignalPipeline {
  constructor({ channels = 4 } = {}) {
    const C = (this.C = channels);
    this.buf = Array.from({ length: C }, () => new Float32Array(N));
    this.pos = new Int32Array(C); this.filled = new Int32Array(C);
    this.lo = new Float64Array(C); this.hi = new Float64Array(C);
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.hf = new Float64Array(C);
    this.good = new Uint8Array(C); this.use = new Uint8Array(C); this.live = new Uint8Array(C);
    this.holdUntil = new Float64Array(C);
    this.dBnow = Array.from({ length: C }, () => new Float64Array(NB));   // this tick's band power (dB)
    this.L = Array.from({ length: C }, () => new Float64Array(NB));       // smoothed band power (dB)
    this.Linit = new Uint8Array(C);
    this.psdNow = Array.from({ length: C }, () => new Float32Array(PSD_BINS));
    this.psdS = Array.from({ length: C }, () => new Float32Array(PSD_BINS));
    this.relS = new Float64Array(NB); this.chRel = Array.from({ length: C }, () => new Float64Array(NB));
    this.n01 = new Float64Array(NB);
    this.rangeAvg = new RangeNorm(); this.rangeCh = Array.from({ length: C }, () => new RangeNorm());
    this.cal = null;               // { t, relax:{open,closed}, focus:{open,closed}, alphaGainDb }
    this.calRun = null;
    this.out = {
      bands: zeros(), ch: Array.from({ length: C }, zeros), asym: 0, bpm: 0,
      relax: 0.5, focus: 0.5,
      relaxDb: 0, focusDb: 0,                       // raw index values (dB), for the Signal Lab / diagnostics
      dB: zeros(),                                  // smoothed band power averaged over counted channels (dB re 1µV²)
      psd: new Float32Array(PSD_BINS),              // smoothed spectrum (dB), averaged over counted channels
      held: Array.from({ length: C }, () => false), // channel paused by an artifact this tick
      quality: Array.from({ length: C }, () => ({ score: 0, label: 'no contact', std: 0 })),
      artifact: { blink: false, clench: false, motion: false, rejected: true },
      events: [],
      calibration: { state: 'none', phase: null, progress: 0, phaseProgress: 0, phaseLeft: 0, cleanSeconds: 0, result: null },
    };
    this.reset();
  }

  reset() {
    for (let c = 0; c < this.C; c++) {
      this.buf[c].fill(0); this.pos[c] = 0; this.filled[c] = 0; this.lo[c] = Infinity; this.hi[c] = -Infinity;
      this.holdUntil[c] = -Infinity; this.Linit[c] = 0; this.rangeCh[c].reset();
    }
    this.rangeAvg.reset();
    this.p2pBase = 60; this.hfBase = new Float64Array(this.C); this.hfN = new Int32Array(this.C); this.hfOver = new Int32Array(this.C);
    this.lastBlink = this.lastClench = -Infinity;
    this.motion = false; this.accAvg = null; this.lastT = null; this.beats = 0;
    this.centerR = null; this.centerF = null;
    this.hr = new HeartRate(() => { this.beats++; });
    if (this.calRun) this.cancelCalibration();
  }

  push(ch, samples) {
    if (ch < 0 || ch >= this.C) return;
    const b = this.buf[ch];
    let p = this.pos[ch], lo = this.lo[ch], hi = this.hi[ch];
    for (let i = 0; i < samples.length; i++) { const v = samples[i]; b[p] = v; p = (p + 1) % N; if (v < lo) lo = v; if (v > hi) hi = v; }
    this.pos[ch] = p; this.lo[ch] = lo; this.hi[ch] = hi;
    this.filled[ch] = Math.min(N, this.filled[ch] + samples.length);
  }

  pushPpg(samples) { this.hr.push(samples); }

  pushMotion(kind, { x, y, z }) {
    const m = Math.sqrt(x * x + y * y + z * z);
    if (kind === 'gyro') { if (m > 45) this.motion = true; return; }   // deg/s
    if (this.accAvg === null) this.accAvg = m;
    if (Math.abs(m - this.accAvg) > 0.25) this.motion = true;          // g
    this.accAvg += (m - this.accAvg) * 0.05;
  }

  /** spectrum + quality for one channel; fills dBnow/psdNow, returns 30–44Hz absolute power */
  _analyze(ch, q) {
    const b = this.buf[ch], p = this.pos[ch], re = this.re, im = this.im;
    let mean = 0, railed = 0;
    for (let i = 0; i < N; i++) { const v = b[i]; mean += v; if (v >= RAIL_UV || v <= -RAIL_UV) railed++; }
    mean /= N;
    let sq = 0;
    for (let i = 0; i < N; i++) { const d = b[(p + i) % N] - mean; sq += d * d; re[i] = d * hann[i]; im[i] = 0; }
    const std = Math.sqrt(sq / N);
    fft(re, im);
    const psd = this.psdNow[ch], dBn = this.dBnow[ch];
    const pw = k => (re[k] * re[k] + im[k] * im[k]) * PSD_SCALE;
    let total = 0, line = 0, high = 0;
    for (let k = 0; k < PSD_BINS; k++) psd[k] = pw(k);
    for (let bi = 0; bi < NB; bi++) { let s = 0; for (let k = BAND_BINS[bi][0]; k < BAND_BINS[bi][1]; k++) s += psd[k]; dBn[bi] = dB(s); }
    for (let k = TOTAL_BINS[0]; k < TOTAL_BINS[1]; k++) total += psd[k];
    for (let k = HIGH_BINS[0]; k < HIGH_BINS[1]; k++) high += psd[k];
    for (const [s, e] of LINE_BINS) for (let k = s; k < e; k++) line += pw(k);
    for (let k = 0; k < PSD_BINS; k++) psd[k] = dB(psd[k]);
    const lineRatio = total > 0 ? line / total : 0;
    const sStd = std <= 60 ? 1 : std >= 150 ? 0 : 1 - (std - 60) / 90;
    const sLine = lineRatio <= 0.1 ? 1 : lineRatio >= 1 ? 0 : 1 - (lineRatio - 0.1) / 0.9;
    q.std = std;
    if (this.filled[ch] < N || !Number.isFinite(std) || std < 1.5) { q.label = 'no contact'; q.score = 0; }
    else if (railed / N >= 0.05) { q.label = 'railed'; q.score = 0; }
    else { q.score = Math.min(sStd, sLine); q.label = q.score < 0.5 ? 'noisy' : 'good'; }
    return high;
  }

  tick(now) {
    const o = this.out, a = o.artifact, ev = o.events, C = this.C;
    ev.length = 0;
    const dt = this.lastT === null ? 0.1 : Math.min(0.25, Math.max(0, (now - this.lastT) / 1000));
    this.lastT = now;

    for (let c = 0; c < C; c++) {
      this.hf[c] = this._analyze(c, o.quality[c]);
      const q = o.quality[c];
      this.good[c] = q.label === 'good' ? 1 : 0;
      this.use[c] = this.good[c] || (q.label === 'noisy' && q.score >= USABLE_SCORE) ? 1 : 0;
    }
    const quad = C >= 4;

    // blink: good frontal channels' peak-to-peak since last tick vs running baseline
    let p2p = 0;
    if (quad) for (const c of FRONTAL) { const v = this.hi[c] - this.lo[c]; if (this.good[c] && Number.isFinite(v) && v > p2p) p2p = v; }
    for (let c = 0; c < C; c++) { this.lo[c] = Infinity; this.hi[c] = -Infinity; }
    a.blink = p2p > Math.max(150, this.p2pBase * 1.6);
    if (p2p > 0) this.p2pBase += (Math.min(p2p, this.p2pBase * 2) - this.p2pBase) * 0.02;

    // clench: 30–44Hz power jump on a good temporal channel vs that channel's clean baseline
    let clench = false;
    if (quad) for (const c of TEMPORAL) {
      if (!this.good[c]) { this.hfN[c] = 0; this.hfOver[c] = 0; continue; }   // re-learn after the electrode reseats
      if (this.hfN[c] >= 10 && this.hf[c] > 4 * this.hfBase[c] && this.hf[c] > 1e-6) {
        if (++this.hfOver[c] > CLENCH_ADAPT_TICKS) { this.hfBase[c] = this.hf[c]; this.hfOver[c] = 0; } else clench = true;
      } else this.hfOver[c] = 0;
    }
    a.clench = clench;
    a.motion = this.motion; this.motion = false;

    if (a.blink && now - this.lastBlink > REFRACTORY_MS) { this.lastBlink = now; ev.push('blink'); }
    if (a.clench && now - this.lastClench > REFRACTORY_MS) { this.lastClench = now; ev.push('clench'); }

    // holds: a blink pauses only the frontal pair; clench (broadband muscle) and motion pause every channel
    const until = now + HOLD_MS;
    if (a.blink && quad) for (const c of FRONTAL) this.holdUntil[c] = until;
    if (a.clench || a.motion) for (let c = 0; c < C; c++) this.holdUntil[c] = until;
    let live = 0;
    for (let c = 0; c < C; c++) {
      o.held[c] = now < this.holdUntil[c];
      this.live[c] = this.use[c] && !o.held[c] ? 1 : 0;
      live += this.live[c];
    }
    a.rejected = live === 0;

    if (quad && !a.clench && !o.held[0] && !o.held[3]) for (const c of TEMPORAL) {
      if (!this.good[c]) continue;
      this.hfBase[c] += (this.hf[c] - this.hfBase[c]) * (this.hfN[c] < 10 ? 0.5 : 0.05); this.hfN[c]++;
    }

    for (let n = this.beats; n > 0; n--) ev.push('beat');
    this.beats = 0;
    o.bpm = this.hr.bpm;

    if (live) this._update(dt);
    this._calStatus();
    return o;
  }

  /** smooth live channels, then derive bands, indices, spectrum */
  _update(dt) {
    const o = this.out, C = this.C, kP = ease(dt, TAU_POW), kS = ease(dt, TAU_PSD), kO = ease(dt, TAU_OUT);
    for (let c = 0; c < C; c++) {
      if (!this.live[c]) continue;
      const L = this.L[c], d = this.dBnow[c], s = this.psdS[c], p = this.psdNow[c];
      if (!this.Linit[c]) { L.set(d); s.set(p); this.Linit[c] = 1; continue; }
      for (let b = 0; b < NB; b++) L[b] += (d[b] - L[b]) * kP;
      for (let k = 0; k < PSD_BINS; k++) s[k] += (p[k] - s[k]) * kS;
    }
    // channels that count: usable and initialised (held ones contribute their last smoothed value)
    let n = 0;
    const relS = this.relS; relS.fill(0); o.psd.fill(0);
    for (const k of BAND_NAMES) o.dB[k] = 0;
    for (let c = 0; c < C; c++) {
      if (!this.use[c] || !this.Linit[c]) continue;
      n++;
      const L = this.L[c], cr = this.chRel[c];
      let tot = 0;
      for (let b = 0; b < NB; b++) { cr[b] = 10 ** (L[b] / 10); tot += cr[b]; }
      for (let b = 0; b < NB; b++) { cr[b] /= tot; relS[b] += cr[b]; o.dB[BAND_NAMES[b]] += L[b]; }
      for (let k = 0; k < PSD_BINS; k++) o.psd[k] += this.psdS[c][k];
    }
    if (!n) return;
    for (let b = 0; b < NB; b++) { relS[b] /= n; o.dB[BAND_NAMES[b]] /= n; }
    for (let k = 0; k < PSD_BINS; k++) o.psd[k] /= n;

    // bands: smoothed relative power, wide-span scaling
    this.rangeAvg.apply(relS, this.n01);
    for (let b = 0; b < NB; b++) o.bands[BAND_NAMES[b]] += (this.n01[b] - o.bands[BAND_NAMES[b]]) * kO;
    for (let c = 0; c < C; c++) {
      if (!this.use[c] || !this.Linit[c]) continue;
      this.rangeCh[c].apply(this.chRel[c], this.n01);
      for (let b = 0; b < NB; b++) o.ch[c][BAND_NAMES[b]] += (this.n01[b] - o.ch[c][BAND_NAMES[b]]) * kO;
    }

    // indices (dB): relax from the temporal pair, focus from the frontal pair, each falling back to any counted channel
    const r = this._index(TEMPORAL, relaxOf, this.L), f = this._index(FRONTAL, focusOf, this.L);
    if (r !== null) o.relaxDb = r;
    if (f !== null) o.focusDb = f;
    if (this.calRun) this._feedCal(dt);

    let relax01, focus01;
    if (this.cal) {
      const R = this.cal.relax, F = this.cal.focus;
      const rs = Math.abs(R.closed - R.open) >= MIN_SPAN_DB ? R.closed - R.open : RELAX_SPAN_DB;
      const fs = Math.abs(F.open - F.closed) >= MIN_SPAN_DB ? F.open - F.closed : FOCUS_SPAN_DB;
      relax01 = 0.2 + (0.7 * (o.relaxDb - R.open)) / rs;     // eyes open ≈ 0.2, eyes closed ≈ 0.9
      focus01 = 0.5 + (0.5 * (o.focusDb - F.open)) / fs;     // eyes closed ≈ 0, eyes open ≈ 0.5, more active → 1
    } else {
      const kc = ease(dt, TAU_CENTER);
      if (this.centerR === null) { this.centerR = o.relaxDb; this.centerF = o.focusDb; }
      this.centerR += (o.relaxDb - this.centerR) * kc; this.centerF += (o.focusDb - this.centerF) * kc;
      relax01 = 0.5 + (o.relaxDb - this.centerR) / RELAX_SPAN_DB;
      focus01 = 0.5 + (o.focusDb - this.centerF) / FOCUS_SPAN_DB;
    }
    o.relax += (clamp01(relax01) - o.relax) * kO;
    o.focus += (clamp01(focus01) - o.focus) * kO;

    if (C >= 4 && this.use[0] && this.use[1] && this.use[2] && this.use[3] && this.Linit[0] && this.Linit[1] && this.Linit[2] && this.Linit[3]) {
      const aL = (this.L[0][BI.alpha] + this.L[1][BI.alpha]) / 2, aR = (this.L[2][BI.alpha] + this.L[3][BI.alpha]) / 2;
      o.asym += (Math.max(-1, Math.min(1, (aR - aL) / 6)) - o.asym) * kO;
    }
  }

  /** mean of fn(src[c]) over the preferred channels that count, else over every counted channel */
  _index(pref, fn, src, liveOnly = false) {
    const ok = c => this.use[c] && this.Linit[c] && (!liveOnly || this.live[c]);
    let s = 0, n = 0;
    if (this.C >= 4) for (const c of pref) if (ok(c)) { s += fn(src[c]); n++; }
    if (!n) for (let c = 0; c < this.C; c++) if (ok(c)) { s += fn(src[c]); n++; }
    return n ? s / n : null;
  }

  // ---- calibration: step 1 eyes open, step 2 eyes closed ----
  /** startCalibration(20) → 10s + 10s of clean signal; or startCalibration({ open, closed }) in seconds */
  startCalibration(spec = 20) {
    const open = typeof spec === 'number' ? spec / 2 : spec.open, closed = typeof spec === 'number' ? spec / 2 : spec.closed;
    const step = seconds => ({ seconds, t: 0, clean: 0, r: 0, f: 0, alpha: 0, n: 0 });
    this.calRun = { i: 0, steps: [step(open), step(closed)], names: ['open', 'closed'] };
    this._calStatus();
  }
  cancelCalibration() { this.calRun = null; this._calStatus(); }
  get calibrated() { return !!this.cal; }

  /** accumulate this tick's instantaneous index values from live channels (unbiased vs the smoothed ones) */
  _feedCal(dt) {
    const run = this.calRun, st = run.steps[run.i];
    st.t += dt;
    if (st.t < CAL_SETTLE_S) return;
    const r = this._index(TEMPORAL, relaxOf, this.dBnow, true), f = this._index(FRONTAL, focusOf, this.dBnow, true);
    const al = this._index(TEMPORAL, alphaOf, this.dBnow, true);
    if (r === null || f === null) return;
    st.r += r; st.f += f; st.alpha += al; st.n++; st.clean += dt;
    if (st.clean < st.seconds) return;
    if (run.i === 0) { run.i = 1; return; }
    const [O, X] = run.steps, m = (s, k) => s[k] / s.n;
    this.cal = {
      t: Date.now(),
      relax: { open: m(O, 'r'), closed: m(X, 'r') },
      focus: { open: m(O, 'f'), closed: m(X, 'f') },
      alphaGainDb: m(X, 'alpha') - m(O, 'alpha'),
    };
    this.calRun = null;
  }

  _calStatus() {
    const cs = this.out.calibration, run = this.calRun;
    if (run) {
      const [s0, s1] = run.steps, st = run.steps[run.i], total = s0.seconds + s1.seconds;
      const done = run.i ? s0.seconds + s1.clean : s0.clean;
      cs.state = 'running'; cs.phase = run.names[run.i];
      cs.phaseProgress = Math.min(1, st.clean / st.seconds);
      cs.phaseLeft = Math.max(0, st.seconds - st.clean) + Math.max(0, CAL_SETTLE_S - st.t);
      cs.progress = Math.min(1, done / total); cs.cleanSeconds = done;
    } else {
      cs.state = this.cal ? 'done' : 'none'; cs.phase = null; cs.phaseProgress = 0; cs.phaseLeft = 0;
      cs.progress = this.cal ? 1 : 0; cs.cleanSeconds = 0;
    }
    cs.result = this.cal ? this._calResult() : null;
  }

  _calResult() {
    const c = this.cal, g = c.alphaGainDb;
    return {
      alphaGainDb: g,
      relaxSpanDb: c.relax.closed - c.relax.open,
      focusSpanDb: c.focus.open - c.focus.closed,
      // how clearly eyes-closed alpha showed up: the classic check that the headband is reading brain rhythm
      verdict: g >= 3 ? 'strong' : g >= MIN_SPAN_DB ? 'weak' : 'not detected',
    };
  }

  exportCalibration() {
    if (!this.cal) return null;
    const { t, relax, focus, alphaGainDb } = this.cal;
    return { version: CAL_VERSION, t, relax: { ...relax }, focus: { ...focus }, alphaGainDb };
  }

  importCalibration(j) {
    const pair = x => x && Number.isFinite(x.open) && Number.isFinite(x.closed);
    if (!j || j.version !== CAL_VERSION || !pair(j.relax) || !pair(j.focus) || !Number.isFinite(j.alphaGainDb)) return false;
    this.cal = { t: Number(j.t) || 0, relax: { open: j.relax.open, closed: j.relax.closed }, focus: { open: j.focus.open, closed: j.focus.closed }, alphaGainDb: j.alphaGainDb };
    this._calStatus();
    return true;
  }

  clearCalibration() { this.cal = null; this._calStatus(); }
}
