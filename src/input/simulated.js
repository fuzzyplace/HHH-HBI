import { Emitter } from './emitter.js';

const FS = 256;
const F = { delta: 2, theta: 6, alpha: 10, beta: 20, gamma: 38 };
const AMP = { delta: 30, theta: 15, alpha: 20, beta: 8, gamma: 3 };
// contrasts sized like real recordings (eyes closed vs open ≈ 5–9 dB on alpha vs beta), not cartoon extremes
const PRESETS = {
  calm:  { delta: .9, theta: 1.0, alpha: 1.4, beta: .8, gamma: .7 },   // ≈ eyes closed, relaxed
  focus: { delta: .8, theta: .8, alpha: .75, beta: 1.2, gamma: 1.0 },  // ≈ eyes open, engaged
  drift: { delta: 1.3, theta: 1.3, alpha: .9, beta: .7, gamma: .6 },   // ≈ drowsy
};
const PINK_UV = 9;   // broadband 1/f background every real EEG has (µV rms, approx.)

export class SimulatedSource extends Emitter {
  constructor() {
    super();
    this.mode = 'auto';
    this.w = { ...PRESETS.calm };
    this.t = 0; this.ppgT = 0; this.last = 0; this.timer = null;
    this.phase = Array.from({ length: 4 }, () => Object.fromEntries(Object.keys(F).map(k => [k, Math.random() * 6.28])));
    this.nextBlink = 3;
    this.pink = Array.from({ length: 4 }, () => new Float64Array(3));   // Kellet economy pink-noise filter state
  }
  setMode(m) { this.mode = m; }
  start() {
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), 40);
    this.emit('battery', 100);
  }
  stop() { clearInterval(this.timer); }
  tick() {
    const now = performance.now();
    const dt = (now - this.last) / 1000; this.last = now;
    const n = Math.max(1, Math.round(dt * FS));
    const tt = this.t;
    if (this.mode === 'auto') {
      this.w = {
        delta: 1.0 + 0.25 * Math.sin(tt * 0.11),
        theta: 1.0 + 0.25 * Math.sin(tt * 0.17 + 1),
        alpha: 1.05 + 0.35 * Math.sin(tt * 0.07 + 2),
        beta:  1.0 + 0.2 * Math.sin(tt * 0.13 + 4),
        gamma: 0.85 + 0.15 * Math.sin(tt * 0.23 + 5),
      };
    } else {
      const p = PRESETS[this.mode];
      for (const k in p) this.w[k] += (p[k] - this.w[k]) * 0.02;
    }
    const blink = tt > this.nextBlink;
    if (blink) this.nextBlink = tt + 2.5 + Math.random() * 5;
    for (let ch = 0; ch < 4; ch++) {
      const out = new Float32Array(n), pk = this.pink[ch];
      for (let i = 0; i < n; i++) {
        const t = tt + i / FS, wn = Math.random() * 2 - 1;
        pk[0] = 0.99765 * pk[0] + wn * 0.099046; pk[1] = 0.963 * pk[1] + wn * 0.2965164; pk[2] = 0.57 * pk[2] + wn * 1.0526913;
        let v = (pk[0] + pk[1] + pk[2] + wn * 0.1848) * PINK_UV * 0.45;
        for (const k in F) v += AMP[k] * this.w[k] * Math.sin(6.2832 * F[k] * t + this.phase[ch][k]);
        if (blink && (ch === 1 || ch === 2) && i < 20) v += 400 * Math.sin((i / 20) * Math.PI);
        out[i] = v;
      }
      this.emit('eeg', { ch, samples: out });
    }
    // PPG @64Hz, shaped like muse-js raw output: 0 ambient (no pulse), 1 infrared, 2 red —
    // a large unsigned level with a small pulse that dips on each beat, plus slow drift and noise
    const np = Math.max(1, Math.round(dt * 64));
    const bpm = 68 + 6 * Math.sin(tt * 0.05);
    const ppg = [new Float32Array(np), new Float32Array(np), new Float32Array(np)];
    for (let i = 0; i < np; i++) {
      this.ppgT += (bpm / 60) / 64;
      const ph = this.ppgT % 1, drift = 1500 * Math.sin(this.ppgT * 0.07);
      const pulse = Math.exp(-Math.pow((ph - 0.2) / 0.08, 2)) + 0.3 * Math.exp(-Math.pow((ph - 0.5) / 0.1, 2));
      ppg[0][i] = 20000 + 60 * (Math.random() - 0.5);
      ppg[1][i] = 150000 + drift - 450 * pulse + 40 * (Math.random() - 0.5);
      ppg[2][i] = 90000 + drift * 0.6 - 160 * pulse + 50 * (Math.random() - 0.5);
    }
    for (let c = 0; c < 3; c++) this.emit('ppg', { ch: c, samples: ppg[c] });
    // motion
    this.emit('accel', { x: 0.15 * Math.sin(tt * 0.4), y: 0.1 * Math.sin(tt * 0.31 + 1), z: 1 });
    this.emit('gyro', { x: 8 * Math.sin(tt * 0.5), y: 12 * Math.sin(tt * 0.35 + 2), z: 6 * Math.sin(tt * 0.2) });
    this.t += n / FS;
  }
}
