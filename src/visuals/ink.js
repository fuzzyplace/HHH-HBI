// INK view: real-data ink injected into still water (raw WebGL2 stable fluids, no dependency).
//
// The pool is a top-down head map (nose up). Each EEG sensor is an injection site at its real
// position (AF7/AF8 forehead, TP9/TP10 ears); each site fans five band-coloured dye streams inward,
// each stream's amount = that sensor's band level x contact quality. The PPG sensor sits at forehead
// centre: every real heartbeat sends a soft radial velocity pulse (no dye) through the water and
// fires a dose burst from every live site. Between beats the water only carries its own momentum.
// relax -> viscosity (softer, slower spread), focus -> vorticity confinement (finer curls),
// gyro yaw/pitch -> gentle body force, roll -> slow rotation. Not live: the sim does not step,
// nothing is injected, existing ink holds still and fades very slowly to a black pool.
// Mapping table: docs/PLAN.md. Consumes only the `state` object.

import { Arms } from './arms.js';

const BANDS = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
// linear-ish emissive colours, match HUD: #8a4dff #ff2bd6 #00fff0 #ffb000 #ffffff
const COL = [
  [0.54, 0.30, 1.00], [1.00, 0.17, 0.84], [0.00, 1.00, 0.94], [1.00, 0.69, 0.00], [0.72, 0.74, 0.82],
];
const MAXS = 32;            // splat slots per pass (20 streams + 8 pulse spokes + blink)
const SIM_RES = 128;        // velocity grid, short side
const DYE_RES = 512;        // dye grid, short side
const PRESSURE_ITERS = 20;
// head-map site angles (radians from nose, clockwise on screen) + radial scale; order = channel index, 4 = PPG
const SITE_ANG = [-1.75, -0.55, 0.55, 1.75, 0];
const SITE_RAD = [1.0, 1.0, 1.0, 1.0, 0.94];
const ZERO3 = { x: 0, y: 0, z: 0 };
const deadzone = v => (Math.abs(v) < 4 ? 0 : v - Math.sign(v) * 4);   // gyro deg/s

