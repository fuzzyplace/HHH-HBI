import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, uniform, uniformArray, instancedArray, instanceIndex, hash, float, vec2, vec3, vec4,
  time, deltaTime, mx_noise_vec3, texture, uv, screenUV, screenSize, mix, smoothstep, floor, step, sin, cos, min, max, clamp, pow,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { rgbShift } from 'three/addons/tsl/display/RGBShiftNode.js';
import { DataRain } from './rain.js';

const DEBUG = new URLSearchParams(location.search).get('debug');
// electrode attractor positions (x,y,z): TP9, AF7, AF8, TP10
// band pigments δ θ α β γ (dock key #8a4dff #ff2bd6 #00fff0 #ffb000 #ffffff, linear-ish)
const BAND_RGB = [[0.54, 0.30, 1.0], [1.0, 0.17, 0.84], [0.0, 1.0, 0.94], [1.0, 0.69, 0.0], [0.85, 0.88, 0.95]];
const NODES = [[-1.7, -0.9, 0.3], [-1.0, 1.1, 0.8], [1.0, 1.1, 0.8], [1.7, -0.9, 0.3]];

export class GpuScene {
  static async create(canvas) { const s = new GpuScene(canvas); await s.init(); return s; }
  constructor(canvas) {
    this.canvas = canvas; this.flash = 0; this.pulse = 0; this.snapReq = false;
    this.ftAvg = 16; this.slow = 0;
    this.relaxS = 0.5; this.focusS = 0.5;   // eased calm/activation indices (dominant drivers)
    this.beat = 0; this.drift = 0;          // heart-only motion: beat envelope + small decaying drift
  }

