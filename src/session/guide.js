// Guided session: eyes open (30s) → eyes closed (N min) → eyes open (30s).
// A falling countdown (5…1, one tone per second) leads into eyes-closed; rising tones (1…5) count you back
// out, then a chime means "open your eyes". Pure timing — main.js renders the banner and plays the tones.

export const OPEN_S = 30, COUNT = 5;

export class SessionGuide {
  constructor() { this.on = false; }
  start(closedMin, now) {
    this.on = true; this.closedS = closedMin * 60; this.t0 = now; this.lastSec = -1; this.chimed = false; this.closedCue = false;
    this.plan = [{ phase: 'open', dur: OPEN_S }, { phase: 'closed', dur: this.closedS }, { phase: 'open2', dur: OPEN_S }];
    this.total = OPEN_S * 2 + this.closedS;
  }
  stop() { this.on = false; }
  /**
   * advance to `now` (ms). Returns a view of what to show/play:
   * { phase, phaseIndex, left (s in phase), progress (0..1 phase), count (number|null), tone: null|{kind, n}, done }
   */
  step(now, out = {}) {
    const el = (now - this.t0) / 1000;
    let acc = 0, k = 0;
    while (k < 2 && el >= acc + this.plan[k].dur) acc += this.plan[k++].dur;
    const p = this.plan[k], inPh = el - acc, left = Math.max(0, p.dur - inPh);
    out.phase = p.phase; out.phaseIndex = k; out.left = left; out.progress = Math.min(1, inPh / p.dur);
    out.done = el >= this.total; out.count = null; out.tone = null;
    const sec = Math.floor(el);
    const fresh = sec !== this.lastSec; this.lastSec = sec;
    if (p.phase === 'open' && left <= COUNT) {           // 5…1 → close your eyes
      out.count = Math.ceil(left);
      if (fresh && out.count >= 1) out.tone = { kind: 'down', n: out.count };
    } else if (p.phase === 'closed' && left <= COUNT) {  // 1…5 counting up → open your eyes
      out.count = Math.min(COUNT, Math.floor(COUNT - left) + 1);
      if (fresh) out.tone = { kind: 'up', n: out.count };
    }
    if (fresh && k === 2 && Math.floor(inPh) === 0 && !this.chimed) { out.tone = { kind: 'open' }; this.chimed = true; }
    if (k === 1 && fresh && Math.floor(inPh) === 0 && !this.closedCue) { out.tone = { kind: 'closed' }; this.closedCue = true; }
    return out;
  }
}
