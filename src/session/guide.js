// The practice: arrive (30s, eyes open) → breathe (follow the machine's breath) → rest (eyes closed) → return (30s).
// Breathe and rest share the rest of the chosen length equally. A falling count (5…1, one tone per second) leads into
// rest, a low bell marks eyes closed, a rising count (1…5) brings you back and a chime means "open your eyes".
// Pure timing — main.js renders the captions and plays the tones.

export const PHASES = ['arrive', 'breathe', 'rest', 'return'];
export const EDGE_S = 30, COUNT = 5;

export class SessionGuide {
  constructor() { this.on = false; }
  /** totalMin: whole practice length in minutes (≥ 2) */
  start(totalMin, now) {
    const mid = Math.max(30, (totalMin * 60 - 2 * EDGE_S) / 2);
    this.on = true; this.t0 = now; this.lastSec = -1; this.cued = new Set();
    this.plan = [EDGE_S, mid, mid, EDGE_S].map((dur, k) => ({ phase: PHASES[k], dur }));
    this.total = this.plan.reduce((a, p) => a + p.dur, 0);
    this.minutes = totalMin;
  }
  stop() { this.on = false; }
  /**
   * advance to `now` (ms). Returns what to show/play:
   * { phase, phaseIndex, left (s in phase), progress (0..1 phase), total (0..1 whole), count (number|null), tone, done }
   * tone: null | { kind: 'begin' | 'down' | 'closed' | 'up' | 'open', n }
   */
  step(now, out = {}) {
    const el = (now - this.t0) / 1000, last = this.plan.length - 1;
    let acc = 0, k = 0;
    while (k < last && el >= acc + this.plan[k].dur) acc += this.plan[k++].dur;
    const p = this.plan[k], inPh = el - acc, left = Math.max(0, p.dur - inPh);
    out.phase = p.phase; out.phaseIndex = k; out.left = left; out.progress = Math.min(1, inPh / p.dur);
    out.total = Math.min(1, el / this.total); out.done = el >= this.total; out.count = null; out.tone = null;
    const sec = Math.floor(el), fresh = sec !== this.lastSec;
    this.lastSec = sec;
    if (p.phase === 'breathe' && left <= COUNT) {        // 5…1 → close your eyes
      out.count = Math.ceil(left);
      if (fresh && out.count >= 1) out.tone = { kind: 'down', n: out.count };
    } else if (p.phase === 'rest' && left <= COUNT) {    // 1…5 counting up → open your eyes
      out.count = Math.min(COUNT, Math.floor(COUNT - left) + 1);
      if (fresh) out.tone = { kind: 'up', n: out.count };
    }
    const START = { breathe: 'begin', rest: 'closed', return: 'open' }[p.phase];   // one cue as each phase begins
    if (START && fresh && !this.cued.has(k)) { this.cued.add(k); out.tone = { kind: START, n: 1 }; }
    return out;
  }
}
