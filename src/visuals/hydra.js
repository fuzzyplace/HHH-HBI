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
    src(o0)
      .scale(() => 1.004 + b.delta * 0.012)
      .rotate(() => st.gyro.z * 0.0003)
      .modulate(noise(() => 2 + b.theta * 6, 0.1), () => 0.002 + b.theta * 0.012)
      .hue(() => 0.002 + b.gamma * 0.01)
      .brightness(() => -0.015 - b.beta * 0.03)
      .layer(src(s0).luma(0.12, 0.05))
      .modulateScrollX(noise(() => 1 + b.beta * 30, 0.6).thresh(0.6, 0).pixelate(1, () => 24 + b.beta * 80), () => b.beta * 0.05 + flash() * 0.25)
      .out(o0);
    src(o0).color(1, 0, 0).scrollX(() => 0.002 + b.beta * 0.006 + flash() * 0.03)
      .add(src(o0).color(0, 1, 1).scrollX(() => -0.002 - b.beta * 0.006 - flash() * 0.03))
      .posterize(() => 48 - b.beta * 40, 0.8)
      .out(o1);
    render(o1);
    this.on = false; this.canvas.style.display = 'none';
  }
  toggle() { this.on = !this.on; this.canvas.style.display = this.on ? 'block' : 'none'; return this.on; }
  tick(dt) { if (this.on) this.h.tick(dt * 1000); }
  snapshot() { save(this.canvas); }
}