  async init() {
    const r = (this.renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: false, forceWebGL: new URLSearchParams(location.search).has('webgl') }));
    await r.init();
    this.webgpu = !!r.backend.isWebGPUBackend;
    r.toneMapping = THREE.NeutralToneMapping; r.toneMappingExposure = 1.2;   // Neutral keeps neon saturated
    this.pr = Math.min(devicePixelRatio || 1, this.webgpu ? 1.5 : 1);
    const qp = +new URLSearchParams(location.search).get('particles');
    const N = (this.N = qp || (this.webgpu ? 1 << 18 : 1 << 16));

    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
    this.cam.position.set(0, 0, 6);
    this.group = new THREE.Group(); this.scene.add(this.group);

    const U = (this.u = {
      turb: uniform(1), freq: uniform(0.5), drag: uniform(0.97), pulse: uniform(0), mood: uniform(0.5), size: uniform(0.025),
      decay: uniform(0.92), zoom: uniform(0.004), rot: uniform(0), smear: uniform(0.003), glitch: uniform(0),
      rain: uniform(0.2), flash: uniform(0), aspect: uniform(innerWidth / innerHeight), shift: uniform(0.002),
      beat: uniform(0), aim: uniform(new THREE.Vector3()),   // beat=brightness swell; aim=head-tilt paint emitter target
      flow: uniform(0),   // 0..1 motion gate: particles only move after real heartbeats
      cum: uniform(new THREE.Vector4(0.2, 0.4, 0.6, 0.8)),   // cumulative band shares δ θ α β (γ = rest): particle colour mix
      deposit: uniform(0), paintKeep: uniform(1),           // impasto: paint laid per frame (beat flow), height persistence
      ptexel: uniform(new THREE.Vector2(1, 1)),
    });
    this.attrVecs = NODES.map(([x, y, z]) => new THREE.Vector4(x, y, z, 0.5));
    const attr = uniformArray(this.attrVecs, 'vec4');

    // ---------- GPU particles (compute) ----------
    const pos = instancedArray(N, 'vec3'), vel = instancedArray(N, 'vec3');
    const init = Fn(() => {
      // hash() truncates to uint: seeds must differ by integers, not fractions
      const s = instanceIndex.mul(3);
      pos.element(instanceIndex).assign(vec3(hash(s), hash(s.add(1)), hash(s.add(2))).sub(0.5).mul(6));
      vel.element(instanceIndex).assign(vec3(0));
    })().compute(N);

    this.update = Fn(() => {
      const p = pos.element(instanceIndex), v = vel.element(instanceIndex);
      const t = time.mul(0.15);
      const f = mx_noise_vec3(p.mul(U.freq).add(vec3(t, t.mul(0.7), t.mul(-0.5)))).mul(U.turb).toVar();
      Loop(4, ({ i }) => {
        const a = attr.element(i);
        const d = a.xyz.sub(p);
        const l = d.length();
        f.addAssign(d.div(l.add(1e-4)).mul(a.w).div(l.mul(l).add(0.6)));
      });
      f.addAssign(p.normalize().mul(U.pulse));
      f.subAssign(p.mul(0.12));
      const dt = min(deltaTime, 0.05).mul(U.flow);
      const nv = v.add(f.mul(dt)).mul(pow(U.drag, dt.mul(60)));     // frame-rate independent damping
      v.assign(nv.mul(min(float(1), float(5).div(nv.length().add(1e-4)))));   // speed cap
      p.addAssign(v.mul(dt));
      If(p.length().greaterThan(7.0), () => {
        // paint is emitted where the head points (U.aim); feedback zoom then streams it outward
        const s = instanceIndex.mul(3).add(floor(time.mul(60)).toUint().mul(1000003));
        p.assign(U.aim.add(vec3(hash(s), hash(s.add(1)), hash(s.add(2))).sub(0.5).mul(1.2)));
        v.assign(vec3(0));
      });
    })().compute(N);

    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    mat.positionNode = pos.toAttribute();
    const speed = vel.toAttribute().length();
    const k = clamp(speed.mul(0.45), 0, 1);
    // each particle carries one band's pigment; the share of particles per band follows the live band levels
    // (δ violet, θ magenta, α cyan, β amber, γ white — same key as the dock and INK)
    const hb = hash(float(instanceIndex).add(7.0));
    const bandCol = mix(mix(mix(mix(vec3(...BAND_RGB[0]), vec3(...BAND_RGB[1]), step(U.cum.x, hb)),
      vec3(...BAND_RGB[2]), step(U.cum.y, hb)), vec3(...BAND_RGB[3]), step(U.cum.z, hb)), vec3(...BAND_RGB[4]), step(U.cum.w, hb));
    const col = bandCol.mul(float(0.75).add(k.mul(0.45)));
    const a = smoothstep(0.5, 0.0, uv().sub(0.5).length());
    // per-particle alpha scales inversely with count so density, not count, sets brightness
    mat.colorNode = vec4(col, a.mul(Math.min(0.6, 12000 / N)));
    mat.scaleNode = U.size.mul(hash(float(instanceIndex)).mul(0.9).add(0.5));
    const sprite = new THREE.Sprite(mat); sprite.count = N; sprite.frustumCulled = false;
    this.group.add(sprite);

    // ---------- feedback "painting memory" ----------
    const rtOpts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.sceneRT = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.fbA = new THREE.RenderTarget(1, 1, rtOpts);
    this.fbB = new THREE.RenderTarget(1, 1, rtOpts);
    this.rain = new DataRain();
    this.rainTex = new THREE.CanvasTexture(this.rain.canvas); this.rainTex.colorSpace = THREE.SRGBColorSpace;

    const u0 = uv();
    const c = u0.sub(0.5).mul(vec2(U.aspect, 1));
    const cs = cos(U.rot), sn = sin(U.rot);
    const rc = vec2(c.x.mul(cs).sub(c.y.mul(sn)), c.x.mul(sn).add(c.y.mul(cs))).mul(float(1).sub(U.zoom));
    const n = mx_noise_vec3(vec3(u0.mul(4), time.mul(0.3)));
    const row = floor(u0.y.mul(48)), tick = floor(time.mul(14));
    const g = step(float(1).sub(U.glitch), hash(row.add(tick.mul(13.1))));          // glitch row mask
    const gx = g.mul(hash(row.mul(3.7).add(tick)).sub(0.5)).mul(0.15);              // row tear offset
    const wuv = rc.div(vec2(U.aspect, 1)).add(0.5).add(n.xy.mul(U.smear)).add(vec2(gx, 0));
    this.prevNode = texture(this.fbA.texture, wuv);
    const sceneNode = texture(this.sceneRT.texture, u0);
    const rainNode = texture(this.rainTex, vec2(u0.x.add(gx.mul(0.3)), u0.y)).rgb;
    // max-blend keeps trails bounded (no runaway accumulation); small additive term lets overlaps glow
    // particle glints: dense overlaps sum toward white, so compress hue-preservingly (like INK) and keep them below white
    const sL = max(max(sceneNode.r, sceneNode.g), sceneNode.b);
    const sHue = pow(sceneNode.rgb.div(max(sL, 1e-4)), vec3(2.0));
    const fresh = sHue.mul(float(1).sub(sL.mul(-1.5).exp())).mul(0.75).add(rainNode.mul(U.rain));
    const fbCol = max(this.prevNode.rgb.mul(U.decay), fresh).add(fresh.mul(0.15))
      .add(vec3(0, 1, 0.9).mul(U.flash.mul(0.12)));
    const fbMat = new THREE.NodeMaterial();
    fbMat.fragmentNode = vec4(min(fbCol, vec3(2)), 1);
    this.quad = new THREE.QuadMesh(fbMat);

    // ---------- impasto: persistent pigment + height, laid by the particles while the water moves (beats) ----------
    // rgb = top pigment colour, a = paint thickness. No zoom/smear: strokes stay where they were laid and pile up.
    this.paintA = new THREE.RenderTarget(1, 1, rtOpts);
    this.paintB = new THREE.RenderTarget(1, 1, rtOpts);
    this.paintPrev = texture(this.paintA.texture, u0);
    // brush: dilate the particle layer (brightest of 5 taps) so each particle leaves a dab, not a pixel;
    // only dense flow (several particles overlapping) lays paint, so strokes form along the streams instead of speckle
    const bt = U.ptexel.mul(1.8), bd = bt.mul(0.7071);
    let dep = texture(this.sceneRT.texture, u0).rgb;
    for (const o of [vec2(bt.x, 0), vec2(bt.x.negate(), 0), vec2(0, bt.y), vec2(0, bt.y.negate()),
      vec2(bd.x, bd.y), vec2(bd.x.negate(), bd.y), vec2(bd.x, bd.y.negate()), vec2(bd.x.negate(), bd.y.negate())]) {
      const t = texture(this.sceneRT.texture, u0.add(o)).rgb;
      dep = mix(dep, t, step(max(max(dep.r, dep.g), dep.b), max(max(t.r, t.g), t.b)));
    }
    const dmax = max(max(dep.r, dep.g), dep.b);
    const amt = smoothstep(0.08, 0.5, dmax).mul(U.deposit);
    const ph = this.paintPrev.a;
    const nh = ph.add(amt.mul(max(float(1).sub(ph.div(1.4)), 0)));            // soft cap: thick paint stops growing
    const cov = clamp(amt.mul(5).div(ph.add(amt.mul(5)).add(0.03)), 0, 1);    // fresh paint covers old by its share
    // pigment: overlapping particles sum toward pale mixes; snap each dab to the nearest band pigment (mostly) so
    // strokes read in the band key's colours rather than lavender/white
    const hue = dep.div(max(dmax, 1e-4)), hn = hue.normalize();
    let best = vec3(...BAND_RGB[0]), bestS = hn.dot(vec3(...BAND_RGB[0]).normalize());
    for (let i = 1; i < 5; i++) {
      // γ's pigment is white: only near-neutral dabs snap to it, so pale mixes don't masquerade as gamma
      const c = vec3(...BAND_RGB[i]), sc = hn.dot(c.normalize()).sub(i === 4 ? 0.06 : 0), w = step(bestS, sc);
      best = mix(best, c, w); bestS = max(bestS, sc);
    }
    const nrgb = mix(this.paintPrev.rgb, mix(hue, best, 0.8), cov);
    const paintMat = new THREE.NodeMaterial();
    paintMat.fragmentNode = vec4(nrgb, nh.mul(U.paintKeep));
    this.paintQuad = new THREE.QuadMesh(paintMat);
    // lit display: normal from thickness gradient → oil sheen
    const pt = U.ptexel;
    this.paintRead = [u0, u0.add(vec2(pt.x, 0)), u0.sub(vec2(pt.x, 0)), u0.add(vec2(0, pt.y)), u0.sub(vec2(0, pt.y))].map(q => texture(this.paintB.texture, q));
    const [pC, pR, pL, pT, pB] = this.paintRead;
    const pn = vec3(pL.a.sub(pR.a).mul(5), pB.a.sub(pT.a).mul(5), 1).normalize();
    const Ld = vec3(-0.45, 0.6, 0.66).normalize();
    const diff = clamp(pn.dot(Ld), 0, 1).mul(0.6).add(0.45);
    const spec = pow(clamp(pn.dot(Ld.add(vec3(0, 0, 1)).normalize()), 0, 1), 36).mul(smoothstep(0.03, 0.35, pC.a)).mul(0.3);
    const cover = smoothstep(0.0, 0.06, pC.a);
    // kept under the tone-mapper's highlight knee (Neutral desaturates above ~0.8) so pigment stays saturated
    const paintLit = pC.rgb.mul(cover).mul(diff).mul(float(0.42).add(smoothstep(0.0, 0.8, pC.a).mul(0.28))).add(vec3(spec));

    // ---------- post: bloom → rgb split → scanlines/vignette/grain ----------
    this.outNode = texture(this.fbB.texture);
    this.bloomNode = bloom(this.outNode, 0.8, 0.45, 0.35);
    // paint is the body; the glowing particle/rain feedback rides on top a little softer so strokes stay readable
    // (where paint is thick the glints mostly sit back, so additive mixing doesn't wash pigment to white)
    const glowK = float(1).sub(cover.mul(0.75));
    const shifted = rgbShift(paintLit.add(this.outNode.mul(glowK.mul(0.55))).add(this.bloomNode.mul(glowK.mul(0.5))), U.shift);
    const s = screenUV;
    const scan = float(0.84).add(sin(s.y.mul(screenSize.y).mul(1.7)).mul(0.16));
    const vig = smoothstep(1.15, 0.35, s.sub(0.5).length().mul(1.4));
    const grain = hash(floor(s.x.mul(screenSize.x)).add(floor(s.y.mul(screenSize.y)).mul(4099)).add(floor(time.mul(60)).mul(7919))).sub(0.5).mul(0.05);
    // beat brightness swell is a capped multiply (max +32%) — readable across a room, never a strobe
    const beatGain = float(1).add(U.beat.mul(0.32));
    if (DEBUG === 'height') this.pipeline = new THREE.RenderPipeline(r, vec4(vec3(pC.a), 1));   // ?debug=height: paint thickness
    else if (DEBUG === 'glow') this.pipeline = new THREE.RenderPipeline(r, vec4(this.outNode.rgb, 1));
    else if (DEBUG === 'paint') this.pipeline = new THREE.RenderPipeline(r, vec4(paintLit, 1));   // ?debug=paint: impasto layer only
    else this.pipeline = new THREE.RenderPipeline(r, vec4(shifted.rgb.add(vec3(0, 1, 0.9).mul(U.flash.mul(0.18))).mul(scan).mul(vig).mul(beatGain).add(grain), 1));

    this.resize();
    addEventListener('resize', () => this.resize());
    r.compute(init);
  }

  resize() {
    const r = this.renderer, w = innerWidth, h = innerHeight;
    r.setPixelRatio(this.pr); r.setSize(w, h, false);
    const pw = Math.max(1, Math.floor(w * this.pr)), ph = Math.max(1, Math.floor(h * this.pr));
    for (const rt of [this.sceneRT, this.fbA, this.fbB]) rt.setSize(pw, ph);
    // the painting keeps its own resolution (CSS px, ≤1x) so the perf safeguard dropping pr never wipes it
    const qw = Math.max(1, Math.floor(w * Math.min(1, devicePixelRatio || 1))), qh = Math.max(1, Math.floor(h * Math.min(1, devicePixelRatio || 1)));
    if (this.paintA.width !== qw || this.paintA.height !== qh) {
      for (const rt of [this.paintA, this.paintB]) rt.setSize(qw, qh);
      this.u.ptexel.value.set(1 / qw, 1 / qh);
    }
    this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
    this.u.aspect.value = w / h;
  }
  clear() {
    const r = this.renderer;
    // clear to alpha 0 explicitly: paint thickness lives in .a, and a renderer default of alpha 1 would leave a full-height canvas
    const ca = r.getClearAlpha(); r.getClearColor(this._cc || (this._cc = new THREE.Color()));
    r.setClearColor(0x000000, 0);
    for (const rt of [this.fbA, this.fbB, this.paintA, this.paintB]) { r.setRenderTarget(rt); r.clear(); }
    r.setClearColor(this._cc, ca);
    r.setRenderTarget(null); this.rain.clear();
  }
  onBeat() { this.beat = 1; this.drift = Math.min(1, this.drift + 0.5); }   // heartbeat: stepped forward surge + brightness swell + radial pressure
  onBlink() { if (this.live) this.flash = 1; }
  snapshot() { this.snapReq = true; }

  frame(st, dt) {
    const U = this.u, b = st.bands, r = this.renderer;
    // not live: nothing moves — skip compute + render, the canvas keeps its last (or black) image
    this.live = st.ready === 'live';
    if (!this.live) { if (this.snapReq) { this.snapReq = false; save(this.canvas); } return; }
    // ---- dominant drivers: relax (calm) and focus (activation); undefined until main.js provides them ----
    const relax = st.relax ?? 0.5, focus = st.focus ?? 0.5;
    const ke = Math.min(1, dt * 1.2);                      // extra local smoothing (~0.8s) on top of DSP smoothing
    this.relaxS += (relax - this.relaxS) * ke;
    this.focusS += (focus - this.focusS) * ke;
    const R = this.relaxS, F = this.focusS;
    // heartbeat envelope: instant attack, ~0.4s decay — drives dolly/zoom surge, pressure, brightness
    this.beat *= Math.pow(0.006, dt);
    this.drift *= Math.pow(0.35, dt);                     // ~1s: water settles to rest without beats
    const flow = Math.min(1, this.beat + this.drift);
    U.flow.value = flow;
    this.flash *= Math.pow(0.005, dt); U.flash.value = this.flash;

    // (4) bands + per-channel = SECONDARY texture detail only (small coefficients)
    st.ch.forEach((c, i) => { let m = 0; for (const k in c) m = Math.max(m, c[k]); this.attrVecs[i].w = 0.15 + m * 0.5; });
    U.size.value = 0.02 + b.delta * 0.02;                  // particle grain, secondary
    // band levels → share of pigment per band (squared so the dominant band leads; every band keeps its colour)
    {
      const w0 = b.delta ** 2, w1 = b.theta ** 2, w2 = b.alpha ** 2, w3 = b.beta ** 2, w4 = b.gamma ** 2, ws = w0 + w1 + w2 + w3 + w4;
      if (ws > 1e-6) U.cum.value.set(w0 / ws, (w0 + w1) / ws, (w0 + w1 + w2) / ws, (w0 + w1 + w2 + w3) / ws);
    }
    U.freq.value = 0.3 + b.theta * 0.5 + F * 0.3;          // noise detail, mostly secondary
    U.rain.value = 0.05 + b.gamma * 0.2;                   // data-rain density, secondary
    U.smear.value = (0.001 + b.theta * 0.004) * Math.min(dt * 60, 3) * flow;

    // (2) FOCUS → turbulence + glitch row-tear + RGB shift + sparks/bloom (low=smooth, high=energetic)
    U.turb.value = 0.5 + F * 2.6 + b.gamma * 0.3;
    U.glitch.value = Math.min(0.9, F * 0.5 * flow + this.flash * 0.7);
    U.shift.value = 0.0012 + F * 0.004 + this.flash * 0.02;

    // (1) RELAX → trail length + laminar flow (drag). (Colour is band-truthful now; mood kept as an eased index only.)
    U.mood.value += (R - U.mood.value) * Math.min(1, dt * 1.5);
    U.drag.value = 0.95 + R * 0.045;                       // more drag = laminar when calm
    const f60 = dt * 60;                                   // feedback params are per-60fps-frame; scale for real dt
    U.decay.value = Math.pow(0.84 + R * 0.14, f60);        // longer trails when calm

    // (3) HEARTBEAT → forward motion, stepped per real beat (~3x slower than before, no default pace)
    U.zoom.value = ((0.0005 + b.delta * 0.0013) * this.drift + this.beat * 0.008) * f60;
    U.pulse.value = this.beat * 1.1;                        // radial pressure pulse through the particle field
    U.beat.value = this.beat;                              // capped brightness swell in post
    U.rot.value = st.gyro.z * 0.00015 * f60;              // real head roll only
    this.bloomNode.strength.value = 0.5 + F * 0.9 + this.beat * 1.2 + this.flash * 1.5;

    // head tilt AIMS where new paint is emitted (clear, screen-scale steer); gyro keeps subtle rotation
    U.aim.value.set(st.tilt.x * 2.3, st.tilt.y * 2.3, st.tilt.x * 0.4);
    this.group.rotation.y += dt * st.gyro.y * 0.002;
    this.group.rotation.x += (st.tilt.y * 0.4 - this.group.rotation.x) * 0.05;
    // beat dollies the camera forward through the accumulated paint, easing back between beats
    const camZ = 6 - this.beat * 1.3, camX = st.tilt.x * 1.2;
    this.cam.position.z += (camZ - this.cam.position.z) * Math.min(1, dt * 12);
    this.cam.position.x += (camX - this.cam.position.x) * 0.05;
    this.cam.lookAt(0, 0, 0);
    if (flow > 0.02 && this.rain.update(dt * flow, b.gamma)) this.rainTex.needsUpdate = true;

    r.compute(this.update);
    if (DEBUG === 'scene') { r.setRenderTarget(null); r.render(this.scene, this.cam); return; }
    r.setRenderTarget(this.sceneRT); r.render(this.scene, this.cam);
    this.prevNode.value = this.fbA.texture;
    r.setRenderTarget(this.fbB); this.quad.render(r);
    this.outNode.value = this.fbB.texture;
    // impasto: lay paint only while the water moves (beat flow); ~0.5%/s thinning keeps very long sessions from saturating
    U.deposit.value = flow * 0.08 * f60;
    U.paintKeep.value = Math.pow(0.995, dt);
    this.paintPrev.value = this.paintA.texture;
    r.setRenderTarget(this.paintB); this.paintQuad.render(r);
    for (const n of this.paintRead) n.value = this.paintB.texture;
    r.setRenderTarget(null); this.pipeline.render();
    [this.fbA, this.fbB] = [this.fbB, this.fbA];
    { const t = this.paintA; this.paintA = this.paintB; this.paintB = t; }

    if (this.snapReq) { this.snapReq = false; save(this.canvas); }
    this.adapt(dt);
  }
  /** drop resolution if frames run slow (>24ms avg for ~2s) */
  adapt(dt) {
    this.ftAvg += (dt * 1000 - this.ftAvg) * 0.05;
    this.slow = this.ftAvg > 24 ? this.slow + dt : 0;
    if (this.slow > 2 && this.pr > 0.6) { this.pr = Math.max(0.6, this.pr - 0.25); this.slow = 0; this.resize(); }
  }
}

export function save(canvas) {
  const a = document.createElement('a');
  a.download = `hbi-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  a.href = canvas.toDataURL('image/png'); a.click();
}
