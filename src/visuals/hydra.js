import Hydra from 'hydra-synth';
import { save } from './gpu.js';

/** Glitch-synth mode: Hydra feedback chain, fed by the GPU canvas (s0) and brain state. */
export class HydraLayer {
  constructor(srcCanvas, st, flash) {
    this.canvas = Object.assign(document.createElement('canvas'), { id: 'hydra' });
    this.canvas.width = Math.floor(innerWidth * 0.75); this.canvas.height = Math.floor(innerHeight * 0.75);
    document.body.insertBefore(this.canvas, document.getElementById('hud'));
    this.h = new Hydra({ canvas: this.canvas, autoLoop: false, makeGlobal: false, detectAudio: false, width: this.canvas.width, height: this.canvas.height });
    const { src, noise, osc, s0, o0, o1, render } = this.h.synth;
    s0.init({ src: srcCanvas, dynamic: true });
    const b = st.bands;
    // dominant drivers (heartbeat forward-zoom arrives through s0, which samples the GPU canvas)
    const F = () => st.focus ?? 0.5, R = () => st.relax ?? 0.5;
    src(o0)
      .scale(() => 1.004 + b.delta * 0.008)                                          // delta = secondary
      .rotate(() => st.gyro.z * 0.0003)
      .modulate(noise(() => 2 + b.theta * 3 + F() * 5, 0.1), () => 0.002 + F() * 0.012)   // focus = turbulence
      .hue(() => 0.002 + b.gamma * 0.01)                                             // gamma = secondary
      .brightness(() => -0.01 - R() * 0.025 - F() * 0.015)                           // relax = longer, darker trails
      .layer(src(s0).luma(0.12, 0.05))
      .modulateScrollX(noise(() => 1 + F() * 30, 0.6).thresh(0.6, 0).pixelate(1, () => 24 + F() * 80), () => F() * 0.05 + flash() * 0.25)  // focus = glitch tear
      .out(o0);
    src(o0).color(1, 0, 0).scrollX(() => 0.002 + F() * 0.006 + flash() * 0.03)       // focus = RGB split
      .add(src(o0).color(0, 1, 1).scrollX(() => -0.002 - F() * 0.006 - flash() * 0.03))
      .posterize(() => 48 - F() * 40, 0.8)
      .out(o1);
    render(o1);
    this.on = false; this.canvas.style.display = 'none';
  }
  toggle() { this.on = !this.on; this.canvas.style.display = this.on ? 'block' : 'none'; return this.on; }
  tick(dt) { if (this.on) this.h.tick(dt * 1000); }
  snapshot() { save(this.canvas); }
}
