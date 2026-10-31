import { FS, N, BANDS, BAND_NAMES, hann, fft, Normalizer } from './bands.js';
import { HeartRate } from './ppg.js';

// One entry point for all signal math. main.js pushes raw samples in and reads `tick()` results out.
// Outputs are normalized 0..1 values plus discrete events — this is an art/meditation tool, not a measurement device.

const NB = BAND_NAMES.length;
const binRange = ([lo, hi]) => [Math.ceil((lo * N) / FS), Math.ceil((hi * N) / FS)];   // [start, end) bins
const BAND_BINS = BAND_NAMES.map(k => binRange(BANDS[k]));
const TOTAL_BINS = binRange([1, 44]);
const HIGH_BINS = binRange([30, 44]);
const LINE_BINS = [binRange([49, 52]), binRange([59, 62])];

const CAL_VERSION = 1;
const REJECT_MS = 1000;            // one FFT window: an artifact contaminates the next second of spectra
const REFRACTORY_MS = 800;
const DRIFT_TAU_S = 180;           // calibrated baseline mean follows clean signal over ~3 minutes
const RAIL_UV = 990;               // muse-js µV range is about ±1000
const FRONTAL = [1, 2], TEMPORAL = [0, 3];   // AF7/AF8 (blink), TP9/TP10 (clench)
const USABLE_SCORE = 0.25;         // 'noisy' channels below this stay out of averages and calibration
const CLENCH_ADAPT_TICKS = 30;     // high-frequency level held >3s is the new normal, not a clench

const zeros = () => Object.fromEntries(BAND_NAMES.map(k => [k, 0]));
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

class Stats {   // Welford mean/variance per band
  constructor() { this.n = 0; this.mean = new Float64Array(NB); this.m2 = new Float64Array(NB); }
  add(rel) {
    this.n++;
    for (let b = 0; b < NB; b++) { const v = rel[BAND_NAMES[b]], d = v - this.mean[b]; this.mean[b] += d / this.n; this.m2[b] += d * (v - this.mean[b]); }
  }
  std(b) { return this.n > 1 ? Math.sqrt(this.m2[b] / (this.n - 1)) : 0; }
}

export class SignalPipeline {
  constructor({ channels = 4 } = {}) {
    this.C = channels;
    this.buf = Array.from({ length: channels }, () => new Float32Array(N));
    this.pos = new Int32Array(channels);
    this.filled = new Int32Array(channels);
    this.lo = new Float64Array(channels); this.hi = new Float64Array(channels);
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.rel = Array.from({ length: channels }, zeros);        // raw relative band power per channel
    this.relAvg = zeros();
    this.hf = new Float64Array(channels);
    this.good = new Uint8Array(channels); this.use = new Uint8Array(channels);
    this.beats = 0;
    this.hr = new HeartRate(() => { this.beats++; });
    this.cal = null;               // { avg:{mean,std}, ch:[{mean,std}], t }
    this.calRun = null;            // { seconds, clean, avg:Stats, ch:Stats[] }
    this.out = {
      bands: zeros(), ch: Array.from({ length: channels }, zeros), asym: 0, bpm: 0,
      quality: Array.from({ length: channels }, () => ({ score: 0, label: 'no contact', std: 0 })),
      artifact: { blink: false, clench: false, motion: false, rejected: false },
      events: [],
      calibration: { state: 'none', progress: 0, cleanSeconds: 0 },
    };
    this.reset();
  }

