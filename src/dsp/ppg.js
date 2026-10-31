/** Peak-detect heart rate from PPG ch0 (64Hz). Calls onBeat() per detected beat. */
export class HeartRate {
  constructor(onBeat) {
    this.onBeat = onBeat; this.bpm = 0; this.mean = 0; this.prev = 0; this.prev2 = 0;
    this.t = 0; this.lastBeat = -1; this.ibis = [];
  }
  push(samples) {
    for (const s of samples) {
      this.t += 1 / 64;
      this.mean += (s - this.mean) * 0.02;
      const d = s - this.mean;
      if (this.prev > this.prev2 && this.prev >= d && this.prev > 0.15 * Math.abs(this.mean || 1) && this.t - this.lastBeat > 0.33) {
        if (this.lastBeat > 0) {
          const ibi = this.t - this.lastBeat;
          if (ibi < 1.5) { this.ibis.push(ibi); if (this.ibis.length > 8) this.ibis.shift(); this.bpm = 60 / (this.ibis.reduce((a, b) => a + b) / this.ibis.length); }
        }
        this.lastBeat = this.t; this.onBeat?.();
      }
      this.prev2 = this.prev; this.prev = d;
    }
  }
}
