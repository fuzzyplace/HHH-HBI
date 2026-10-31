import * as THREE from 'three';

// ORBS view — five glowing band-coloured orbs swirl around a centre in 3D orbits.
// Each orb's size/glow modulate with its band; the heartbeat paces the swirl:
// angular advance surges on each beat and eases out over the beat period (via st.beatPhase),
// so the orbit visibly breathes with the pulse. Calm, legible, no glitch/scanline post.
// See docs/PLAN.md mapping table.

const BANDS = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
const COLS = {
  delta: [0.54, 0.30, 1.00], theta: [1.00, 0.17, 0.84], alpha: [0.00, 1.00, 0.94],
  beta: [1.00, 0.69, 0.00], gamma: [1.00, 1.00, 1.00],
};
const TRAIL = 48;                     // trail points per orb (ring buffer)
const DEF_PACE = 50 / 60;             // default breathing pace when no heart lock

function softSprite() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class OrbsView {
  constructor(canvas) {
    this.canvas = canvas; this.snapReq = false;
    this.relaxS = 0.5; this.focusS = 0.5; this.surge = 0; this.extraAngle = 0;

    const r = this.renderer = new THREE.WebGLRenderer({
      canvas, alpha: false, antialias: true, preserveDrawingBuffer: true,
    });
    r.setClearColor(0x05060a, 1);
    this.pr = Math.min(devicePixelRatio || 1, 2);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05060a, 0.04);
    this.cam = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
    this.cam.position.set(0, 0, 9);
    this.cam.lookAt(0, 0, 0);

    // group holds everything so head tilt can lean the whole orbital plane
    this.group = new THREE.Group(); this.scene.add(this.group);

    const tex = softSprite();
    // faint centre core
    const core = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: 0x1b2740, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    core.scale.setScalar(1.4); this.group.add(core);

    this.orbs = BANDS.map((b, i) => {
      const col = new THREE.Color(COLS[b][0], COLS[b][1], COLS[b][2]);
      const mat = new THREE.SpriteMaterial({
        map: tex, color: col.clone(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(mat); this.group.add(sprite);

      // trail: additive Points ring buffer, faded by age
      const tg = new THREE.BufferGeometry();
      const tpos = new Float32Array(TRAIL * 3);
      const tcol = new Float32Array(TRAIL * 3);
      const pa = new THREE.BufferAttribute(tpos, 3).setUsage(THREE.DynamicDrawUsage);
      const ca = new THREE.BufferAttribute(tcol, 3).setUsage(THREE.DynamicDrawUsage);
      tg.setAttribute('position', pa); tg.setAttribute('color', ca);
      const tmat = new THREE.PointsMaterial({
        size: 0.22, map: tex, vertexColors: true, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
      });
      const trail = new THREE.Points(tg, tmat); trail.frustumCulled = false; this.group.add(trail);

      return {
        band: b, baseCol: COLS[b], sprite, mat,
        radius: 2.0 + i * 0.8,                     // nested orbits
        incl: (i - 2) * 0.33,                      // orbital-plane inclination
        angle: (i / BANDS.length) * Math.PI * 2,   // orbit phase
        wobbleSeed: i * 1.7,
        tpos, tcol, pa, ca, thead: 0,
      };
    });

    this._tmp = new THREE.Vector3();
    this.resize();
    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize);
  }

  _band(b) { return this._st ? Math.max(0, Math.min(1, this._st.bands[b] || 0)) : 0.3; }

  onBeat(strength = 1) {
    const s = Math.max(0, Math.min(1, strength));
    this.surge = Math.min(1.4, this.surge + 0.5 + s * 0.6);   // angular + glow surge (capped)
  }

  onBlink() { this.surge = Math.min(1.4, this.surge + 0.35); }

  clear() {
    this.surge = 0; this.extraAngle = 0;
    for (const o of this.orbs) {
      o.tpos.fill(0); o.tcol.fill(0); o.thead = 0;
      o.pa.needsUpdate = true; o.ca.needsUpdate = true;
    }
  }

  frame(st, dt) {
    this._st = st;
    const d = Math.min(0.05, dt || 0.016);
    const relax = st.relax ?? 0.5, focus = st.focus ?? 0.5;
    const ke = Math.min(1, d * 1.2);
    this.relaxS += (relax - this.relaxS) * ke;
    this.focusS += (focus - this.focusS) * ke;
    const R = this.relaxS, F = this.focusS;

    // heartbeat pace drives the swirl. Base angular rate from bpm; a surge rides each beat,
    // eased out across the beat period using beatPhase so motion stays continuous and in time.
    const pace = (st.beatConf > 0 && st.bpm > 0 ? st.bpm / 60 : DEF_PACE);
    const bp = st.beatConf > 0 ? st.beatPhase ?? 0 : 0;
    const beatEase = (1 - bp) * (1 - bp) * (st.beatConf || 0);      // peaks just after a beat
    this.surge *= Math.pow(0.03, d);
    // focus tightens + speeds up; relax widens + slows
    const baseRate = pace * (0.5 + F * 1.1) * (1.3 - R * 0.6);
    const rate = baseRate * (1 + (this.surge + beatEase) * 1.3);
    this.extraAngle += rate * d;

    // glow swell paced by beat (capped, never full white)
    const beatGlow = 1 + (this.surge * 0.5 + beatEase * 0.4);

    for (const o of this.orbs) {
      const lvl = this._band(o.band);
      o.angle += rate * d * (0.8 + o.radius * 0.05);
      // orbit radius breathes: relax wider, focus tighter
      const rad = o.radius * (0.8 + R * 0.5) * (1.25 - F * 0.35);
      const wob = Math.sin(this.extraAngle * 1.3 + o.wobbleSeed) * 0.15;   // secondary wobble
      const x = Math.cos(o.angle) * rad;
      const z = Math.sin(o.angle) * rad;
      const y = Math.sin(o.angle + o.incl) * rad * 0.35 + wob;
      o.sprite.position.set(x, y, z);
      // size + glow modulate with band level; focus brightens
      const sz = 0.55 + lvl * 1.3 + (0.2 + F * 0.3);
      o.sprite.scale.setScalar(sz * (0.9 + beatEase * 0.15));
      const g = Math.min(1.6, (0.35 + lvl * 0.9) * beatGlow * (0.8 + F * 0.5));
      o.mat.color.setRGB(
        Math.min(1.6, o.baseCol[0] * g), Math.min(1.6, o.baseCol[1] * g), Math.min(1.6, o.baseCol[2] * g));

      // push into trail ring buffer
      const h = o.thead * 3;
      o.tpos[h] = x; o.tpos[h + 1] = y; o.tpos[h + 2] = z;
      o.thead = (o.thead + 1) % TRAIL;
      // recolour trail faded by age (newest brightest)
      for (let k = 0; k < TRAIL; k++) {
        const age = (o.thead - 1 - k + TRAIL) % TRAIL;      // 0 = newest
        const f = (1 - age / TRAIL);
        const idx = ((o.thead - 1 - k + TRAIL) % TRAIL) * 3;
        const e = f * f * (0.4 + lvl * 0.5);
        o.tcol[idx] = o.baseCol[0] * e; o.tcol[idx + 1] = o.baseCol[1] * e; o.tcol[idx + 2] = o.baseCol[2] * e;
      }
      o.pa.needsUpdate = true; o.ca.needsUpdate = true;
    }

    // head tilt leans the orbital plane; gyro adds a very subtle drift
    const tx = (st.tilt?.y ?? 0) * 0.7, tz = (st.tilt?.x ?? 0) * 0.7;
    this.group.rotation.x += (tx - this.group.rotation.x) * Math.min(1, d * 3);
    this.group.rotation.z += (tz - this.group.rotation.z) * Math.min(1, d * 3);
    this.group.rotation.y += d * (0.05 + (st.gyro?.y ?? 0) * 0.002);

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
