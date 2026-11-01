import * as THREE from 'three';

// SPRAY view — five band emitters spray coloured 3D particles toward the viewer.
// Only real heartbeats move it: every onBeat is an emission burst + forward surge, plus a small
// drift that itself decays to rest without beats. No default pace. Still (frozen) unless st.ready
// is 'live'.
// Calm, legible, no glitch/scanline/RGB-split post. See docs/PLAN.md mapping table.

// band order + colours (match HUD)
const BANDS = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
const COLS = {
  delta: [0.54, 0.30, 1.00], theta: [1.00, 0.17, 0.84], alpha: [0.00, 1.00, 0.94],
  beta: [1.00, 0.69, 0.00], gamma: [1.00, 1.00, 1.00],
};

const N = 4000;                 // fixed particle pool

// one soft round sprite, generated once
function softSprite() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class SprayView {
  constructor(canvas) {
    this.canvas = canvas; this.snapReq = false;
    this.relaxS = 0.5; this.focusS = 0.5; this.surge = 0; this.drift = 0; this.aimX = 0; this.aimY = 0;
    this._scratch = new THREE.Vector3();

    const r = this.renderer = new THREE.WebGLRenderer({
      canvas, alpha: false, antialias: true, preserveDrawingBuffer: true,
    });
    r.setClearColor(0x05060a, 1);
    this.pr = Math.min(devicePixelRatio || 1, 2);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05060a, 0.055);
    this.cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    this.cam.position.set(0, 0, 7);

    // five emitters on a gentle arc facing the viewer, at z behind origin
    this.emitters = BANDS.map((b, i) => {
      const a = (i - (BANDS.length - 1) / 2) * 0.62;     // fan angle
      return {
        band: b, col: COLS[b],
        pos: new THREE.Vector3(Math.sin(a) * 3.0, Math.cos(a) * 0.8 - 0.4, -3.2 - Math.cos(a) * 0.8),
        emit: 0,                                          // sub-particle emission accumulator
      };
    });

    // particle pool: typed arrays, BufferGeometry + DynamicDrawUsage
    this.px = new Float32Array(N * 3);        // position
    this.pv = new Float32Array(N * 3);        // velocity
    this.pc = new Float32Array(N * 3);        // base colour
    this.pl = new Float32Array(N);            // life remaining (s)
    this.pL = new Float32Array(N);            // original life (s)
    this.cursor = 0;

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.px, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    this.dispCol = this.colAttr.array;        // per-frame faded colour buffer

    const mat = new THREE.PointsMaterial({
      size: 0.16, map: softSprite(), vertexColors: true, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    this.resize();
    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize);
  }

  spawn(em, R, F, strength) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % N;
    const o = i * 3;
    // slight jitter at the emitter mouth
    this.px[o] = em.pos.x + (Math.random() - 0.5) * 0.2;
    this.px[o + 1] = em.pos.y + (Math.random() - 0.5) * 0.2;
    this.px[o + 2] = em.pos.z + (Math.random() - 0.5) * 0.2;
    // aim: toward the viewer (+z), steered by head tilt; focus tightens, relax widens the cone
    const spread = (0.25 + R * 0.9) * (1.4 - F * 0.9);
    const speed = (2.6 + F * 4.5) * strength;
    const d = this._scratch.set(this.aimX + (Math.random() - 0.5) * spread,
      this.aimY + (Math.random() - 0.5) * spread, 1).normalize();
    this.pv[o] = d.x * speed; this.pv[o + 1] = d.y * speed; this.pv[o + 2] = d.z * speed;
    this.pc[o] = em.col[0]; this.pc[o + 1] = em.col[1]; this.pc[o + 2] = em.col[2];
    const life = (2.4 + R * 3.2) * (1.4 - F * 0.5);        // relax → longer-lived
    this.pl[i] = life; this.pL[i] = life;
  }

  onBeat(strength = 1) {
    const s = Math.max(0, Math.min(1, strength));
    this.surge = Math.min(1.5, this.surge + 0.6 + s * 0.6);   // forward surge (capped, no strobe)
    this.drift = Math.min(0.6, this.drift + 0.2 + s * 0.15);  // small carry-over drift, decays without beats
    const R = this.relaxS, F = this.focusS;
    for (const em of this.emitters) {
      const lvl = this._band(em.band);
      const burst = Math.floor((6 + lvl * 48) * (0.5 + s * 0.8));
      for (let k = 0; k < burst; k++) this.spawn(em, R, F, 1.1 + s * 0.6);
    }
  }

  onBlink() {
    if (this._st?.ready !== 'live') return;
    // a bright quick puff from the two brightest emitters — brief, never full-screen
    const R = this.relaxS, F = this.focusS;
    for (const em of this.emitters) {
      const n = Math.floor(this._band(em.band) * 20);
      for (let k = 0; k < n; k++) this.spawn(em, R, F, 1.4);
    }
  }

  _band(b) { return this._st ? Math.max(0, Math.min(1, this._st.bands[b] || 0)) : 0.3; }

  clear() {
    this.pl.fill(0);
    for (let i = 0; i < N * 3; i++) { this.px[i] = 0; this.dispCol[i] = 0; }
    this.surge = 0; this.drift = 0;
    this.posAttr.needsUpdate = true; this.colAttr.needsUpdate = true;
  }

  frame(st, dt) {
    this._st = st;
    // not live: nothing moves — skip integration and rendering, the canvas keeps its last (or black) image
    if (st.ready !== 'live') { if (this.snapReq) { this.snapReq = false; save(this.canvas); } return; }
    const d = Math.min(0.05, dt || 0.016);
    const relax = st.relax ?? 0.5, focus = st.focus ?? 0.5;
    const ke = Math.min(1, d * 1.2);
    this.relaxS += (relax - this.relaxS) * ke;
    this.focusS += (focus - this.focusS) * ke;
    const R = this.relaxS, F = this.focusS;

    // head tilt aims the spray cone; with the camera on, where you move pulls it too
    const cm = st.camera?.on ? st.camera : null, cw = cm ? Math.min(1, cm.motion * 1.5) : 0;
    const ax = (st.tilt?.x ?? 0) * 0.8 + (cm ? cm.x * cw : 0), ay = (st.tilt?.y ?? 0) * 0.8 + (cm ? cm.y * cw : 0);
    this.aimX = (this.aimX ?? 0) + (ax - (this.aimX ?? 0)) * Math.min(1, d * 4);
    this.aimY = (this.aimY ?? 0) + (ay - (this.aimY ?? 0)) * Math.min(1, d * 4);

    // heart-only motion: beat surge (~0.4s decay) + small drift (~2s decay); both reach rest without beats
    const drift = this.drift * 0.9 + this.surge * 2.2;
    this.surge *= Math.pow(0.02, d);
    this.drift *= Math.pow(0.3, d);
    // emission happens only in onBeat bursts (no continuous spray)

    // integrate pool (no allocations)
    const px = this.px, pv = this.pv, pc = this.pc, pl = this.pl, pL = this.pL, out = this.dispCol;
    const damp = Math.pow(0.45 + R * 0.3, d);              // per-second drag: streams carry into space; relax → gentler
    for (let i = 0; i < N; i++) {
      const o = i * 3;
      if (pl[i] <= 0) {
        if (out[o] !== 0 || out[o + 1] !== 0 || out[o + 2] !== 0) { out[o] = out[o + 1] = out[o + 2] = 0; }
        continue;
      }
      pv[o] *= damp; pv[o + 1] *= damp; pv[o + 2] *= damp;
      px[o] += pv[o] * d;
      px[o + 1] += pv[o + 1] * d;
      px[o + 2] += (pv[o + 2] + drift) * d;                // forward drift paced by heart
      pl[i] -= d;
      // brightness envelope: rise in, fade out — never a hard strobe
      const t = pl[i] / pL[i];
      const env = Math.min(1, t * 3) * (0.25 + t * 0.75);
      out[o] = pc[o] * env; out[o + 1] = pc[o + 1] * env; out[o + 2] = pc[o + 2] * env;
      if (px[o + 2] > 8.5) pl[i] = 0;                       // passed the camera
    }
    this.posAttr.needsUpdate = true; this.colAttr.needsUpdate = true;

    // camera lifts slightly with each beat surge; tilt leans it, no violent motion
    const bob = this.surge * 0.08;
    this.cam.position.x += ((st.tilt?.x ?? 0) * 1.1 - this.cam.position.x) * Math.min(1, d * 3);
    this.cam.position.y += ((st.tilt?.y ?? 0) * 0.8 + bob - this.cam.position.y) * Math.min(1, d * 3);
    this.cam.lookAt(0, 0, -1);

    this.renderer.render(this.scene, this.cam);
    if (this.snapReq) { this.snapReq = false; save(this.canvas); }
  }

  snapshot() { this.snapReq = true; }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setPixelRatio(this.pr);
    this.renderer.setSize(w, h, false);
    this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
  }
}

export function save(canvas) {
  const a = document.createElement('a');
  a.download = `hbi-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  a.href = canvas.toDataURL('image/png'); a.click();
}
