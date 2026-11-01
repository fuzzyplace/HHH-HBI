// Camera features from tiny RGBA frames (e.g. 64×48). Pure math, no DOM: camera.js grabs frames, this turns them
// into a few normalized numbers. Frames are never stored or sent; only these numbers reach `state.camera`.
//
//   motion 0..1   how much moved since the last frame (frame difference above an adaptive noise floor)
//   x, y  -1..1   where the movement is (mirrored like a selfie view: your right hand moves to the right; y up)
//   vx, vy        how fast that spot is travelling (units/s, smoothed)
//   light 0..1    overall brightness of the room

const ease = (dt, tau) => 1 - Math.exp(-dt / tau);
const DIFF_FLOOR = 6;       // luma steps (0..255) below this are sensor noise, never motion
const FULL_MOTION = 0.05;   // mean above-floor difference (fraction of 255) that reads as full motion
const TAU_MOTION = 0.25, TAU_POS = 0.2, TAU_VEL = 0.3, TAU_LIGHT = 1.5, TAU_NOISE = 4;

export class VisionFeatures {
  constructor() { this.prev = null; this.reset(); }
  reset() {
    this.prev = null; this.noise = 0;
    this.out = { motion: 0, x: 0, y: 0, vx: 0, vy: 0, light: 0 };
  }
  /** rgba: Uint8ClampedArray w*h*4; dt seconds since the previous frame. Returns this.out (reused object). */
  update(rgba, w, h, dt) {
    const n = w * h, o = this.out;
    if (!this.prev || this.prev.length !== n) { this.prev = new Uint8Array(n); this._luma(rgba, n, this.prev); return o; }
    let sum = 0, sx = 0, sy = 0, lsum = 0;
    const prev = this.prev;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const l = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
      lsum += l;
      const d = Math.abs(l - prev[i]) - DIFF_FLOOR - this.noise;
      prev[i] = l;
      if (d > 0) { sum += d; const x = i % w, y = (i / w) | 0; sx += d * x; sy += d * y; }
    }
    const mean = sum / n / 255;
    // a slowly learned extra floor: steady flicker or a noisy sensor stops reading as movement after a few seconds
    this.noise += (Math.min(20, mean * 255 * 0.5) - this.noise) * ease(dt, TAU_NOISE) * (mean < FULL_MOTION * 0.3 ? 1 : 0);
    const m = Math.min(1, mean / FULL_MOTION);
    o.motion += (m - o.motion) * ease(dt, TAU_MOTION);
    o.light += (lsum / n / 255 - o.light) * ease(dt, TAU_LIGHT);
    if (sum > 0 && m > 0.02) {
      const nx = -((sx / sum) / (w - 1) * 2 - 1), ny = -((sy / sum) / (h - 1) * 2 - 1);   // mirrored x, y up
      const px = o.x, py = o.y, k = ease(dt, TAU_POS);
      o.x += (nx - o.x) * k; o.y += (ny - o.y) * k;
      const kv = ease(dt, TAU_VEL);
      o.vx += ((o.x - px) / Math.max(dt, 1e-3) - o.vx) * kv; o.vy += ((o.y - py) / Math.max(dt, 1e-3) - o.vy) * kv;
    } else { const kv = ease(dt, TAU_VEL); o.vx -= o.vx * kv; o.vy -= o.vy * kv; }
    return o;
  }
  _luma(rgba, n, out) { for (let i = 0, p = 0; i < n; i++, p += 4) out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8; }
}
