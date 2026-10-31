const TAU = Math.PI * 2;
const HUE = { delta: 265, theta: 305, alpha: 185, beta: 38, gamma: 0 };
// node layout: 0=TP9 bottom-left, 1=AF7 top-left, 2=AF8 top-right, 3=TP10 bottom-right
const NODES = [[-0.55, 0.45], [-0.4, -0.45], [0.4, -0.45], [0.55, 0.45]];

export class Scene {
  constructor(canvas) {
    this.c = canvas; this.g = canvas.getContext('2d');
    this.t = 0; this.rot = 0; this.flash = 0; this.sparks = []; this.rings = [];
    this.beat = 0; this.relaxS = 0.5; this.focusS = 0.5;   // dominant drivers (match GPU scene)
    this.resize(); addEventListener('resize', () => this.resize());
  }
  resize() {
    const d = Math.min(devicePixelRatio || 1, 2);
    this.c.width = innerWidth * d; this.c.height = innerHeight * d;
    this.w = this.c.width; this.h = this.c.height; this.s = Math.min(this.w, this.h) / 2;
    this.g.fillStyle = '#05000f'; this.g.fillRect(0, 0, this.w, this.h);
  }
  clear() { this.g.fillStyle = '#05000f'; this.g.fillRect(0, 0, this.w, this.h); }
  onBeat() { this.beat = 1; this.rings.push({ r: 0, a: 0.9 }); }   // heartbeat: forward zoom surge + brightness + ring
  onBlink() { this.flash = 1; }
  frame(st, dt) {
    if (st.ready !== 'live') return;   // still until synced + calibrated (2D fallback for PAINT)
    this.drift = (this.drift || 0) * Math.pow(0.35, dt); if (this.beat > 0.5) this.drift = Math.min(1, this.drift + dt * 4);
    const flow = Math.min(1, this.beat + this.drift);
    const g = this.g, { w, h, s } = this, b = st.bands;
    const relax = st.relax ?? 0.5, focus = st.focus ?? 0.5;
    const ke = Math.min(1, dt * 1.2);
    this.relaxS += (relax - this.relaxS) * ke; this.focusS += (focus - this.focusS) * ke;
    const R = this.relaxS, F = this.focusS;
    this.t += dt * flow; this.rot += st.gyro.z * dt * 0.002;   // ribbons/rings advance only with heart motion
    this.flash *= Math.pow(0.002, dt);
    this.beat *= Math.pow(0.006, dt);                     // ~0.4s decay
    // (1) RELAX → trail length: calm = longer memory (smaller fade)
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = `rgba(5,0,15,${0.02 + (1 - R) * 0.06})`; g.fillRect(0, 0, w, h);
    // (1) RELAX → palette wash: calm cyan/violet (hue~210) ↔ hot amber/magenta (hue~30), non-strobing
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = `hsla(${30 + R * 180},100%,50%,0.025)`; g.fillRect(0, 0, w, h);
    g.save();
    // head tilt AIMS the field; (3) heartbeat zooms the whole field forward
    const z = 1 + this.beat * 0.12;
    g.translate(w / 2 + st.tilt.x * s * 0.5, h / 2 + st.tilt.y * s * 0.5);
    g.rotate(this.rot); g.scale(z, z);
    g.globalCompositeOperation = 'lighter';

    // delta nebula
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, s * (0.5 + 0.9 * b.delta));
    rg.addColorStop(0, `hsla(${HUE.delta},90%,40%,${0.05 + 0.12 * b.delta})`); rg.addColorStop(1, 'hsla(265,90%,10%,0)');
    g.fillStyle = rg; g.fillRect(-w, -h, w * 2, h * 2);

    // theta ribbons
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      for (let i = -40; i <= 40; i++) {
        const x = (i / 40) * s * 1.2, y = Math.sin(i * 0.18 + this.t * (0.6 + b.theta + F * 0.8) + k * 2) * s * (0.08 + 0.3 * b.theta) * (1 + F * 0.4) * Math.cos(this.t * 0.2 + k);
        i === -40 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.strokeStyle = `hsla(${HUE.theta + k * 12},100%,60%,${0.1 + 0.4 * b.theta})`; g.lineWidth = 1 + 2 * b.theta; g.stroke();
    }

    // alpha rings
    const nr = 3 + Math.round(b.alpha * 5);
    for (let i = 0; i < nr; i++) {
      const r = s * (0.12 + i * 0.1) * (1 + 0.05 * Math.sin(this.t * 0.8 + i));
      g.beginPath(); g.arc(0, 0, r, 0, TAU);
      g.strokeStyle = `hsla(${HUE.alpha},100%,60%,${0.05 + 0.3 * b.alpha})`; g.lineWidth = 1 + b.alpha * 2; g.stroke();
    }
    // (3) heartbeat rings — brighter/thicker, surge outward on the beat
    for (const r of this.rings) { r.r += dt * s * (0.8 + this.beat * 1.2); r.a *= Math.pow(0.1, dt); g.beginPath(); g.arc(0, 0, r.r, 0, TAU); g.strokeStyle = `rgba(255,60,120,${r.a})`; g.lineWidth = 2 + this.beat * 4; g.stroke(); }
    this.rings = this.rings.filter(r => r.a > 0.02);

    // channel lobes + (2) focus-driven sparks (paint emitted where the field is aimed)
    st.ch.forEach((cb, i) => {
      let dom = 'alpha', mx = -1;
      for (const k in cb) if (cb[k] > mx) { mx = cb[k]; dom = k; }
      const [nx, ny] = NODES[i], x = nx * s, y = ny * s, rad = s * (0.08 + 0.2 * mx);
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `hsla(${HUE[dom]},100%,65%,0.7)`); gr.addColorStop(1, `hsla(${HUE[dom]},100%,50%,0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
      if (Math.random() < 0.08 + F * 0.5) this.sparks.push({ x, y, vx: (Math.random() - 0.5) * s * 0.6, vy: (Math.random() - 0.5) * s * 0.6, l: 1 });
    });
    for (const p of this.sparks) { p.x += p.vx * dt; p.y += p.vy * dt; p.l -= dt * 0.8; g.fillStyle = `rgba(255,255,255,${p.l})`; g.fillRect(p.x, p.y, 2, 2); }
    this.sparks = this.sparks.filter(p => p.l > 0).slice(-600);

    g.restore();

    // (2) FOCUS glitch scanlines (screen space) — smooth when low, energetic when high
    g.globalCompositeOperation = 'lighter';
    const n = Math.floor(F * 10);
    for (let i = 0; i < n; i++) {
      g.fillStyle = `hsla(${HUE.beta},100%,55%,${0.05 + 0.15 * Math.random()})`;
      g.fillRect(Math.random() * w, Math.random() * h, Math.random() * w * 0.3, 1 + Math.random() * 2);
    }
    // (3) heartbeat brightness swell — capped additive wash (max ~0.16 alpha), never a strobe
    if (this.beat > 0.01) { g.fillStyle = `rgba(120,230,255,${this.beat * 0.16})`; g.fillRect(0, 0, w, h); }
    // blink / clench flash
    if (this.flash > 0.02) { g.fillStyle = `rgba(0,255,230,${this.flash * 0.25})`; g.fillRect(0, 0, w, h); g.fillStyle = `rgba(255,0,150,${this.flash * 0.12})`; g.fillRect(8, 0, w, h); }
    g.globalCompositeOperation = 'source-over';
  }
  snapshot() {
    const a = document.createElement('a');
    a.download = `hbi-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.href = this.c.toDataURL('image/png'); a.click();
  }
}
