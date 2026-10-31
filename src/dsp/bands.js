export const FS = 256, N = 256;
export const BANDS = { delta: [1, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 44] };
export const BAND_NAMES = Object.keys(BANDS);

const hann = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

export class BandAnalyzer {
  constructor(channels = 4) {
    this.buf = Array.from({ length: channels }, () => new Float32Array(N));
    this.pos = new Array(channels).fill(0);
    this.re = new Float32Array(N); this.im = new Float32Array(N);
  }
  push(ch, samples) {
    const b = this.buf[ch];
    for (let i = 0; i < samples.length; i++) { b[this.pos[ch]] = samples[i]; this.pos[ch] = (this.pos[ch] + 1) % N; }
  }
  /** peak-to-peak over last n samples (artifact/blink detection) */
  p2p(ch, n = 64) {
    const b = this.buf[ch]; let lo = Infinity, hi = -Infinity;
    for (let i = 1; i <= n; i++) { const v = b[(this.pos[ch] - i + N) % N]; if (v < lo) lo = v; if (v > hi) hi = v; }
    return hi - lo;
  }
  /** relative band power per channel + average */
  compute() {
    const channels = [];
    const avg = Object.fromEntries(BAND_NAMES.map(k => [k, 0]));
    for (let ch = 0; ch < this.buf.length; ch++) {
      const b = this.buf[ch], p = this.pos[ch];
      let mean = 0;
      for (let i = 0; i < N; i++) mean += b[i];
      mean /= N;
      for (let i = 0; i < N; i++) { this.re[i] = (b[(p + i) % N] - mean) * hann[i]; this.im[i] = 0; }
      fft(this.re, this.im);
      const pw = {}; let total = 0;
      for (const k of BAND_NAMES) {
        const [lo, hi] = BANDS[k]; let s = 0;
        for (let bin = Math.ceil((lo * N) / FS); bin < (hi * N) / FS; bin++) s += this.re[bin] ** 2 + this.im[bin] ** 2;
        pw[k] = s; total += s;
      }
      const rel = {};
      for (const k of BAND_NAMES) { rel[k] = total > 0 ? pw[k] / total : 0; avg[k] += rel[k] / this.buf.length; }
      channels.push(rel);
    }
    return { channels, avg };
  }
}

/** Adaptive per-band normalizer → 0..1 with slow range decay */
export class Normalizer {
  constructor(decay = 0.9985) { this.lo = {}; this.hi = {}; this.decay = decay; }
  apply(rel) {
    const out = {};
    for (const k of BAND_NAMES) {
      const v = rel[k];
      this.lo[k] = this.lo[k] === undefined ? v - 0.05 : Math.min(v, this.lo[k] + (this.hi[k] - this.lo[k]) * (1 - this.decay));
      this.hi[k] = this.hi[k] === undefined ? v + 0.05 : Math.max(v, this.hi[k] - (this.hi[k] - this.lo[k]) * (1 - this.decay));
      out[k] = Math.min(1, Math.max(0, (v - this.lo[k]) / Math.max(0.02, this.hi[k] - this.lo[k])));
    }
    return out;
  }
}