const VS = `#version 300 es
precision highp float;
in vec2 aPos;
uniform vec2 uTexel;
out vec2 vUv, vL, vR, vT, vB;
void main(){
  vUv = aPos * 0.5 + 0.5;
  vL = vUv - vec2(uTexel.x, 0.0); vR = vUv + vec2(uTexel.x, 0.0);
  vT = vUv + vec2(0.0, uTexel.y); vB = vUv - vec2(0.0, uTexel.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;
const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB;
out vec4 o;
`;
const FS = {
  copy: `uniform sampler2D uSrc; uniform float uK;
    void main(){ o = texture(uSrc, vUv) * uK; }`,
  clear: `void main(){ o = vec4(0.0); }`,
  curl: `uniform sampler2D uVel;
    void main(){
      float L = texture(uVel, vL).y, R = texture(uVel, vR).y, T = texture(uVel, vT).x, B = texture(uVel, vB).x;
      o = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }`,
  vort: `uniform sampler2D uVel, uCurl; uniform float uCurlK, uDt;
    void main(){
      float L = texture(uCurl, vL).x, R = texture(uCurl, vR).x, T = texture(uCurl, vT).x, B = texture(uCurl, vB).x;
      float C = texture(uCurl, vUv).x;
      vec2 f = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      f /= length(f) + 1e-4; f *= uCurlK * C; f.y *= -1.0;
      vec2 v = texture(uVel, vUv).xy + f * uDt;
      o = vec4(clamp(v, -600.0, 600.0), 0.0, 1.0);
    }`,
  div: `uniform sampler2D uVel;
    void main(){
      float L = texture(uVel, vL).x, R = texture(uVel, vR).x, T = texture(uVel, vT).y, B = texture(uVel, vB).y;
      vec2 C = texture(uVel, vUv).xy;
      if (vL.x < 0.0) L = -C.x; if (vR.x > 1.0) R = -C.x;
      if (vT.y > 1.0) T = -C.y; if (vB.y < 0.0) B = -C.y;
      o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }`,
  pres: `uniform sampler2D uP, uDiv;
    void main(){
      float L = texture(uP, vL).x, R = texture(uP, vR).x, T = texture(uP, vT).x, B = texture(uP, vB).x;
      o = vec4((L + R + B + T - texture(uDiv, vUv).x) * 0.25, 0.0, 0.0, 1.0);
    }`,
  grad: `uniform sampler2D uP, uVel;
    void main(){
      float L = texture(uP, vL).x, R = texture(uP, vR).x, T = texture(uP, vT).x, B = texture(uP, vB).x;
      vec2 v = texture(uVel, vUv).xy - vec2(R - L, T - B);
      o = vec4(v, 0.0, 1.0);
    }`,
  // explicit viscous diffusion step (stable for uK <= 0.5)
  visc: `uniform sampler2D uVel; uniform float uK;
    void main(){
      vec2 C = texture(uVel, vUv).xy;
      vec2 n = 0.25 * (texture(uVel, vL).xy + texture(uVel, vR).xy + texture(uVel, vT).xy + texture(uVel, vB).xy);
      o = vec4(mix(C, n, uK), 0.0, 1.0);
    }`,
  // semi-Lagrangian advection; velocity is in sim texels / second
  adv: `uniform sampler2D uVel, uSrc; uniform vec2 uSimTexel; uniform float uDt, uDiss;
    void main(){
      vec2 c = vUv - uDt * texture(uVel, vUv).xy * uSimTexel;
      o = texture(uSrc, c) / (1.0 + uDiss * uDt);
    }`,
  // velocity splats + beat spokes + head-motion body force/rotation
  splatV: `uniform sampler2D uVel; uniform vec4 uP[${MAXS}]; uniform vec4 uV[${MAXS}]; uniform int uN;
    uniform float uAspect; uniform vec2 uCenter; uniform vec2 uForce; uniform float uSpin;
    void main(){
      vec2 v = texture(uVel, vUv).xy;
      for (int i = 0; i < ${MAXS}; i++) {
        if (i >= uN) break;
        vec2 d = vUv - uP[i].xy; d.x *= uAspect;
        v += uV[i].xy * exp(-dot(d, d) / uP[i].z);
      }
      vec2 dc = vUv - uCenter; dc.x *= uAspect;
      float w = exp(-dot(dc, dc) / 0.30);
      v += uForce * w + uSpin * vec2(-dc.y, dc.x) * w;
      o = vec4(v, 0.0, 1.0);
    }`,
  splatD: `uniform sampler2D uDye; uniform vec4 uP[${MAXS}]; uniform vec4 uC[${MAXS}]; uniform int uN; uniform float uAspect;
    void main(){
      vec3 c = texture(uDye, vUv).rgb;
      for (int i = 0; i < ${MAXS}; i++) {
        if (i >= uN) break;
        vec2 d = vUv - uP[i].xy; d.x *= uAspect;
        c += uC[i].rgb * exp(-dot(d, d) / uP[i].z);
      }
      o = vec4(min(c, vec3(6.0)), 1.0);
    }`,
  // final image: near-black water, ink tone-mapped like dense pigment lit from below, soft glow,
  // edge-only chromatic aberration, static scanlines (no time term: a still pool is truly still)
  show: `uniform sampler2D uDye; uniform vec2 uDyeTexel; uniform vec2 uRes; uniform vec4 uHead; uniform float uOutline; uniform float uCA;
    const vec2 G[8] = vec2[8](vec2(1,0), vec2(-1,0), vec2(0,1), vec2(0,-1), vec2(.7,.7), vec2(-.7,.7), vec2(.7,-.7), vec2(-.7,-.7));
    void main(){
      vec2 uv = vUv, dc = uv - 0.5;
      float ca = uCA * dot(dc, dc);
      vec3 c = vec3(texture(uDye, uv + dc * ca).r, texture(uDye, uv).g, texture(uDye, uv - dc * ca).b);
      vec3 g = vec3(0.0);
      for (int k = 0; k < 8; k++) g += texture(uDye, uv + G[k] * uDyeTexel * 9.0).rgb;
      g *= 0.125;
      // density gradient shading gives plumes volume (billowing body, darker folds)
      float dl = length(texture(uDye, uv - vec2(uDyeTexel.x, 0.0)).rgb), dr = length(texture(uDye, uv + vec2(uDyeTexel.x, 0.0)).rgb);
      float dt = length(texture(uDye, uv + vec2(0.0, uDyeTexel.y)).rgb), db = length(texture(uDye, uv - vec2(0.0, uDyeTexel.y)).rgb);
      vec3 n = normalize(vec3(dr - dl, dt - db, 0.35));
      float shade = clamp(0.72 + 0.45 * dot(n, normalize(vec3(-0.4, 0.6, 0.7))), 0.45, 1.25);
      // hue-preserving saturation: dense ink stays its band colour instead of washing to white
      float Lc = max(max(c.r, c.g), c.b), Lg = max(max(g.r, g.g), g.b);
      vec3 ink = c * ((1.0 - exp(-Lc * 1.5)) / max(Lc, 1e-4)) * shade + g * ((1.0 - exp(-Lg * 0.9)) / max(Lg, 1e-4)) * 0.35;
      // water: near-black with a faint cold depth gradient + vignette
      vec2 px = uv * uRes;
      float vig = smoothstep(1.25, 0.25, length(dc * vec2(uRes.x / uRes.y, 1.0)));
      vec3 water = mix(vec3(0.004, 0.005, 0.010), vec3(0.012, 0.018, 0.030), vig);
      vec3 col = water + ink * (0.55 + 0.45 * vig);
      // faint head map (live only): ellipse ring + nose tick
      if (uOutline > 0.0) {
        vec2 q = (px - uHead.xy) / uHead.zw;
        float e = abs(length(q) - 1.0) * min(uHead.z, uHead.w);
        float ring = smoothstep(1.4, 0.0, e);
        vec2 nq = px - (uHead.xy + vec2(0.0, uHead.w * 1.0));
        float nose = smoothstep(1.4, 0.0, abs(abs(nq.x) * 1.6 - (uHead.w * 0.09 - nq.y))) * step(0.0, nq.y) * step(nq.y, uHead.w * 0.09);
        col += vec3(0.25, 0.85, 0.95) * (ring + nose) * 0.07 * uOutline;
      }
      col *= 0.95 + 0.05 * step(0.5, fract(px.y * 0.5));
      o = vec4(col, 1.0);
    }`,
};

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('ink shader: ' + gl.getShaderInfoLog(s));
  return s;
}
function program(gl, vs, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, HEAD + fsSrc));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('ink link: ' + gl.getProgramInfoLog(p));
  const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

