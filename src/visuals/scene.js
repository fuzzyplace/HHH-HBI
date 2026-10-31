const TAU = Math.PI * 2;
const HUE = { delta: 265, theta: 305, alpha: 185, beta: 38, gamma: 0 };
// node layout: 0=TP9 bottom-left, 1=AF7 top-left, 2=AF8 top-right, 3=TP10 bottom-right
const NODES = [[-0.55, 0.45], [-0.4, -0.45], [0.4, -0.45], [0.55, 0.45]];

export class Scene {
  constructor(canvas) {
    this.c = canvas; this.g = canvas.getContext('2d');
    this.t = 0; this.rot = 0; this.flash = 0; this.sparks = []; this.rings = [];
    this.resize(); addEventListener('resize', () => this.resize());
  }
  resize() {
    const d = Math.min(devicePixelRatio || 1, 2);
    this.c.width = innerWidth * d; this.c.height = innerHeight * d;
    this.w = this.c.width; this.h = this.c.height; this.s = Math.min(this.w, this.h) / 2;
    this.g.fillStyle = '#05000f'; this.g.fillRect(0, 0, this.w, this.h);
  }
  clear() { this.g.fillStyle = '#05000f'; this.g.fillRect(0, 0, this.w, this.h); }
  onBeat() { this.rings.push({ r: 0, a: 0.8 }); }
  onBlink() { this.flash = 1; }
  frame(st, dt) {
    const g = this.g, { w, h, s } = this, b = st.bands;
    this.t += dt; this.rot += st.gyro.z * dt * 0.002;
    this.flash *= Math.pow(0.002, dt);
    // trail fade: beta = shorter memory (more refresh)
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = `rgba(5,0,15,${0.035 + 0.06 * b.beta})`; g.fillRect(0, 0, w, h);
    g.save();
    g.translate(w / 2 + st.tilt.x * s * 0.3, h / 2 + st.tilt.y * s * 0.3);
    g.rotate(this.rot);
    g.globalCompositeOperation = 'lighter';

    // delta nebula
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, s * (0.5 + 0.9 * b.delta));
    rg.addColorStop(0, `hsla(${HUE.delta},90%,40%,${0.05 + 0.12 * b.delta})`); rg.addColorStop(1, 'hsla(265,90%,10%,0)');
    g.fillStyle = rg; g.fillRect(-w, -h, w * 2, h * 2);

    // theta ribbons
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      for (let i = -40; i <= 40; i++) {
        const x = (i / 40) * s * 1.2, y = Math.sin(i * 0.18 + this.t * (0.6 + b.theta) + k * 2) * s * (0.08 + 0.3 * b.theta) * Math.cos(this.t * 0.2 + k);
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
    // heartbeat rings
    for (const r of this.rings) { r.r += dt * s * 0.8; r.a *= Math.pow(0.1, dt); g.beginPath(); g.arc(0, 0, r.r, 0, TAU); g.strokeStyle = `rgba(255,60,120,${r.a})`; g.lineWidth = 2; g.stroke(); }
    this.rings = this.rings.filter(r => r.a > 0.02);

    // channel lobes + gamma sparks
    st.ch.forEach((cb, i) => {
      let dom = 'alpha', mx = -1;
      for (const k in cb) if (cb[k] > mx) { mx = cb[k]; dom = k; }
      const [nx, ny] = NODES[i], x = nx * s, y = ny * s, rad = s * (0.08 + 0.2 * mx);
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `hsla(${HUE[dom]},100%,65%,0.7)`); gr.addColorStop(1, `hsla(${HUE[dom]},100%,50%,0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
      if (Math.random() < b.gamma * 0.6) this.sparks.push({ x, y, vx: (Math.random() - 0.5) * s * 0.6, vy: (Math.random() - 0.5) * s * 0.6, l: 1 });
    });
    for (const p of this.sparks) { p.x += p.vx * dt; p.y += p.vy * dt; p.l -= dt * 0.8; g.fillStyle = `rgba(255,255,255,${p.l})`; g.fillRect(p.x, p.y, 2, 2); }
    this.sparks = this.sparks.filter(p => p.l > 0).slice(-600);

    g.restore();

    // beta glitch scanlines (screen space)
    g.globalCompositeOperation = 'lighter';
    const n = Math.floor(b.beta * 8);
    for (let i = 0; i < n; i++) {
      g.fillStyle = `hsla(${HUE.beta},100%,55%,${0.05 + 0.15 * Math.random()})`;
      g.fillRect(Math.random() * w, Math.random() * h, Math.random() * w * 0.3, 1 + Math.random() * 2);
    }
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
