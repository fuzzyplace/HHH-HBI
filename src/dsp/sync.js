// Heart-rhythm ↔ breath sync. Heart rate naturally rises a little on each in-breath and falls on each
// out-breath (respiratory sinus arrhythmia); breathing slowly (~5.5/min) makes that swing large and regular.
// We know exactly where the breath guide is, so: record heart rate from each real beat interval together
// with the guide's phase, and measure how much of the heart-rate variation over the last ~60s follows the
// guide's rhythm (a lock-in at the breath frequency). 0 = unrelated, 1 = heart rate rises and falls with
// the guide. Wellness/art feedback only — not a medical measure.

const WINDOW_S = 64, MIN_S = 30, MIN_N = 24;

export class BreathSync {
  constructor() { this.t = []; this.hr = []; this.ph = []; this.sync = 0; this.amp = 0; }
  reset() { this.t.length = this.hr.length = this.ph.length = 0; this.sync = 0; this.amp = 0; }
  /** one real beat interval (s) at time tSec, while the breath guide is at phase 0..1 */
  push(ibi, tSec, phase) {
    this.t.push(tSec); this.hr.push(60 / ibi); this.ph.push(phase);
    while (this.t.length && tSec - this.t[0] > WINDOW_S) { this.t.shift(); this.hr.shift(); this.ph.shift(); }
  }
  /** recompute (cheap; call ~1Hz). Returns sync 0..1 */
  update(tSec) {
    const n = this.t.length;
    if (n < MIN_N || tSec - this.t[0] < MIN_S) { this.sync = 0; this.amp = 0; return 0; }
    // detrend with a least-squares line so slow drifts in heart rate don't count
    let st = 0, sh = 0, stt = 0, sth = 0;
    for (let i = 0; i < n; i++) { const t = this.t[i] - this.t[0]; st += t; sh += this.hr[i]; stt += t * t; sth += t * this.hr[i]; }
    const den = n * stt - st * st, b = den ? (n * sth - st * sh) / den : 0, a = (sh - b * st) / n;
    let vs = 0, S = 0, C = 0;
    for (let i = 0; i < n; i++) {
      const x = this.hr[i] - (a + b * (this.t[i] - this.t[0])), w = 2 * Math.PI * this.ph[i];
      vs += x * x; S += x * Math.sin(w); C += x * Math.cos(w);
    }
    vs /= n; S /= n; C /= n;
    this.amp = 2 * Math.sqrt(S * S + C * C);                 // peak heart-rate swing at the breath rhythm (bpm)
    const ratio = vs > 1e-6 ? (2 * (S * S + C * C)) / vs : 0;   // share of variance at the breath rhythm, 0..1
    const floor = 2 / n;                                      // what pure noise scores on average
    this.sync = Math.max(0, Math.min(1, (ratio - floor) / (0.8 - floor))) * Math.min(1, this.amp / 1.5);   // tiny swings don't count
    return this.sync;
  }
}