export class InkView {
  constructor(fluidCanvas, armsCanvas) {
    const gl = fluidCanvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.canvas = fluidCanvas; this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) throw new Error('float render targets unavailable');
    gl.getExtension('OES_texture_float_linear');
    this.fmtRGBA = this._format(gl.RGBA16F, gl.RGBA);
    this.fmtRG = this._format(gl.RG16F, gl.RG) || this.fmtRGBA;
    this.fmtR = this._format(gl.R16F, gl.RED) || this.fmtRG;
    if (!this.fmtRGBA) throw new Error('half-float render targets unavailable');

    const vs = compile(gl, gl.VERTEX_SHADER, VS);
    this.P = {};
    for (const k in FS) this.P[k] = program(gl, vs, FS[k]);
    // one big triangle covers the viewport
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);

    // per-frame scratch (no allocations in frame)
    this.sP = new Float32Array(MAXS * 4); this.sV = new Float32Array(MAXS * 4); this.sC = new Float32Array(MAXS * 4);
    this.dP = new Float32Array(MAXS * 4); this.dC = new Float32Array(MAXS * 4);
    this.dose = new Float32Array(5);       // per-site dose envelope (beat burst), 4 = pump
    this.active = new Uint8Array(4);
    this.sites = Array.from({ length: 5 }, () => ({ x: 0, y: 0 }));   // CSS px, channel order + PPG
    this.dirs = Array.from({ length: 4 }, () => ({ x: 0, y: 0 }));    // inward unit dirs (uv space, y up)
    this.head = { x: 0, y: 0, rx: 0, ry: 0 };
    this.relaxS = 0.5; this.focusS = 0.5; this.live = false; this.outline = 0;
    this.gy = 0; this.gp = 0; this.gr = 0;  // smoothed gyro yaw / pitch / roll
    this.pulse = 0; this.pulseSeed = 0; this.blink = 0;
    this.ftAvg = 16; this.slow = 0; this.pr = Math.min(devicePixelRatio || 1, 1.25); this.iters = PRESSURE_ITERS;
    this.snapReq = false;

    this.arms = null;
    if (armsCanvas) {
      try { this.arms = new Arms(armsCanvas); }
      catch (e) { console.warn('arms overlay unavailable', e); armsCanvas.hidden = true; }
    }
    this.resize();
    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize);
  }

  // ---------- GL resources ----------
  _format(internal, format) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, gl.HALF_FLOAT, null);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(f); gl.deleteTexture(t);
    return ok ? { internal, format } : null;
  }
  _fbo(w, h, fmt) {
    const gl = this.gl, tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, fmt.format, gl.HALF_FLOAT, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb, w, h, tx: 1 / w, ty: 1 / h };
  }
  _double(w, h, fmt) {
    const d = { read: this._fbo(w, h, fmt), write: this._fbo(w, h, fmt), swap() { const t = this.read; this.read = this.write; this.write = t; } };
    return d;
  }
  _free(f) { if (!f) return; const gl = this.gl; gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fb); }
  _freeD(d) { if (d) { this._free(d.read); this._free(d.write); } }
  _use(P, texel) { const gl = this.gl; gl.useProgram(P.p); if (P.u.uTexel) gl.uniform2f(P.u.uTexel, texel.tx, texel.ty); }
  _tex(P, name, f, unit) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, f.tex); gl.uniform1i(P.u[name], unit); }
  _draw(target) {
    const gl = this.gl;
    if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb); gl.viewport(0, 0, target.w, target.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  _resample(src, dst) {   // keep ink across resizes
    const P = this.P.copy; this._use(P, dst);
    this._tex(P, 'uSrc', src, 0); this.gl.uniform1f(P.u.uK, 1); this._draw(dst);
  }

  _grid(res, w, h) {
    const a = w / h;
    return a >= 1 ? [Math.round(res * a), res] : [res, Math.round(res / a)];
  }

  resize() {
    const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
    this.cssW = w; this.cssH = h;
    this.canvas.width = Math.max(1, Math.floor(w * this.pr)); this.canvas.height = Math.max(1, Math.floor(h * this.pr));
    const [sw, sh] = this._grid(SIM_RES, w, h), [dw, dh] = this._grid(this.dyeRes || DYE_RES, w, h);
    if (!this.vel || this.vel.read.w !== sw || this.vel.read.h !== sh) {
      const old = this.vel;
      this.vel = this._double(sw, sh, this.fmtRG);
      if (old) { this._resample(old.read, this.vel.read); this._freeD(old); }
      this._freeD(this.pres); this._free(this.divg); this._free(this.curl);
      this.pres = this._double(sw, sh, this.fmtR);
      this.divg = this._fbo(sw, sh, this.fmtR);
      this.curl = this._fbo(sw, sh, this.fmtR);
    }
    if (!this.dye || this.dye.read.w !== dw || this.dye.read.h !== dh) {
      const old = this.dye;
      this.dye = this._double(dw, dh, this.fmtRGBA);
      if (old) { this._resample(old.read, this.dye.read); this._freeD(old); }
    }
    this.aspect = w / h;
    this._layout(w, h);
    this.arms?.resize(w, h, this.sites, this.head);
  }

  /** top-down head map, nose up, centred in the space above the dock */
  _layout(w, h) {
    const R = Math.min(w * 0.30, h * 0.24), cx = w / 2, cy = h * 0.42;
    const H = this.head; H.x = cx; H.y = cy; H.rx = R * 0.82; H.ry = R;
    for (let i = 0; i < 5; i++) {
      const a = SITE_ANG[i], s = SITE_RAD[i];
      this.sites[i].x = cx + Math.sin(a) * H.rx * s;
      this.sites[i].y = cy - Math.cos(a) * H.ry * s;
    }
    for (let i = 0; i < 4; i++) {   // inward direction toward head centre (slightly below it), uv space y-up
      const dx = cx - this.sites[i].x, dy = -((cy + R * 0.15) - this.sites[i].y), l = Math.hypot(dx, dy) || 1;
      this.dirs[i].x = dx / l; this.dirs[i].y = dy / l;
    }
    this.Rn = R / h;   // head radius in height-normalised units
  }

  // ---------- view interface ----------
  onBeat(strength = 1) {
    if (!this.live) return;
    const s = Math.max(0, Math.min(1, strength));
    this.pulse = Math.max(this.pulse, 0.35 + s * 0.65);   // consumed next frame as one impulse
    this.pulseSeed = Math.random() * Math.PI * 2;
    for (let i = 0; i < 4; i++) if (this.active[i]) this.dose[i] = 1;
    this.dose[4] = 1;
    this.arms?.onBeat(s, this.active);
  }
  onBlink() { if (this.live) this.blink = 1; }
  clear() {
    const gl = this.gl, P = this.P.clear;
    gl.useProgram(P.p);
    for (const f of [this.dye.read, this.dye.write, this.vel.read, this.vel.write, this.pres.read, this.pres.write]) this._draw(f);
    this.dose.fill(0); this.pulse = 0; this.blink = 0;
  }
  snapshot() { this.snapReq = true; }

  frame(st, dt) {
    const d = Math.min(1 / 30, Math.max(0, dt || 0.016));
    const live = (this.live = st.ready === 'live');
    const ke = Math.min(1, d * 1.2);
    this.relaxS += ((st.relax ?? 0.5) - this.relaxS) * ke;
    this.focusS += ((st.focus ?? 0.5) - this.focusS) * ke;
    this.outline += ((live ? 1 : 0) - this.outline) * Math.min(1, d * 1.5);
    if (!live) this.outline = 0;   // outline only while live

    for (let i = 0; i < 4; i++) {
      const q = st.quality?.[i], lab = q?.label;
      this.active[i] = live && (lab === 'good' || lab === 'noisy') && !st.held?.[i] ? 1 : 0;
      if (!this.active[i]) this.dose[i] = 0;
    }

    if (live) this._step(st, d);
    else this._fade(d);
    this._show();
    if (this.snapReq) { this.snapReq = false; this._save(); }

    this.arms?.frame(st, d, this.dose, this.active);
    const decay = Math.exp(-d / 0.28);
    for (let i = 0; i < 5; i++) this.dose[i] *= decay;
    this._adapt(dt);
  }

  // ---------- simulation ----------
  _step(st, dt) {
    const gl = this.gl, P = this.P, vel = this.vel, R = this.relaxS, F = this.focusS;
    const simH = vel.read.h, Rn = this.Rn, asp = this.aspect;
    const hx = this.head.x / this.cssW, hy = 1 - this.head.y / this.cssH;

    // head motion: smoothed, dead-zoned, capped (deg/s). yaw=z, pitch=x, roll=y (Muse IMU axes)
    const g = st.gyro || ZERO3, dz = deadzone;
    const kg = Math.min(1, dt * 2.5);
    this.gy += (Math.max(-1, Math.min(1, dz(g.z) / 80)) - this.gy) * kg;
    this.gp += (Math.max(-1, Math.min(1, dz(g.x) / 80)) - this.gp) * kg;
    this.gr += (Math.max(-1, Math.min(1, dz(g.y) / 90)) - this.gr) * kg;

    // ---- velocity impulses: dose jets, beat spokes, blink stir ----
    const sP = this.sP, sV = this.sV, dP = this.dP, dC = this.dC;
    let n = 0, m = 0;
    const trickle = st.bpm > 0 ? 0.05 : 0;   // no pulse lock → no water motion at all
    const jr = (Rn * 0.06) ** 2, sr = (Rn * 0.026) ** 2;
    for (let i = 0; i < 4; i++) {
      if (!this.active[i]) continue;
      const q = Math.max(0, Math.min(1, st.quality[i].score ?? 0)), ch = st.ch[i];
      const dx = this.dirs[i].x, dy = this.dirs[i].y, px = this.sites[i].x / this.cssW, py = 1 - this.sites[i].y / this.cssH;
      const dose = this.dose[i];
      for (let b = 0; b < 5; b++) {
        const lvl = Math.pow(Math.max(0, (ch[BANDS[b]] || 0) - 0.04), 1.6) * q;   // contrast curve: dominant bands win the colour
        const amt = lvl * (dose * 5.0 + trickle);        // burst on beat + very faint trickle (only with a heart lock)
        if (amt < 2e-4) continue;
        const a = (b - 2) * 0.36, ca = Math.cos(a), sa = Math.sin(a);
        const ux = dx * ca - dy * sa, uy = dx * sa + dy * ca;   // fanned stream direction
        const off = Rn * 0.075, jit = Rn * 0.005;
        const x = px + (ux * off + (Math.random() - 0.5) * jit) / asp, y = py + uy * off + (Math.random() - 0.5) * jit;
        if (m < MAXS) {
          const o = m * 4; m++;
          dP[o] = x; dP[o + 1] = y; dP[o + 2] = sr;
          dC[o] = COL[b][0] * amt * dt * 3.4; dC[o + 1] = COL[b][1] * amt * dt * 3.4; dC[o + 2] = COL[b][2] * amt * dt * 3.4;
        }
        if (n < MAXS) {
          const o = n * 4, sp = (dose * 110 + 4 * trickle * 20) * (0.4 + lvl) * dt;   // jet carries the stream inward
          n++;
          sP[o] = x; sP[o + 1] = y; sP[o + 2] = jr;
          sV[o] = ux * sp; sV[o + 1] = uy * sp;
        }
      }
    }
    if (this.pulse > 0) {   // soft radial heartbeat pulse from the PPG site: 8 outward spokes (survive projection as vortex pairs)
      const cx = this.sites[4].x / this.cssW, cy = 1 - this.sites[4].y / this.cssH;
      const pr = (Rn * 0.2) ** 2, r0 = Rn * 0.22;
      for (let k = 0; k < 8 && n < MAXS; k++) {
        const a = this.pulseSeed + k * (Math.PI / 4) + (Math.random() - 0.5) * 0.3, ux = Math.cos(a), uy = Math.sin(a);
        const o = n * 4, sp = this.pulse * 70 * (0.8 + Math.random() * 0.4);
        n++;
        sP[o] = cx + (ux * r0) / asp; sP[o + 1] = cy + uy * r0; sP[o + 2] = pr;
        sV[o] = ux * sp; sV[o + 1] = uy * sp;
      }
      this.pulse = 0;
    }
    if (this.blink > 0) {   // small stir at the forehead sites
      for (let i = 1; i <= 2 && n < MAXS; i++) {
        const a = Math.random() * Math.PI * 2, o = n * 4; n++;
        sP[o] = this.sites[i].x / this.cssW; sP[o + 1] = 1 - this.sites[i].y / this.cssH; sP[o + 2] = (Rn * 0.12) ** 2;
        sV[o] = Math.cos(a) * 30; sV[o + 1] = Math.sin(a) * 30;
      }
      this.blink = 0;
    }

    // ---- velocity pass: splats + body force + rotation ----
    const fx = this.gy * 22 * dt, fy = -this.gp * 22 * dt, spin = this.gr * 0.25 * simH * dt;
    let Q = P.splatV; this._use(Q, vel.read);
    this._tex(Q, 'uVel', vel.read, 0);
    gl.uniform4fv(Q.u.uP, sP); gl.uniform4fv(Q.u.uV, sV); gl.uniform1i(Q.u.uN, n);
    gl.uniform1f(Q.u.uAspect, asp); gl.uniform2f(Q.u.uCenter, hx, hy); gl.uniform2f(Q.u.uForce, fx, fy); gl.uniform1f(Q.u.uSpin, spin);
    this._draw(vel.write); vel.swap();

    // ---- dye splats ----
    if (m > 0) {
      Q = P.splatD; this._use(Q, this.dye.read);
      this._tex(Q, 'uDye', this.dye.read, 0);
      gl.uniform4fv(Q.u.uP, dP); gl.uniform4fv(Q.u.uC, dC); gl.uniform1i(Q.u.uN, m); gl.uniform1f(Q.u.uAspect, asp);
      this._draw(this.dye.write); this.dye.swap();
    }

    // ---- curl + vorticity confinement (focus → finer, tighter curls) ----
    Q = P.curl; this._use(Q, vel.read); this._tex(Q, 'uVel', vel.read, 0); this._draw(this.curl);
    Q = P.vort; this._use(Q, vel.read);
    this._tex(Q, 'uVel', vel.read, 0); this._tex(Q, 'uCurl', this.curl, 1);
    gl.uniform1f(Q.u.uCurlK, 5 + F * 22); gl.uniform1f(Q.u.uDt, dt);
    this._draw(vel.write); vel.swap();

    // ---- viscosity (relax → thicker, softer water) ----
    const vk = Math.min(0.5, (0.04 + R * 0.22) * dt * 60);
    Q = P.visc; this._use(Q, vel.read); this._tex(Q, 'uVel', vel.read, 0); gl.uniform1f(Q.u.uK, vk);
    this._draw(vel.write); vel.swap();

    // ---- projection ----
    Q = P.div; this._use(Q, vel.read); this._tex(Q, 'uVel', vel.read, 0); this._draw(this.divg);
    Q = P.copy; this._use(Q, this.pres.read); this._tex(Q, 'uSrc', this.pres.read, 0); gl.uniform1f(Q.u.uK, 0.8);
    this._draw(this.pres.write); this.pres.swap();
    Q = P.pres; this._use(Q, this.pres.read); this._tex(Q, 'uDiv', this.divg, 1);
    for (let k = 0; k < this.iters; k++) {
      this._tex(Q, 'uP', this.pres.read, 0); this._draw(this.pres.write); this.pres.swap();
    }
    Q = P.grad; this._use(Q, vel.read);
    this._tex(Q, 'uP', this.pres.read, 0); this._tex(Q, 'uVel', vel.read, 1);
    this._draw(vel.write); vel.swap();

    // ---- advection: low dissipation so plumes keep billowing slowly; momentum decays to rest without beats ----
    Q = P.adv; this._use(Q, vel.read);
    gl.uniform2f(Q.u.uSimTexel, vel.read.tx, vel.read.ty); gl.uniform1f(Q.u.uDt, dt);
    this._tex(Q, 'uVel', vel.read, 0); this._tex(Q, 'uSrc', vel.read, 1);
    gl.uniform1f(Q.u.uDiss, 0.35 + R * 0.25);
    this._draw(vel.write); vel.swap();
    this._use(Q, this.dye.read);
    gl.uniform2f(Q.u.uSimTexel, vel.read.tx, vel.read.ty);
    this._tex(Q, 'uVel', vel.read, 0); this._tex(Q, 'uSrc', this.dye.read, 1);
    gl.uniform1f(Q.u.uDiss, 0.05);
    this._draw(this.dye.write); this.dye.swap();
  }

  /** not live: no stepping, no injection; ink holds still and fades to a black pool (half-life ~30s) */
  _fade(dt) {
    const Q = this.P.copy; this._use(Q, this.dye.read);
    this._tex(Q, 'uSrc', this.dye.read, 0); this.gl.uniform1f(Q.u.uK, Math.exp(-dt * 0.023));
    this._draw(this.dye.write); this.dye.swap();
  }

  _show(noOutline = false) {
    const gl = this.gl, Q = this.P.show, W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, s = W / this.cssW;
    this._use(Q, this.dye.read);
    this._tex(Q, 'uDye', this.dye.read, 0);
    gl.uniform2f(Q.u.uDyeTexel, this.dye.read.tx, this.dye.read.ty);
    gl.uniform2f(Q.u.uRes, W, H);
    gl.uniform4f(Q.u.uHead, this.head.x * s, H - this.head.y * s, this.head.rx * s, this.head.ry * s);
    gl.uniform1f(Q.u.uOutline, noOutline ? 0 : this.outline);
    gl.uniform1f(Q.u.uCA, 0.012);
    this._draw(null);
  }

  _save() {
    this._show(true);   // snapshot = fluid only (no head outline; arms live on their own canvas)
    const a = document.createElement('a');
    a.download = `hbi-ink-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.href = this.canvas.toDataURL('image/png'); a.click();
    this._show();
  }

  /** frames running slow (>22ms avg for ~2s): drop pressure iterations, then pixel ratio, then dye res */
  _adapt(dt) {
    this.ftAvg += (dt * 1000 - this.ftAvg) * 0.05;
    this.slow = this.ftAvg > 22 ? this.slow + dt : 0;
    if (this.slow < 2) return;
    this.slow = 0; this.ftAvg = 16;
    if (this.iters > 12) this.iters = 12;
    else if (this.pr > 0.75) { this.pr = Math.max(0.75, this.pr - 0.25); this.resize(); }
    else if ((this.dyeRes || DYE_RES) > 256) { this.dyeRes = 256; this.resize(); }
  }
}