  reset() {
    for (let c = 0; c < this.C; c++) { this.buf[c].fill(0); this.pos[c] = 0; this.filled[c] = 0; this.lo[c] = Infinity; this.hi[c] = -Infinity; }
    this.norm = new Normalizer();
    this.chNorm = Array.from({ length: this.C }, () => new Normalizer());
    this.p2pBase = 60; this.hfBase = new Float64Array(this.C); this.hfN = new Int32Array(this.C); this.hfOver = new Int32Array(this.C);
    this.lastBlink = this.lastClench = -Infinity; this.rejectUntil = -Infinity;
    this.motion = false; this.accAvg = null; this.lastT = null; this.beats = 0;
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

  /** Spectrum + quality for one channel; fills this.rel[ch], returns 30–44Hz absolute power. */
  analyze(ch, q) {
    const b = this.buf[ch], p = this.pos[ch], re = this.re, im = this.im;
    let mean = 0, railed = 0;
    for (let i = 0; i < N; i++) { const v = b[i]; mean += v; if (v >= RAIL_UV || v <= -RAIL_UV) railed++; }
    mean /= N;
    let sq = 0;
    for (let i = 0; i < N; i++) { const d = b[(p + i) % N] - mean; sq += d * d; re[i] = d * hann[i]; im[i] = 0; }
    const std = Math.sqrt(sq / N);
    fft(re, im);
    const pw = (s, e) => { let a = 0; for (let k = s; k < e; k++) a += re[k] * re[k] + im[k] * im[k]; return a; };
    let total = 0;
    const rel = this.rel[ch];
    for (let k = 0; k < NB; k++) { const v = pw(BAND_BINS[k][0], BAND_BINS[k][1]); rel[BAND_NAMES[k]] = v; total += v; }
    for (let k = 0; k < NB; k++) rel[BAND_NAMES[k]] = total > 0 ? rel[BAND_NAMES[k]] / total : 0;
    const inBand = pw(TOTAL_BINS[0], TOTAL_BINS[1]);
    const line = pw(LINE_BINS[0][0], LINE_BINS[0][1]) + pw(LINE_BINS[1][0], LINE_BINS[1][1]);
    const lineRatio = inBand > 0 ? line / inBand : 0;
    const sStd = std <= 60 ? 1 : std >= 150 ? 0 : 1 - (std - 60) / 90;
    const sLine = lineRatio <= 0.1 ? 1 : lineRatio >= 1 ? 0 : 1 - (lineRatio - 0.1) / 0.9;
    q.std = std;
    if (this.filled[ch] < N || !Number.isFinite(std) || std < 1.5) { q.label = 'no contact'; q.score = 0; }
    else if (railed / N >= 0.05) { q.label = 'railed'; q.score = 0; }
    else { q.score = Math.min(sStd, sLine); q.label = q.score < 0.5 ? 'noisy' : 'good'; }
    return pw(HIGH_BINS[0], HIGH_BINS[1]);
  }

  tick(now) {
    const o = this.out, a = o.artifact, ev = o.events;
    ev.length = 0;
    const dt = this.lastT === null ? 0.1 : Math.min(0.25, Math.max(0, (now - this.lastT) / 1000));
    this.lastT = now;

    // spectra + quality; detectors trust only 'good' channels, averages take good + mildly noisy
    let usable = 0;
    for (let c = 0; c < this.C; c++) {
      this.hf[c] = this.analyze(c, o.quality[c]);
      const q = o.quality[c];
      this.good[c] = q.label === 'good' ? 1 : 0;
      this.use[c] = this.good[c] || (q.label === 'noisy' && q.score >= USABLE_SCORE) ? 1 : 0;
      usable += this.use[c];
    }
    const quad = this.C >= 4;

    // blink: good frontal channels' peak-to-peak since last tick vs running baseline
    let p2p = 0;
    if (quad) for (const c of FRONTAL) { const v = this.hi[c] - this.lo[c]; if (this.good[c] && Number.isFinite(v) && v > p2p) p2p = v; }
    for (let c = 0; c < this.C; c++) { this.lo[c] = Infinity; this.hi[c] = -Infinity; }
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
    if (a.blink || a.clench || a.motion) this.rejectUntil = now + REJECT_MS;
    a.rejected = now < this.rejectUntil || usable === 0;

    if (quad && !a.clench && !a.rejected) for (const c of TEMPORAL) {
      if (!this.good[c]) continue;
      this.hfBase[c] += (this.hf[c] - this.hfBase[c]) * (this.hfN[c] < 10 ? 0.5 : 0.05); this.hfN[c]++;
    }

    for (let n = this.beats; n > 0; n--) ev.push('beat');
    this.beats = 0;
    o.bpm = this.hr.bpm;

    if (!a.rejected) {
      // average over channels with contact
      const avg = this.relAvg;
      for (const k of BAND_NAMES) avg[k] = 0;
      for (let c = 0; c < this.C; c++) {
        if (!this.use[c]) continue;
        for (const k of BAND_NAMES) avg[k] += this.rel[c][k] / usable;
      }
      if (this.calRun && now > this.calRun.skipUntil) this.feedCalibration(dt);
      const n = this.normalize(avg, this.norm, this.cal?.avg, dt);
      for (const k of BAND_NAMES) o.bands[k] += (n[k] - o.bands[k]) * 0.3;
      for (let c = 0; c < this.C; c++) {
        if (!this.use[c]) continue;   // hold lobes with no contact
        const v = this.normalize(this.rel[c], this.chNorm[c], this.cal?.ch[c], dt);
        for (const k of BAND_NAMES) o.ch[c][k] += (v[k] - o.ch[c][k]) * 0.3;
      }
      if (quad && this.use[0] && this.use[1] && this.use[2] && this.use[3]) {
        const L = (this.rel[0].alpha + this.rel[1].alpha) / 2, R = (this.rel[2].alpha + this.rel[3].alpha) / 2;
        o.asym += ((R - L) / Math.max(1e-6, R + L) - o.asym) * 0.2;
      }
    }

    const cs = o.calibration;
    cs.state = this.calRun ? 'running' : this.cal ? 'done' : 'none';
    cs.cleanSeconds = this.calRun ? this.calRun.clean : 0;
    cs.progress = this.calRun ? Math.min(1, this.calRun.clean / this.calRun.seconds) : this.cal ? 1 : 0;
    return o;
  }

  /** before calibration: adaptive min/max; after: baseline z-score (±2.5σ → 0..1) with slow mean drift */
  normalize(rel, adaptive, base, dt) {
    if (!base) return adaptive.apply(rel);
    const out = this._nOut || (this._nOut = zeros());
    const k = dt / DRIFT_TAU_S;
    for (let b = 0; b < NB; b++) {
      const name = BAND_NAMES[b], v = rel[name];
      out[name] = clamp01(0.5 + (v - base.mean[b]) / Math.max(base.std[b], 0.01) / 5);
      base.mean[b] += (v - base.mean[b]) * k;
    }
    return out;
  }

  startCalibration(seconds = 30) {
    // skip one FFT window: it still holds signal from before Start (eyes open, settling)
    const skipUntil = (this.lastT ?? -Infinity) + REJECT_MS;
    this.calRun = { seconds, clean: 0, skipUntil, avg: new Stats(), ch: Array.from({ length: this.C }, () => new Stats()) };
  }
  cancelCalibration() { this.calRun = null; }

  feedCalibration(dt) {
    const r = this.calRun;
    r.avg.add(this.relAvg);
    for (let c = 0; c < this.C; c++) if (this.use[c]) r.ch[c].add(this.rel[c]);
    r.clean += dt;
    if (r.clean < r.seconds) return;
    const pack = s => ({ mean: Array.from(s.mean), std: BAND_NAMES.map((_, b) => s.std(b)) });
    // a channel with contact for under half the run borrows the average baseline
    const enough = s => s.n >= Math.max(2, r.avg.n * 0.5);
    this.importCalibration({ version: CAL_VERSION, bands: BAND_NAMES, t: Date.now(), avg: pack(r.avg), ch: r.ch.map(s => pack(enough(s) ? s : r.avg)) });
    this.calRun = null;
  }

  get calibrated() { return !!this.cal; }

  exportCalibration() {
    if (!this.cal) return null;
    const pack = s => ({ mean: Array.from(s.mean), std: Array.from(s.std) });
    return { version: CAL_VERSION, bands: BAND_NAMES.slice(), t: this.cal.t, avg: pack(this.cal.avg), ch: this.cal.ch.map(pack) };
  }

  importCalibration(j) {
    const okArr = x => Array.isArray(x) && x.length === NB && x.every(v => typeof v === 'number' && Number.isFinite(v));
    const okStat = s => s && okArr(s.mean) && okArr(s.std) && s.std.every(v => v >= 0);
    if (!j || j.version !== CAL_VERSION || !Array.isArray(j.bands) || j.bands.join() !== BAND_NAMES.join()) return false;
    if (!okStat(j.avg) || !Array.isArray(j.ch) || j.ch.length !== this.C || !j.ch.every(okStat)) return false;
    const unpack = s => ({ mean: Float64Array.from(s.mean), std: Float64Array.from(s.std) });
    this.cal = { t: Number(j.t) || 0, avg: unpack(j.avg), ch: j.ch.map(unpack) };
    return true;
  }

  clearCalibration() { this.cal = null; }
}
