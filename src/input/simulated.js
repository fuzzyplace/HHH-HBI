import { Emitter } from './emitter.js';

const FS = 256;
const F = { delta: 2, theta: 6, alpha: 10, beta: 20, gamma: 38 };
const AMP = { delta: 30, theta: 15, alpha: 20, beta: 8, gamma: 3 };
const PRESETS = {
  calm:  { delta: .5, theta: .6, alpha: 1.6, beta: .3, gamma: .2 },
  focus: { delta: .3, theta: .3, alpha: .5, beta: 1.6, gamma: .9 },
  drift: { delta: 1.4, theta: 1.5, alpha: .8, beta: .3, gamma: .1 },
};

export class SimulatedSource extends Emitter {
  constructor() {
    super();
    this.mode = 'auto';
    this.w = { ...PRESETS.calm };
    this.t = 0; this.ppgT = 0; this.last = 0; this.timer = null;
    this.phase = Array.from({ length: 4 }, () => Object.fromEntries(Object.keys(F).map(k => [k, Math.random() * 6.28])));
    this.nextBlink = 3;
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
        delta: 0.8 + 0.7 * Math.sin(tt * 0.11),
        theta: 0.8 + 0.7 * Math.sin(tt * 0.17 + 1),
        alpha: 0.9 + 0.8 * Math.sin(tt * 0.07 + 2),
        beta:  0.7 + 0.6 * Math.sin(tt * 0.13 + 4),
        gamma: 0.5 + 0.4 * Math.sin(tt * 0.23 + 5),
      };
    } else {
      const p = PRESETS[this.mode];
      for (const k in p) this.w[k] += (p[k] - this.w[k]) * 0.02;
    }
    const blink = tt > this.nextBlink;
    if (blink) this.nextBlink = tt + 2.5 + Math.random() * 5;
    for (let ch = 0; ch < 4; ch++) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = tt + i / FS;
        let v = (Math.random() - 0.5) * 6;
        for (const k in F) v += AMP[k] * this.w[k] * Math.sin(6.2832 * F[k] * t + this.phase[ch][k]);
        if (blink && (ch === 1 || ch === 2) && i < 20) v += 220 * Math.sin((i / 20) * Math.PI);
        out[i] = v;
      }
      this.emit('eeg', { ch, samples: out });
    }
    // PPG @64Hz ~ 68bpm with slow drift
    const np = Math.max(1, Math.round(dt * 64));
    const bpm = 68 + 6 * Math.sin(tt * 0.05);
    const ppg = new Float32Array(np);
    for (let i = 0; i < np; i++) {
      this.ppgT += (bpm / 60) / 64;
      const ph = this.ppgT % 1;
      ppg[i] = Math.exp(-Math.pow((ph - 0.2) / 0.08, 2)) + 0.3 * Math.exp(-Math.pow((ph - 0.5) / 0.1, 2));
    }
    this.emit('ppg', { ch: 0, samples: ppg });
    // motion
    this.emit('accel', { x: 0.15 * Math.sin(tt * 0.4), y: 0.1 * Math.sin(tt * 0.31 + 1), z: 1 });
    this.emit('gyro', { x: 8 * Math.sin(tt * 0.5), y: 12 * Math.sin(tt * 0.35 + 2), z: 6 * Math.sin(tt * 0.2) });
    this.t += n / FS;
  }
}
