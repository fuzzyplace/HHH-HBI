import * as THREE from 'three';

// Cyborg injector arms: a three.js overlay on a transparent canvas above the INK fluid.
// Four procedural robotic arms (one per EEG sensor) reach in from the screen edges and hold
// their needle tips exactly on the INK injection sites; a fifth pump arm sits on the PPG site.
// Machines bio-printing living material: dark gunmetal links + emissive trim, cool rim light.
//
// Everything here is a readout of real state:
//   LED ring + nozzle light = sensor quality (off / red blink no contact|railed / amber noisy /
//   green good / cyan flash on each dose). Pump light pulses red per real beat, dark without lock.
//   Arms are still by default; each real beat → a short plunge on every live arm.
//   Not live → dormant (lifted and pulled back, lights only): the arms are the sync display.
//   Artifact hold on a sensor (st.held[i]) → that arm glitches (RGB-split ghosts, vertex jitter,
//   scanline flicker, stuttering light); st.motion → every arm glitches. The art is never glitched.
// World units = CSS pixels; a perspective camera is placed so the z=0 plane maps 1:1 to the screen,
// so needle tips (z=0) align exactly with the fluid's site coordinates. The camera is a "window" rig shared
// with ink.js: it may slide (head tilt) and dolly (real beats only), always with an off-axis frustum that keeps
// the z=0 rectangle pinned to the viewport — off-plane parts parallax, the tips never leave their sites.
// PLAY: a sixth magenta/white "stylus" arm from the lower-left holds its tip on the head-steered stylus point
// (fx.sx/sy from ink.js, which stirs at exactly that point); retracted + hidden outside PLAY. Motion glitch is
// suppressed in PLAY (motion is intentional); held-sensor glitch stays (honest data).
// BREATHE: the four injector tips retract along their inward line by fx.bOff (ink.js injects at the same offset
// nozzle), a thin guide ring around the head breathes with fx.level; harmony (fx.gold) warms trim + lights gold.

const FOV = 30;
const C_OFF = new THREE.Color(0x07080a), C_RED = new THREE.Color(0xff2244), C_AMB = new THREE.Color(0xffb000);
const C_GRN = new THREE.Color(0x00ff9c), C_CYN = new THREE.Color(0x00fff0);
const C_TRIM = new THREE.Color(0x00c8d8), C_GOLD = new THREE.Color(0xffc45a), C_MAG = new THREE.Color(0xff2bd6), C_WHT = new THREE.Color(0xffffff);
const UP_Y = new THREE.Vector3(0, 1, 0), AX_Z = new THREE.Vector3(0, 0, 1), AX_X = new THREE.Vector3(1, 0, 0);

function haloTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.25, 'rgba(255,255,255,0.45)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// Standard material with an opt-in glitch: vertex jitter in bands + scanline flicker. Uniforms per arm.
function glitchMat(params, u) {
  const m = new THREE.MeshStandardMaterial(params);
  m.onBeforeCompile = s => {
    s.uniforms.uGlitch = u.uGlitch; s.uniforms.uTime = u.uTime;
    s.vertexShader = 'uniform float uGlitch;\nuniform float uTime;\n' + s.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      if (uGlitch > 0.001) {
        float band = floor(position.y * 7.0 + floor(uTime * 22.0) * 3.1);
        float h = fract(sin(band * 91.7 + floor(uTime * 22.0) * 13.3) * 43758.5);
        transformed.xz += (h - 0.5) * uGlitch * 0.9 * step(0.55, h);
      }`);
    s.fragmentShader = 'uniform float uGlitch;\nuniform float uTime;\n' + s.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
      if (uGlitch > 0.001) {
        float sl = step(0.5, fract(gl_FragCoord.y * 0.25 + uTime * 30.0));
        gl_FragColor.rgb *= 1.0 - uGlitch * 0.55 * sl;
        float tear = step(0.93, fract(sin(floor(gl_FragCoord.y * 0.08) * 12.9 + floor(uTime * 18.0) * 7.7) * 4375.5));
        gl_FragColor.rgb += uGlitch * tear * vec3(0.9, 0.1, 0.7) * 0.7;
      }`);
  };
  m.customProgramCacheKey = () => 'hbi-arm-glitch';
  return m;
}

