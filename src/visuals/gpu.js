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
const NODES = [[-1.7, -0.9, 0.3], [-1.0, 1.1, 0.8], [1.0, 1.1, 0.8], [1.7, -0.9, 0.3]];

export class GpuScene {
  static async create(canvas) { const s = new GpuScene(canvas); await s.init(); return s; }
  constructor(canvas) {
    this.canvas = canvas; this.flash = 0; this.pulse = 0; this.snapReq = false;
    this.ftAvg = 16; this.slow = 0;
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
      const dt = min(deltaTime, 0.05);
      const nv = v.add(f.mul(dt)).mul(pow(U.drag, dt.mul(60)));     // frame-rate independent damping
      v.assign(nv.mul(min(float(1), float(5).div(nv.length().add(1e-4)))));   // speed cap
      p.addAssign(v.mul(dt));
      If(p.length().greaterThan(7.0), () => {
        const s = instanceIndex.mul(3).add(floor(time.mul(60)).toUint().mul(1000003));
        p.assign(vec3(hash(s), hash(s.add(1)), hash(s.add(2))).sub(0.5).mul(1.5));
        v.assign(vec3(0));
      });
    })().compute(N);

    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    mat.positionNode = pos.toAttribute();
    const speed = vel.toAttribute().length();
    const k = clamp(speed.mul(0.45), 0, 1);
    const calm = mix(vec3(0.0, 0.95, 1.0), vec3(0.45, 0.2, 1.0), k);   // cyan → violet
    const hot = mix(vec3(1.0, 0.08, 0.65), vec3(1.0, 0.62, 0.05), k);  // magenta → amber
    const col = mix(mix(hot, calm, U.mood), vec3(1.0), smoothstep(4.0, 9.0, speed));
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
    const fresh = sceneNode.rgb.add(rainNode.mul(U.rain));
    const fbCol = max(this.prevNode.rgb.mul(U.decay), fresh).add(fresh.mul(0.15))
      .add(vec3(0, 1, 0.9).mul(U.flash.mul(0.12)));
    const fbMat = new THREE.NodeMaterial();
    fbMat.fragmentNode = vec4(min(fbCol, vec3(2)), 1);
    this.quad = new THREE.QuadMesh(fbMat);

    // ---------- post: bloom → rgb split → scanlines/vignette/grain ----------
    this.outNode = texture(this.fbB.texture);
    this.bloomNode = bloom(this.outNode, 0.8, 0.45, 0.35);
    const shifted = rgbShift(this.outNode.add(this.bloomNode), U.shift);
    const s = screenUV;
    const scan = float(0.84).add(sin(s.y.mul(screenSize.y).mul(1.7)).mul(0.16));
    const vig = smoothstep(1.15, 0.35, s.sub(0.5).length().mul(1.4));
    const grain = hash(floor(s.x.mul(screenSize.x)).add(floor(s.y.mul(screenSize.y)).mul(4099)).add(floor(time.mul(60)).mul(7919))).sub(0.5).mul(0.05);
    this.pipeline = new THREE.RenderPipeline(r, vec4(shifted.rgb.add(vec3(0, 1, 0.9).mul(U.flash.mul(0.18))).mul(scan).mul(vig).add(grain), 1));

    this.resize();
    addEventListener('resize', () => this.resize());
    r.compute(init);
  }

  resize() {
    const r = this.renderer, w = innerWidth, h = innerHeight;
    r.setPixelRatio(this.pr); r.setSize(w, h, false);
    const pw = Math.max(1, Math.floor(w * this.pr)), ph = Math.max(1, Math.floor(h * this.pr));
    for (const rt of [this.sceneRT, this.fbA, this.fbB]) rt.setSize(pw, ph);
    this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
    this.u.aspect.value = w / h;
  }
  clear() {
    const r = this.renderer;
    for (const rt of [this.fbA, this.fbB]) { r.setRenderTarget(rt); r.clear(); }
    r.setRenderTarget(null); this.rain.clear();
  }
  onBeat() { this.pulse = 1.2; }
  onBlink() { this.flash = 1; }
  snapshot() { this.snapReq = true; }

  frame(st, dt) {
    const U = this.u, b = st.bands, r = this.renderer;
    st.ch.forEach((c, i) => { let m = 0; for (const k in c) m = Math.max(m, c[k]); this.attrVecs[i].w = 0.15 + m * 0.9; });
    U.turb.value = 0.6 + b.beta * 2.4 + b.gamma * 0.8;
    U.freq.value = 0.3 + b.theta * 0.9;
    U.drag.value = 0.955 + b.alpha * 0.035;
    this.pulse *= Math.pow(0.02, dt); U.pulse.value = this.pulse;
    this.flash *= Math.pow(0.005, dt); U.flash.value = this.flash;
    const moodT = Math.min(1, Math.max(0, 0.5 + (b.alpha + 0.5 * b.theta) - (b.beta + 0.5 * b.gamma)));
    U.mood.value += (moodT - U.mood.value) * Math.min(1, dt * 1.5);
    U.size.value = 0.02 + b.delta * 0.025;
    const f60 = dt * 60;                                   // feedback params are per-60fps-frame; scale for real dt
    U.decay.value = Math.pow(0.86 + b.alpha * 0.115, f60);
    U.zoom.value = (0.002 + b.delta * 0.01) * f60;
    U.rot.value = (0.0008 + st.gyro.z * 0.00015) * f60;
    U.smear.value = (0.001 + b.theta * 0.006) * Math.min(f60, 3);
    U.glitch.value = Math.min(0.9, b.beta * 0.12 + this.flash * 0.7);
    U.rain.value = 0.06 + b.gamma * 0.25;
    U.shift.value = 0.0012 + b.beta * 0.004 + this.flash * 0.02;
    this.bloomNode.strength.value = 0.5 + b.gamma + this.flash * 1.5;

    this.group.rotation.y += dt * (0.05 + st.gyro.y * 0.002);
    this.group.rotation.x += (st.tilt.y * 0.6 - this.group.rotation.x) * 0.05;
    this.cam.position.x += (st.tilt.x * 1.5 - this.cam.position.x) * 0.05;
    this.cam.lookAt(0, 0, 0);
    if (this.rain.update(dt, b.gamma)) this.rainTex.needsUpdate = true;

    r.compute(this.update);
    if (DEBUG === 'scene') { r.setRenderTarget(null); r.render(this.scene, this.cam); return; }
    r.setRenderTarget(this.sceneRT); r.render(this.scene, this.cam);
    this.prevNode.value = this.fbA.texture;
    r.setRenderTarget(this.fbB); this.quad.render(r);
    this.outNode.value = this.fbB.texture;
    r.setRenderTarget(null); this.pipeline.render();
    [this.fbA, this.fbB] = [this.fbB, this.fbA];

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