export class Arms {
  constructor(canvas) {
    this.canvas = canvas; this.t = 0; this.wake = 0;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'high-performance' }));
    r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.1;
    this.pr = Math.min(devicePixelRatio || 1, 1.5);
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(FOV, 1, 1, 10000);
    this._env();

    // lighting: dim cold ambient, white key from above-front, cyan rim from behind (edges glow), faint magenta fill
    this.scene.add(new THREE.AmbientLight(0x1a2233, 0.5));
    const key = new THREE.DirectionalLight(0xe6eeff, 1.3); key.position.set(-0.4, 0.6, 1); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x00e5ff, 2.4); rim.position.set(0.5, 0.8, -0.7); this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xff2bd6, 0.45); fill.position.set(-0.8, -0.5, 0.3); this.scene.add(fill);

    // shared geometry (unit-sized, scaled per part)
    const G = (this.G = {
      link: new THREE.CylinderGeometry(1, 1, 1, 6, 8),
      cyl: new THREE.CylinderGeometry(1, 1, 1, 18, 4),
      sphere: new THREE.SphereGeometry(1, 18, 12),
      cone: new THREE.ConeGeometry(1, 1, 14, 4),
      torus: new THREE.TorusGeometry(1, 0.2, 8, 28),
      box: new THREE.BoxGeometry(1, 1, 1, 1, 6, 1),
    });
    const halo = haloTexture();
    this.ghostMatR = new THREE.MeshBasicMaterial({ color: 0xff1f4f, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false });
    this.ghostMatC = new THREE.MeshBasicMaterial({ color: 0x00fff0, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false });

    this.arms = [];
    for (let i = 0; i < 6; i++) {
      const sty = i === 5;
      const u = { uGlitch: { value: 0 }, uTime: { value: 0 } };
      const metal = glitchMat({ color: sty ? 0x3a3f48 : 0x2c323b, metalness: 0.9, roughness: sty ? 0.25 : 0.33, envMapIntensity: 0.9 }, u);
      const rubber = glitchMat({ color: 0x0a0c0f, metalness: 0.15, roughness: 0.65 }, u);
      const trim = glitchMat({ color: 0x050607, metalness: 0.4, roughness: 0.4, emissive: sty ? 0xff2bd6 : 0x00c8d8, emissiveIntensity: 0.3 }, u);
      const led = new THREE.MeshBasicMaterial({ color: 0x07080a, toneMapped: false });
      const nozLed = new THREE.MeshBasicMaterial({ color: 0x07080a, toneMapped: false });
      const mk = (geo, mat, ghost = !sty) => {
        const m = new THREE.Mesh(geo, mat); m.matrixAutoUpdate = true; m.visible = !sty; this.scene.add(m);
        return { m, ghost };
      };
      const p = {
        shoulder: mk(G.sphere, metal), mount: mk(G.cyl, metal),
        upper: mk(G.link, metal), elbow: mk(G.cyl, metal), fore: mk(G.link, metal), wrist: mk(G.sphere, metal),
        housing: mk(G.cyl, metal), needle: mk(G.cone, metal),
        trimU: mk(G.box, trim), trimF: mk(G.box, trim),
        hose1: mk(G.cyl, rubber), hose2: mk(G.cyl, rubber),
        ring: mk(G.torus, led, false), nozRing: mk(G.torus, nozLed, false),
      };
      const hRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo, color: 0x000000, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      const hNoz = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo, color: 0x000000, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      hRing.visible = hNoz.visible = !sty;
      this.scene.add(hRing, hNoz);
      // ghost copies for the RGB-split glitch (hidden unless that arm is glitching)
      const ghosts = [];
      for (const k in p) if (p[k].ghost) {
        const gr = new THREE.Mesh(p[k].m.geometry, this.ghostMatR), gc = new THREE.Mesh(p[k].m.geometry, this.ghostMatC);
        gr.visible = gc.visible = false; gr.renderOrder = gc.renderOrder = 2;
        this.scene.add(gr, gc); ghosts.push([p[k].m, gr, gc]);
      }
      this.arms.push({
        u, metal, trim, led, nozLed, p, hRing, hNoz, ghosts, glitch: 0, gx: 0, gy: 0, gAt: 0, stutter: 1,
        base: new THREE.Vector3(), tip: new THREE.Vector3(), inward: new THREE.Vector3(), lat: new THREE.Vector3(),
        L1: 1, L2: 1, rL: 10, hh: 20, nl: 20, plT: 1, plA: 0, pump: i === 4, sty, shown: !sty,
        col: new THREE.Color(), lvl: 0,
      });
    }
    // BREATHE guide ring around the head (z=0, so it sits on the pool plane): thin core + soft wide glow
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.ringGlowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.guide = new THREE.Mesh(new THREE.TorusGeometry(1, 0.0045, 6, 160), this.ringMat);
    this.guideGlow = new THREE.Mesh(new THREE.TorusGeometry(1, 0.022, 6, 160), this.ringGlowMat);
    this.guide.visible = this.guideGlow.visible = false; this.guide.renderOrder = this.guideGlow.renderOrder = 1;
    this.scene.add(this.guide, this.guideGlow);
    this.cTmp = new THREE.Color();
    // scratch vectors (no per-frame allocation)
    this.v = Array.from({ length: 12 }, () => new THREE.Vector3());
    this.q = new THREE.Quaternion();
    this.resize(innerWidth, innerHeight, null, null);
  }

  /** a dark cyberpunk room baked to an environment map once: metal picks up cyan/magenta/amber strips */
  _env() {
    const es = new THREE.Scene();
    es.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial({ color: 0x040509, side: THREE.BackSide })));
    const strip = (c, x, y, z, sx, sy, sz) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), new THREE.MeshBasicMaterial({ color: c }));
      m.position.set(x, y, z); es.add(m);
    };
    strip(new THREE.Color(0, 3, 3.2), 0, 4.6, 0, 7, 0.3, 0.6);
    strip(new THREE.Color(3, 0.3, 2.4), -4.6, 0, 1, 0.3, 5, 0.5);
    strip(new THREE.Color(2.5, 1.6, 0.2), 4.6, -2, 2, 0.3, 2, 0.4);
    strip(new THREE.Color(1.2, 1.3, 1.5), 0, 0, 4.6, 3, 3, 0.2);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(es, 0.03).texture;
    pm.dispose();
  }

  resize(w, h, sites, head) {
    w = Math.max(1, w || innerWidth); h = Math.max(1, h || innerHeight);
    this.w = w; this.h = h;
    this.renderer.setPixelRatio(this.pr); this.renderer.setSize(w, h, false);
    const D = (h / 2) / Math.tan((FOV / 2) * Math.PI / 180);
    this.cam.aspect = w / h; this.cam.position.set(0, 0, D); this.cam.near = D * 0.1; this.cam.far = D * 4;
    this.cam.lookAt(0, 0, 0); this.cam.updateProjectionMatrix();
    if (!sites || !head) return;
    this.sites = sites; this.head = head;
    const R = head.ry, W = (x, y, z, out) => out.set(x - w / 2, h / 2 - y, z);
    // base anchors just outside the screen edges (CSS px), raised toward the camera
    const bases = [
      [-R * 0.35, sites[0].y + R * 0.55, R * 0.55],                  // TP9: left edge
      [sites[1].x - R * 1.15, -R * 0.4, R * 0.6],                    // AF7: top-left
      [sites[2].x + R * 1.15, -R * 0.4, R * 0.6],                    // AF8: top-right
      [w + R * 0.35, sites[3].y + R * 0.55, R * 0.55],               // TP10: right edge
      [sites[4].x, -R * 0.55, R * 0.75],                             // pump: top centre
    ];
    for (let i = 0; i < 5; i++) {
      const a = this.arms[i];
      W(bases[i][0], bases[i][1], bases[i][2], a.base);
      W(sites[i].x, sites[i].y, 0, a.tip);
      a.inward.set(head.x - w / 2, h / 2 - (head.y + R * 0.15), 0).sub(a.tip).setZ(0).normalize();
      a.rL = R * (a.pump ? 0.09 : 0.075);
      a.hh = R * (a.pump ? 0.16 : 0.11); a.nl = R * (a.pump ? 0.07 : 0.11);
      const wr = this.v[0].copy(a.tip).setZ(a.hh + a.nl);
      const d = wr.distanceTo(a.base);
      a.L1 = d * 0.66; a.L2 = d * 0.62;
      // elbow bends partly sideways (away from the head) so the silhouette reads as a jointed arm from above
      const dir = this.v[1].subVectors(wr, a.base).setZ(0).normalize();
      a.lat.set(-dir.y, dir.x, 0);
      const out = this.v[2].set(sites[i].x - head.x, -(sites[i].y - head.y), 0);
      if (a.lat.dot(out) < 0) a.lat.negate();
      if (i === 4) a.lat.set(1, 0, 0);
    }
    { // PLAY stylus: rises from below the dock, right of centre; links long enough to reach the whole stylus range unlocked
      const a = this.arms[5];
      W(Math.min(w + R * 0.2, head.x + R * 1.9), h + R * 0.35, R * 0.8, a.base);
      W(head.x, head.y, 0, a.tip);
      a.rL = R * 0.06; a.hh = R * 0.1; a.nl = R * 0.14;
      let maxD = 1;
      for (let k = 0; k < 4; k++) {
        W(head.x + (k & 1 ? 1.15 : -1.15) * head.rx, head.y + (k & 2 ? 1.15 : -1.15) * head.ry, a.hh + a.nl, this.v[0]);
        maxD = Math.max(maxD, this.v[0].distanceTo(a.base));
      }
      a.L1 = maxD * 0.55; a.L2 = maxD * 0.52;
      const dir = this.v[1].subVectors(a.tip, a.base).setZ(0).normalize();
      a.lat.set(-dir.y, dir.x, 0); if (a.lat.x < 0) a.lat.negate();   // elbow leans right, away from the head
      a.inward.copy(dir);
      this.guide.position.set(head.x - w / 2, h / 2 - head.y, 0);
      this.guideGlow.position.copy(this.guide.position);
    }
  }

  onBeat(s, active) {
    for (let i = 0; i < 5; i++) {
      const a = this.arms[i];
      if (i < 4 && !active[i]) continue;
      a.plT = 0; a.plA = 0.5 + 0.5 * s;
    }
  }

  /** off-axis window projection: eye at (ox, oy, D) looking down -z, z=0 plane mapped exactly onto the viewport */
  _rig(cam) {
    const c = this.cam, w = this.w, h = this.h;
    const ox = cam ? cam.ox : 0, oy = cam ? cam.oy : 0, D = cam ? cam.Dk : (h / 2) / Math.tan((FOV / 2) * Math.PI / 180);
    const n = D * 0.1, k = n / D;
    c.position.set(ox, oy, D); c.quaternion.identity(); c.near = n; c.far = D * 4;
    c.projectionMatrix.makePerspective((-w / 2 - ox) * k, (w / 2 - ox) * k, (h / 2 - oy) * k, (-h / 2 - oy) * k, n, D * 4);
    c.projectionMatrixInverse.copy(c.projectionMatrix).invert();
  }

  /** fx (from ink.js, reused object): { sOn 0..1, sx, sy (stylus tip, CSS px), bOff (breath nozzle retraction, CSS px),
   *  ring 0..1 (breath guide on), level 0..1 (lungs), gold 0..1 (harmony) }. Absent/zero fx = the pre-PLAY/BREATHE pose. */
  frame(st, dt, dose, active, cam, fx) {
    if (!this.sites) return;
    this._rig(cam);
    this.t += dt;
    const t = this.t, live = st.ready === 'live', R = this.head.ry, v = this.v;
    this.wake += ((live ? 1 : 0) - this.wake) * Math.min(1, dt * 1.6);
    const streaming = st.ready && st.ready !== 'idle';
    const blink = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.8));   // slow red blink
    const gold = fx ? fx.gold : 0, bOff = fx ? fx.bOff : 0, sOn = fx ? fx.sOn : 0;
    this._guide(fx, t);

    for (let i = 0; i < 6; i++) {
      const a = this.arms[i], p = a.p;
      if (a.sty) {   // PLAY stylus: hidden + skipped entirely when off
        const show = sOn > 0;
        if (show !== a.shown) { a.shown = show; for (const k in p) p[k].m.visible = show; a.hRing.visible = a.hNoz.visible = show; }
        if (!show) continue;
      }
      // ---- status light ----
      let lit = 1;
      if (a.sty) {
        a.col.copy(C_MAG); lit = sOn;
      } else if (!a.pump) {
        const lab = streaming ? st.quality?.[i]?.label || 'off' : 'off';
        if (lab === 'good') a.col.copy(C_GRN);
        else if (lab === 'noisy') a.col.copy(C_AMB);
        else if (lab === 'no contact') { a.col.copy(C_RED); lit = blink; }
        else if (lab === 'railed') a.col.copy(C_RED);
        else { a.col.copy(C_OFF); lit = 0; }
        if (lit > 0 && dose[i] > 0.01) a.col.lerp(C_CYN, Math.min(1, dose[i] * 1.3));   // cyan flash on each dose
        if (gold > 0 && lab === 'good') a.col.lerp(C_GOLD, gold * 0.6);   // harmony warms healthy lights (red/amber stay honest)
      } else {
        const lock = streaming && st.bpm > 0;
        a.col.copy(lock ? C_RED : C_OFF); lit = lock ? 0.12 + 0.88 * Math.min(1, dose[4]) : 0;
      }
      // ---- glitch (artifact hold → this arm; motion → all) ----
      // PLAY: head motion is intentional → no motion glitch; a held sensor still glitches (honest data); stylus never
      const gT = !a.sty && st.ready === 'live' && ((!a.pump && st.held?.[i]) || (st.motion && !st.play)) ? 1 : 0;
      a.glitch += (gT - a.glitch) * Math.min(1, dt * (gT ? 14 : 5));
      if (t - a.gAt > 0.05) {   // jumps at ~20Hz
        a.gAt = t; const gm = a.glitch * a.rL;
        a.gx = (Math.random() - 0.5) * gm * 1.6 + gm * 0.5; a.gy = (Math.random() - 0.5) * gm * 0.8;
        a.stutter = Math.random() > 0.45 ? 1 : 0.08;
      }
      const glitching = a.glitch > 0.04;
      if (glitching) lit *= a.stutter;
      a.u.uGlitch.value = glitching ? a.glitch * (0.5 + 0.5 * a.stutter) : 0; a.u.uTime.value = t;
      a.led.color.copy(a.col).multiplyScalar(lit);
      if (a.sty) {   // white nozzle, magenta trim; halo brightens while it stirs
        a.nozLed.color.copy(C_WHT).multiplyScalar(lit);
        a.hRing.material.color.copy(a.col).multiplyScalar(lit * 0.55);
        a.hNoz.material.color.copy(C_WHT).multiplyScalar(lit * 0.55);
        a.trim.emissiveIntensity = (0.25 + 0.5 * this.wake) * sOn;
      } else {
        a.nozLed.color.copy(a.col).multiplyScalar(lit);
        a.hRing.material.color.copy(a.col).multiplyScalar(lit * 0.55);
        a.hNoz.material.color.copy(a.col).multiplyScalar(lit * (0.5 + (a.pump ? dose[4] : dose[i]) * 0.8));
        a.trim.emissiveIntensity = 0.12 + 0.45 * this.wake;
        if (gold > 0) { a.trim.emissive.copy(C_TRIM).lerp(C_GOLD, gold); a.trim.emissiveIntensity *= 1 + 0.6 * gold; }
        else if (a.goldWas) a.trim.emissive.copy(C_TRIM);
        a.goldWas = gold > 0;
      }

      // ---- pose: rest at the site; plunge on beat; dormant = lifted + pulled back ----
      if (a.plT < 1) a.plT = Math.min(1, a.plT + dt / 0.38);
      const pl = a.plT < 1 ? Math.sin(Math.PI * a.plT) * a.plA : 0;
      const tip = v[1].copy(a.tip);
      if (a.sty) {   // follows the stylus point; retracts toward its shoulder and lifts as PLAY eases out
        tip.set(fx.sx - this.w / 2, this.h / 2 - fx.sy, 0);
        tip.lerp(a.base, (1 - sOn) * 0.7); tip.z += (1 - sOn) * R * 0.6;
      }
      tip.z -= pl * R * 0.05; tip.addScaledVector(a.inward, pl * R * 0.025);
      if (bOff > 0 && i < 4) tip.addScaledVector(a.inward, -bOff);   // breath: nozzle slides out along its inward line
      const sleep = 1 - this.wake;
      tip.lerp(a.base, sleep * 0.16); tip.z += sleep * R * 0.45;
      const W = v[2].copy(tip); W.z += a.hh + a.nl;
      const B = a.base;
      // two-bone IK in the plane of base→wrist and +z (elbow bends up toward the camera)
      const dvec = v[3].subVectors(W, B); let dl = dvec.length();
      const L1 = a.L1, L2 = a.L2;
      dl = Math.max(Math.abs(L1 - L2) + 1, Math.min(dl, (L1 + L2) * 0.995));
      const uDir = dvec.normalize();
      const n = v[4].copy(AX_Z).multiplyScalar(0.7).addScaledVector(a.lat, a.pump ? 0.35 : a.sty ? 0.45 : 0.7);
      n.addScaledVector(uDir, -n.dot(uDir));
      if (n.lengthSq() < 1e-6) n.copy(AX_X); n.normalize();
      const along = (L1 * L1 - L2 * L2 + dl * dl) / (2 * dl), hgt = Math.sqrt(Math.max(0, L1 * L1 - along * along));
      const E = v[5].copy(B).addScaledVector(uDir, along).addScaledVector(n, hgt);
      W.copy(B).addScaledVector(uDir, dl);
      const hinge = v[6].crossVectors(uDir, n).normalize();
      const N = v[7].copy(W); N.z -= a.hh;          // bottom of the nozzle housing
      const tipR = v[8].copy(N); tipR.z -= a.nl;    // needle tip (on the site when at rest)
      const rL = a.rL;

      this._seg(p.upper.m, B, E, rL);
      this._seg(p.fore.m, E, W, rL * 0.78);
      this._seg(p.housing.m, W, N, rL * (a.pump ? 1.5 : 1.0));
      this._seg(p.needle.m, N, tipR, rL * 0.32);
      p.shoulder.m.position.copy(B); p.shoulder.m.scale.setScalar(rL * 1.7);
      v[9].copy(B); v[9].z += rL * 3;
      this._seg(p.mount.m, v[9], B, rL * 2.2);
      p.elbow.m.position.copy(E); p.elbow.m.quaternion.setFromUnitVectors(UP_Y, hinge); p.elbow.m.scale.set(rL * 1.25, rL * 2.6, rL * 1.25);
      p.wrist.m.position.copy(W); p.wrist.m.scale.setScalar(rL * 1.05);
      // trim strips ride the camera-facing side of each link
      const nE = v[10].subVectors(E, B); const up1 = v[11].copy(n).multiplyScalar(rL * 0.9);
      this._strip(p.trimU.m, B, E, up1, rL * 0.22, 0.72);
      up1.crossVectors(hinge, nE.subVectors(W, E).normalize()).multiplyScalar(-rL * 0.75);
      this._strip(p.trimF.m, E, W, up1, rL * 0.18, 0.7);
      // hoses along the hinge side
      v[9].copy(B).addScaledVector(hinge, rL * 1.35); v[10].copy(E).addScaledVector(hinge, rL * 1.35);
      this._seg(p.hose1.m, v[9], v[10], rL * 0.3);
      v[9].copy(W).addScaledVector(hinge, rL * 1.1); v[9].z -= a.hh * 0.6;
      this._seg(p.hose2.m, v[10], v[9], rL * 0.26);
      // status LED ring around the elbow hinge, nozzle ring at the housing mouth
      p.ring.m.position.copy(E).addScaledVector(hinge, rL * 1.32);
      p.ring.m.quaternion.setFromUnitVectors(AX_Z, hinge); p.ring.m.scale.setScalar(rL * 0.95);
      p.nozRing.m.position.copy(N); p.nozRing.m.quaternion.identity(); p.nozRing.m.scale.setScalar(rL * (a.pump ? 1.5 : 1.0) * 1.08);
      a.hRing.position.copy(p.ring.m.position); a.hRing.position.z += rL; a.hRing.scale.setScalar(rL * 7);
      a.hNoz.position.copy(tipR); a.hNoz.position.z += 1; a.hNoz.scale.setScalar(rL * (a.pump ? 9 : 6.5));

      // RGB-split ghosts
      for (let k = 0; k < a.ghosts.length; k++) {
        const gh = a.ghosts[k], src = gh[0], gr = gh[1], gc = gh[2];
        gr.visible = gc.visible = glitching;
        if (!glitching) continue;
        gr.position.copy(src.position); gr.position.x += a.gx; gr.position.y += a.gy;
        gc.position.copy(src.position); gc.position.x -= a.gx; gc.position.y -= a.gy;
        gr.quaternion.copy(src.quaternion); gc.quaternion.copy(src.quaternion);
        gr.scale.copy(src.scale); gc.scale.copy(src.scale);
      }
    }
    this.renderer.render(this.scene, this.cam);
  }

  /** BREATHE guide: ellipse ring around the head, radius follows the lungs; cyan, warming gold with harmony. Never strobes. */
  _guide(fx, t) {
    const on = fx ? fx.ring : 0, g = this.guide, gg = this.guideGlow;
    g.visible = gg.visible = on > 0.002;
    if (!g.visible) return;
    const H = this.head, k = 1.22 + 0.34 * fx.level;
    g.scale.set(H.rx * k, H.ry * k, 1); gg.scale.copy(g.scale);
    const c = this.cTmp.copy(C_CYN).lerp(C_GOLD, fx.gold);
    const a = on * (0.55 + 0.25 * fx.level);
    this.ringMat.color.copy(c).multiplyScalar(a); this.ringMat.opacity = 1;
    this.ringGlowMat.color.copy(c).multiplyScalar(a * 0.22); this.ringGlowMat.opacity = 1;
  }

  /** place a unit Y-aligned mesh between a and b with radius r (+Y, i.e. a cone's apex, points at b) */
  _seg(m, a, b, r) {
    const d = this.v[0].subVectors(b, a), len = d.length() || 1e-3;
    m.position.copy(a).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(UP_Y, d.multiplyScalar(1 / len));
    m.scale.set(r, len, r);
  }
  _strip(m, a, b, off, r, frac) {
    const d = this.v[0].subVectors(b, a), len = d.length() || 1e-3;
    m.position.copy(a).addScaledVector(d, 0.5).add(off);
    m.quaternion.setFromUnitVectors(UP_Y, d.multiplyScalar(1 / len));
    m.scale.set(r, len * frac, r);
  }
}
