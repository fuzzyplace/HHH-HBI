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
// PLAY (st.play): a sixth stylus arm follows st.head and stirs the water with the user's real head motion (even between
// beats); blink drops ink from the forehead nozzles, clench ripples from the cortex. BREATHE (st.breath.on): the injector
// nozzles retract/extend with st.breath.level (dye follows the nozzles), the cortex swells, a guide ring breathes; harmony
// (st.harmony) warms the machine gold and weaves a pulse-gated gold thread between the sensor sites.
// Mapping table: docs/PLAN.md. Consumes only the `state` object.

import { Arms } from './arms.js';

const BANDS = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
// linear-ish emissive colours, match HUD: #8a4dff #ff2bd6 #00fff0 #ffb000 #ffffff
const COL = [
  [0.54, 0.30, 1.00], [1.00, 0.17, 0.84], [0.00, 1.00, 0.94], [1.00, 0.69, 0.00], [0.72, 0.74, 0.82],
];
const MAXS = 64;            // splat slots per pass (20 streams + 8 pulse spokes + blink + PLAY stylus/droplets/ripple + gold thread)
const SIM_RES = 128;        // velocity grid, short side
const DYE_RES = 512;        // dye grid, short side
const PRESSURE_ITERS = 20;
const MOTE_W = 64, MOTE_H = 24;   // 1536 suspended motes in 3 depth layers
const CORTEX_RES = 384;
const CAM_FOV = 30;               // must match arms.js FOV (pool plane maps 1:1 to CSS px)
// head-map site angles (radians from nose, clockwise on screen) + radial scale; order = channel index, 4 = PPG
const SITE_ANG = [-1.75, -0.55, 0.55, 1.75, 0];
const SITE_RAD = [1.0, 1.0, 1.0, 1.0, 0.94];
const ZERO3 = { x: 0, y: 0, z: 0 };
const ZERO2 = { x: 0, y: 0 };
const GOLD = [1.0, 0.80, 0.42];   // harmony thread: pale champagne gold (kept off beta's deeper amber)
const LUNG = 0.32;                // breathe guide: nozzle retraction at empty lungs, in head radii (tips on their sites when full)
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
  // bright-ink extract for bloom (4-tap box downsample, ink tone curve, soft threshold)
  bright: `uniform sampler2D uDye; uniform vec2 uDyeTexel;
    vec3 tone(vec3 c){ float L = max(max(c.r, c.g), c.b); vec3 h = pow(c / max(L, 1e-4), vec3(1.6)); return h * (1.0 - exp(-L * 1.6)); }
    void main(){
      vec2 e = uDyeTexel * 1.5;
      vec3 c = 0.25 * (texture(uDye, vUv + vec2(e.x, e.y)).rgb + texture(uDye, vUv - vec2(e.x, e.y)).rgb
                     + texture(uDye, vUv + vec2(e.x, -e.y)).rgb + texture(uDye, vUv - vec2(e.x, -e.y)).rgb);
      vec3 t = tone(c);
      o = vec4(t * smoothstep(0.28, 0.9, max(max(t.r, t.g), t.b)), 1.0);
    }`,
  // separable 9-tap gaussian (5 linear fetches)
  blur: `uniform sampler2D uSrc; uniform vec2 uDir;
    void main(){
      vec3 c = texture(uSrc, vUv).rgb * 0.2270270;
      c += (texture(uSrc, vUv + uDir * 1.3846154).rgb + texture(uSrc, vUv - uDir * 1.3846154).rgb) * 0.3162162;
      c += (texture(uSrc, vUv + uDir * 3.2307692).rgb + texture(uSrc, vUv - uDir * 3.2307692).rgb) * 0.0702703;
      o = vec4(c, 1.0);
    }`,
  // one-off bake (on resize): procedural cortex seen from above, nose up. Head-local q in [-1.15,1.15]^2 (unit = head radii).
  // out: normal.xy, gyrus ridge 0..1, dome height (0 outside the brain)
  cortexBake: `
    float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y) * 2.0 - 1.0; }
    float dome(vec2 q){
      vec2 p = q / vec2(0.86, 0.90); p.y += 0.04;
      float hx = abs(p.x);
      float rx = 1.0 - 0.16 * max(p.y, 0.0) + 0.04 * min(p.y, 0.0); // narrower frontal, wider occipital
      vec2 e = vec2(p.x / rx, p.y);
      float d = sqrt(max(0.0, 1.0 - dot(e, e)));
      float fis = mix(0.25, 1.0, smoothstep(0.0, 0.07, hx));          // longitudinal fissure (a groove, not a gap)
      return d * fis * smoothstep(0.0, 0.03, d);
    }
    float folds(vec2 q){
      vec2 w = vec2(vn(q * 2.3), vn(q * 2.3 + 17.1)) * 0.42;
      float a = 1.0 - abs(vn(q * 6.2 + w * 2.0));
      float b = 1.0 - abs(vn(q * 12.5 + w * 3.0 + 5.3));
      return pow(a, 3.0) * 0.72 + pow(b, 3.0) * 0.28;
    }
    float H(vec2 q){ float d = dome(q); return d * (0.80 + 0.20 * folds(q)) ; }
    void main(){
      vec2 q = (vUv * 2.0 - 1.0) * 1.15;
      float e = 0.004, h = H(q);
      vec2 g = vec2(H(q + vec2(e, 0.0)) - H(q - vec2(e, 0.0)), H(q + vec2(0.0, e)) - H(q - vec2(0.0, e))) / (2.0 * e);
      vec3 n = normalize(vec3(-g * 0.18, 1.0));
      o = vec4(n.xy, folds(q), dome(q));
    }`,
  // final image: deep water + machine floor + hologram cortex (all under the ink, refracted by it),
  // ink as lit liquid (hue-saturated pigment, density-normal diffuse + specular sheen, subsurface bloom),
  // edge-only chromatic aberration, static scanlines (no time term: a still pool is truly still)
  show: `uniform sampler2D uDye, uBloom, uCortex; uniform vec2 uDyeTexel; uniform vec2 uRes; uniform vec4 uHead; uniform float uOutline; uniform float uCA;
    uniform vec3 uCtx;            // cortex centre (px, after parallax) + scale (px per head-radius unit, y)
    uniform float uCAsp;          // head rx / ry
    uniform vec3 uFloor;          // floor centre (px) + scale
    uniform vec3 uSC[4];          // per-sensor light colour (dominant-band colour x level x quality)
    uniform vec2 uScan;           // heart-clock scan: phase, strength
    uniform float uWake, uPr;
    uniform vec3 uBr;             // BREATHE: lung level x on, harmony gold, PLAY clench flash (all 0 when off)
    const vec2 SQ[4] = vec2[4](vec2(-0.984, -0.178), vec2(-0.523, 0.852), vec2(0.523, 0.852), vec2(0.984, -0.178));
    float dens(vec2 p){ vec3 c = texture(uDye, p).rgb; return 1.0 - exp(-max(max(c.r, c.g), c.b) * 1.4); }
    void main(){
      vec2 uv = vUv, dc = uv - 0.5, px = uv * uRes;
      float ca = uCA * dot(dc, dc);
      vec3 c = vec3(texture(uDye, uv + dc * ca).r, texture(uDye, uv).g, texture(uDye, uv - dc * ca).b);
      float Lc = max(max(c.r, c.g), c.b);
      float thick = 1.0 - exp(-Lc * 1.4);
      // liquid surface normal from the (saturating) density field
      vec2 e = uDyeTexel * 1.5;
      float dl = dens(uv - vec2(e.x, 0.0)), dr = dens(uv + vec2(e.x, 0.0)), dt = dens(uv + vec2(0.0, e.y)), db = dens(uv - vec2(0.0, e.y));
      vec3 n = normalize(vec3((dl - dr) * 2.2, (db - dt) * 2.2, 1.0));
      vec2 refr = n.xy * 26.0 * uPr * (0.25 + thick);                 // what lies beneath bends through the ink
      // ---- beneath: deep-water gradient + faint machine floor grid (deepest layer, strongest parallax) ----
      vec2 bp = px + refr;
      float asp = uRes.x / uRes.y;
      float vig = smoothstep(1.3, 0.2, length(dc * vec2(asp, 1.0)));
      vec3 water = mix(vec3(0.002, 0.003, 0.008), vec3(0.010, 0.020, 0.040), vig);
      vec2 fq = (bp - uFloor.xy) / uFloor.z;
      vec2 gq = abs(fract(fq * 3.0) - 0.5);
      float grid = 1.0 - smoothstep(0.0, 3.0 * fwidth(fq.x) * 1.4, min(gq.x, gq.y));
      water += vec3(0.0, 0.10, 0.14) * grid * 0.18 * smoothstep(2.2, 0.4, length(fq)) * (0.35 + 0.65 * uWake);
      // ---- hologram cortex ----
      vec2 q = (bp - uCtx.xy) / uCtx.z; q.x /= uCAsp;
      vec3 holo = vec3(0.0);
      if (uWake > 0.001 && abs(q.x) < 1.15 && abs(q.y) < 1.15) {
        vec4 cx = texture(uCortex, q / 2.3 + 0.5);
        float m = smoothstep(0.0, 0.12, cx.w);
        vec3 N = vec3(cx.xy, sqrt(max(0.0, 1.0 - dot(cx.xy, cx.xy))));
        float fres = pow(1.0 - N.z, 1.5) + 0.35 * (1.0 - smoothstep(0.0, 0.25, cx.w));
        float ridge = cx.z;
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 4; i++) {
          vec2 d = q - SQ[i];
          float fall = exp(-dot(d, d) * 1.5);
          acc += uSC[i] * fall * (0.3 + max(dot(N, normalize(vec3(-d, 0.6))), 0.0));
        }
        float scan = 0.78 + 0.22 * step(0.5, fract(px.y / (3.0 * uPr)));   // static hologram raster
        float sweep = uScan.y * exp(-pow((q.y - (1.1 - 2.2 * uScan.x)) * 6.0, 2.0));
        holo = (vec3(0.03, 0.30, 0.42) * (fres * 0.8 + ridge * 0.10) + acc * (0.22 + 1.1 * fres + 0.55 * ridge)
              + vec3(0.5, 0.9, 1.0) * sweep * (0.15 + ridge) * 0.35) * m * scan * uWake;
        if (uBr.x > 0.0 || uBr.y > 0.0 || uBr.z > 0.0) {   // additive only, so off = the exact pre-existing image
          holo += (vec3(0.03, 0.30, 0.42) * (0.25 + 0.6 * fres) + acc * 0.6) * uBr.x * 0.55 * m * scan * uWake;     // swells with the breath
          holo += vec3(1.0, 0.74, 0.30) * uBr.y * (0.55 * fres + 0.12 * ridge) * m * scan * uWake;                    // harmony: gold rim
          holo += vec3(0.6, 0.95, 1.0) * uBr.z * (0.25 + 0.9 * ridge + 0.5 * fres) * m * uWake;                        // clench flash
        }
      }
      vec3 beneath = (water + holo * 0.5) * exp(-Lc * 2.2);           // ink absorbs what is below it
      // ---- ink: hue-preserving saturation (dominant channel kept, minor channels pushed down) ----
      vec3 hue = pow(c / max(Lc, 1e-4), vec3(1.6));
      vec3 Ld = normalize(vec3(-0.45, 0.6, 0.75));
      float diff = 0.62 + 0.5 * max(dot(n, Ld), 0.0);
      float spec = pow(max(dot(n, normalize(Ld + vec3(0.0, 0.0, 1.0))), 0.0), 60.0) * smoothstep(0.05, 0.5, thick);
      vec3 bl = texture(uBloom, uv).rgb;
      vec3 ink = hue * thick * diff * (0.80 + 0.20 * vig)
               + hue * thick * thick * 0.22                            // subsurface: dense cores glow from within
               + bl * 0.85                                             // soft bloom on bright ink
               + vec3(0.80, 0.92, 1.0) * spec * 0.55;                  // wet sheen
      vec3 col = beneath + ink;
      // faint head map (live only): ellipse ring + nose tick
      if (uOutline > 0.0) {
        vec2 hq = (px - uHead.xy) / uHead.zw;
        float he = abs(length(hq) - 1.0) * min(uHead.z, uHead.w);
        float ring = smoothstep(1.4, 0.0, he);
        vec2 nq = px - (uHead.xy + vec2(0.0, uHead.w * 1.0));
        float nose = smoothstep(1.4, 0.0, abs(abs(nq.x) * 1.6 - (uHead.w * 0.09 - nq.y))) * step(0.0, nq.y) * step(nq.y, uHead.w * 0.09);
        col += vec3(0.25, 0.85, 0.95) * (ring + nose) * 0.06 * uOutline;
      }
      col *= mix(0.55, 1.0, vig);
      col *= 0.95 + 0.05 * step(0.5, fract(px.y * 0.5));
      o = vec4(col, 1.0);
    }`,
  // suspended motes: advected by the fluid velocity only (layer-scaled), never by themselves
  moteAdv: `uniform sampler2D uPos, uVel; uniform vec2 uSimTexel; uniform float uDt;
    void main(){
      vec4 p = texture(uPos, vUv);
      vec2 v = texture(uVel, p.xy).xy;
      p.xy = fract(p.xy + v * uSimTexel * uDt * mix(1.0, 0.45, p.z));   // deeper layers lag the surface flow
      o = p;
    }`,
};

// mote sprites: one point per texel of the mote position texture (3 depth layers, window parallax)
const MOTE_VS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uPos, uDye;
uniform int uW;
uniform vec2 uCss;     // CSS px viewport
uniform vec3 uCam;     // camera offset x/y (CSS px, y up) + distance to the pool plane
uniform float uDepth;  // CSS px depth of the deepest layer
uniform float uPr, uWake;
uniform float uGold, uTime;   // harmony ~1: slow gold shimmer (brightness only, never moves a mote)
out vec3 vCol; out float vA;
void main(){
  vec4 p = texelFetch(uPos, ivec2(gl_VertexID % uW, gl_VertexID / uW), 0);
  float z = 0.12 + p.z * uDepth;                       // depth below the surface
  float s = uCam.z / (uCam.z + z);                     // perspective scale of that layer
  vec2 wp = (p.xy - 0.5) * uCss;
  vec2 sp = uCam.xy * (1.0 - s) + wp * s;
  gl_Position = vec4(sp / (uCss * 0.5), 0.0, 1.0);
  vec3 d = texture(uDye, p.xy).rgb;
  float L = max(max(d.r, d.g), d.b);
  vec3 hue = pow(d / max(L, 1e-4), vec3(1.6)) * (1.0 - exp(-L * 2.0));
  float near = 1.0 - p.z;
  vCol = vec3(0.30, 0.55, 0.65) * 0.25 + hue * 1.3;    // lit by the ink they float in
  vA = (0.10 + 0.32 * near * near) * (0.25 + 0.75 * fract(p.w * 7.31)) * uWake;
  gl_PointSize = (1.0 + 3.2 * near * near) * uPr;
  if (uGold > 0.0) {
    float tw = 0.5 + 0.5 * sin(uTime * (0.6 + 0.5 * fract(p.w * 3.7)) + p.w * 61.0);
    tw *= tw * step(0.55, fract(p.w * 13.7));
    vCol += vec3(1.0, 0.78, 0.36) * tw * 1.4 * uGold;
    vA += tw * 0.35 * uGold * uWake;
    gl_PointSize += tw * 1.5 * uGold * uPr;
  }
}`;
const MOTE_FS = `#version 300 es
precision highp float;
in vec3 vCol; in float vA;
out vec4 o;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(d)) * vA;
  o = vec4(vCol * a, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('ink shader: ' + gl.getShaderInfoLog(s));
  return s;
}
function program(gl, vs, fsSrc, head = HEAD) {
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, head + fsSrc));
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
    // mote positions want full float (half floats quantise slow drift away); half is an acceptable fallback
    this.fmtPos = this._format(gl.RGBA32F, gl.RGBA, gl.FLOAT) || this.fmtRGBA;

    const vs = compile(gl, gl.VERTEX_SHADER, VS);
    this.P = {};
    for (const k in FS) this.P[k] = program(gl, vs, FS[k]);
    this.P.motes = program(gl, compile(gl, gl.VERTEX_SHADER, MOTE_VS), '', MOTE_FS);
    this.emptyVao = gl.createVertexArray();   // attribute-less point draw (gl_VertexID)
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
    // depth + presence
    this.wake = 0;                           // cortex/mote/floor visibility: 0 before live, eases to 1 when live
    this.siteCol = new Float32Array(12);     // per-sensor cortex light (eased)
    this.cam = { ox: 0, oy: 0, D: 1, Dk: 1 };   // shared window camera: pool plane pinned 1:1, everything off-plane parallaxes
    this.breath = 0; this.breathS = 0;       // beat-only camera breathing envelope
    this.bw = new Float32Array(20); this.siteT = new Float32Array(4);   // per-site band weights + total dose
    this.moteN = MOTE_W * MOTE_H;
    // PLAY (gyro stylus + artifact instruments) and BREATHE (machine breath guide + harmony gold); all exactly 0 when off
    this.play = false; this.playK = 0; this.drop = 0; this.ripple = 0; this.flash = 0;
    this.sty = { x: 0, y: 0, vx: 0, vy: 0, on: false };   // smoothed stylus nozzle (CSS px) + velocity (CSS px/s)
    this.lungK = 0; this.lung = 0; this.bOff = 0; this.gold = 0; this.threadPh = 0; this.tt = 0;
    this.nz = Array.from({ length: 4 }, () => ({ x: 0, y: 0 }));   // nozzle uv (y up) after the breath retraction
    this.fx = { sOn: 0, sx: 0, sy: 0, bOff: 0, ring: 0, level: 0, gold: 0 };   // shared with the arms overlay (reused)
    this.motes = this._double(MOTE_W, MOTE_H, this.fmtPos, true);
    {
      const init = new Float32Array(MOTE_W * MOTE_H * 4);
      for (let i = 0; i < MOTE_W * MOTE_H; i++) {
        init[i * 4] = Math.random(); init[i * 4 + 1] = Math.random();
        init[i * 4 + 2] = [0.08, 0.5, 0.92][i % 3] + (Math.random() - 0.5) * 0.12;   // three depth layers
        init[i * 4 + 3] = Math.random();
      }
      for (const f of [this.motes.read, this.motes.write]) {
        gl.bindTexture(gl.TEXTURE_2D, f.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, this.fmtPos.internal, MOTE_W, MOTE_H, 0, gl.RGBA, gl.FLOAT, init);
      }
    }

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
  _format(internal, format, type = this.gl.HALF_FLOAT) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, type, null);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(f); gl.deleteTexture(t);
    return ok ? { internal, format, type } : null;
  }
  _fbo(w, h, fmt, nearest = false) {
    const gl = this.gl, tex = gl.createTexture(), filt = nearest ? gl.NEAREST : gl.LINEAR;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, fmt.format, fmt.type, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb, w, h, tx: 1 / w, ty: 1 / h };
  }
  _double(w, h, fmt, nearest = false) {
    const d = { read: this._fbo(w, h, fmt, nearest), write: this._fbo(w, h, fmt, nearest), swap() { const t = this.read; this.read = this.write; this.write = t; } };
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
    // bloom chain at quarter of the drawing buffer
    const bw = Math.max(1, Math.round(this.canvas.width / 4)), bh = Math.max(1, Math.round(this.canvas.height / 4));
    if (!this.bloomA || this.bloomA.w !== bw || this.bloomA.h !== bh) {
      this._free(this.bloomA); this._free(this.bloomB);
      this.bloomA = this._fbo(bw, bh, this.fmtRGBA); this.bloomB = this._fbo(bw, bh, this.fmtRGBA);
    }
    if (!this.cortex) {   // static procedural cortex, baked once in head-local space
      this.cortex = this._fbo(CORTEX_RES, CORTEX_RES, this.fmtRGBA);
      const Q = this.P.cortexBake; this._use(Q, this.cortex); this._draw(this.cortex);
    }
    this.aspect = w / h;
    this._layout(w, h);
    this.cam.D = (h / 2) / Math.tan((CAM_FOV / 2) * Math.PI / 180); this.cam.Dk = this.cam.D;
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
    this.breath = Math.max(this.breath, s);
    this.arms?.onBeat(s, this.active);
  }
  /** kind: 'blink' | 'clench'. PLAY: blink drops ink from both forehead nozzles, clench ripples from the cortex. */
  onBlink(kind) {
    if (!this.live) return;
    if (!this.play) { this.blink = 1; return; }
    if (kind === 'clench') { this.ripple = 1; this.flash = 1; } else this.drop = 1;
  }
  clear() {
    const gl = this.gl, P = this.P.clear;
    gl.useProgram(P.p);
    for (const f of [this.dye.read, this.dye.write, this.vel.read, this.vel.write, this.pres.read, this.pres.write]) this._draw(f);
    this.dose.fill(0); this.pulse = 0; this.blink = 0; this.drop = 0; this.ripple = 0;
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

    this.wake += ((live ? 1 : 0) - this.wake) * Math.min(1, d * (live ? 0.9 : 1.6));
    if (this.wake < 0.002) this.wake = 0;

    const W = this.bw, T = this.siteT, sc = this.siteCol, kc = Math.min(1, d * 2.5);
    for (let i = 0; i < 4; i++) {
      const q = st.quality?.[i], lab = q?.label;
      this.active[i] = live && (lab === 'good' || lab === 'noisy') && !st.held?.[i] ? 1 : 0;
      if (!this.active[i]) this.dose[i] = 0;
      // per-site band weights, normalised + sharpened so the dominant band owns the hue (order and colour stay truthful);
      // total dose stays proportional to summed band level x contact quality
      let S = 0, sw = 0;
      const ch = st.ch?.[i];
      for (let b = 0; b < 5; b++) { const l = ch ? Math.max(0, (ch[BANDS[b]] || 0) - 0.04) : 0; W[i * 5 + b] = l; S += l; }
      for (let b = 0; b < 5; b++) { const w = W[i * 5 + b] ** 4; W[i * 5 + b] = w; sw += w; }
      for (let b = 0; b < 5; b++) W[i * 5 + b] = sw > 0 ? W[i * 5 + b] / sw : 0;
      const qs = this.active[i] ? Math.max(0, Math.min(1, q.score ?? 0)) : 0;
      T[i] = qs * Math.pow(S, 1.6);
      // cortex light under this sensor: dominant-band colour x level x quality (eased; dark when inactive)
      const lv = qs * Math.min(1, S * 1.4);
      for (let k = 0; k < 3; k++) {
        let c = 0; for (let b = 0; b < 5; b++) c += COL[b][k] * W[i * 5 + b];
        sc[i * 3 + k] += (c * lv - sc[i * 3 + k]) * kc;
      }
    }

    this.lockBpm = st.bpm || 0; this.beatPhase = st.beatPhase || 0; this.beatConf = st.beatConf || 0;
    this._modes(st, d, live);
    if (live) {
      // window camera: head tilt (accel) slides the eye point; the pool plane stays pinned so nozzles stay on their sites.
      // Frozen when not live (nothing moves before sync). Breathing = small dolly on real beats only.
      const R = this.head.ry, kt = Math.min(1, d * 1.2), tl = st.tilt || ZERO3;
      this.cam.ox += (Math.max(-1, Math.min(1, tl.x || 0)) * R * 1.2 - this.cam.ox) * kt;
      this.cam.oy += (Math.max(-1, Math.min(1, tl.y || 0)) * R * 1.2 - this.cam.oy) * kt;
      this.breath *= Math.exp(-d / 0.55);
      this.breathS += (this.breath - this.breathS) * Math.min(1, d / 0.12);
      this.cam.Dk = this.cam.D * (1 - 0.07 * this.breathS);
      this._step(st, d);
    } else this._fade(d);
    this._composite();
    if (this.snapReq) { this.snapReq = false; this._save(); }

    this.arms?.frame(st, d, this.dose, this.active, this.cam, this.fx);
    const decay = Math.exp(-d / 0.28);
    for (let i = 0; i < 5; i++) this.dose[i] *= decay;
    this._adapt(dt);
  }

  /** PLAY stylus + BREATHE lung/harmony envelopes (eased; exactly 0 when the modes are off) */
  _modes(st, d, live) {
    const H = this.head, fx = this.fx;
    this.tt += d;
    // ---- PLAY: the stylus nozzle follows the integrated head orientation (x turn → left/right, y nod up → up the pool) ----
    this.play = !!st.play && live;
    this.playK += ((this.play ? 1 : 0) - this.playK) * Math.min(1, d / 0.35);
    if (this.playK < 0.002) this.playK = 0;
    const sty = this.sty;
    if (this.playK > 0) {
      const hd = st.head || ZERO2;
      const tx = H.x + Math.max(-1, Math.min(1, hd.x || 0)) * H.rx * 1.15;
      const ty = H.y - Math.max(-1, Math.min(1, hd.y || 0)) * H.ry * 1.15;
      if (!sty.on) { sty.x = tx; sty.y = ty; sty.vx = sty.vy = 0; sty.on = true; }
      const k = Math.min(1, d / 0.12), ox = sty.x, oy = sty.y;
      sty.x += (tx - sty.x) * k; sty.y += (ty - sty.y) * k;
      sty.vx = d > 0 ? (sty.x - ox) / d : 0; sty.vy = d > 0 ? (sty.y - oy) / d : 0;
    } else { sty.on = false; sty.vx = sty.vy = 0; }
    // ---- BREATHE: lung level retracts the injector nozzles along their inward line (tips on their sites at full lungs) ----
    const br = st.breath, bOn = !!(br && br.on) && live;
    this.lungK += ((bOn ? 1 : 0) - this.lungK) * Math.min(1, d / 0.8);
    if (this.lungK < 0.002) this.lungK = 0;
    const level = this.lungK > 0 ? Math.max(0, Math.min(1, (br && br.level) || 0)) : 0;
    this.lung = this.lungK * level;
    this.bOff = this.lungK > 0 ? this.lungK * (1 - level) * H.ry * LUNG : 0;
    const hTarget = bOn ? Math.max(0, Math.min(1, st.harmony || 0)) : 0;
    this.gold += (hTarget * this.lungK - this.gold) * Math.min(1, d / 0.6);
    if (this.gold < 0.002) this.gold = 0;
    this.flash *= Math.exp(-d / 0.3); if (this.flash < 0.003) this.flash = 0;
    for (let i = 0; i < 4; i++) {   // nozzle positions in uv (y up); bOff = 0 → exactly the sites
      this.nz[i].x = (this.sites[i].x - this.dirs[i].x * this.bOff) / this.cssW;
      this.nz[i].y = 1 - (this.sites[i].y + this.dirs[i].y * this.bOff) / this.cssH;
    }
    fx.sOn = this.playK; fx.sx = sty.x; fx.sy = sty.y; fx.bOff = this.bOff;
    fx.ring = this.lungK; fx.level = level; fx.gold = this.gold;
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
      const Wt = this.bw, Ti = this.siteT[i];
      const dx = this.dirs[i].x, dy = this.dirs[i].y, px = this.nz[i].x, py = this.nz[i].y;
      const dose = this.dose[i];
      for (let b = 0; b < 5; b++) {
        const lvl = Ti * Wt[i * 5 + b] * 0.4;             // this band's share of the site's dose (normalised weights)
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
        sP[o] = this.nz[i].x; sP[o + 1] = this.nz[i].y; sP[o + 2] = (Rn * 0.12) ** 2;
        sV[o] = Math.cos(a) * 30; sV[o + 1] = Math.sin(a) * 30;
      }
      this.blink = 0;
    }
    if (this.play || this.gold > 0.01) {
      this.nV = n; this.mD = m;
      if (this.play) this._play(st, dt);                       // stylus stir + artifact instruments (the user's real motion)
      if (this.gold > 0.01 && st.bpm > 0) this._thread(dt);    // gold thread: dye, gated by pulse lock like all ink
      n = this.nV; m = this.mD;
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

    // ---- motes ride the (already advected) velocity field; zero velocity → they stay put ----
    Q = P.moteAdv; this._use(Q, this.motes.read);
    gl.uniform2f(Q.u.uSimTexel, vel.read.tx, vel.read.ty); gl.uniform1f(Q.u.uDt, dt);
    this._tex(Q, 'uPos', this.motes.read, 0); this._tex(Q, 'uVel', vel.read, 1);
    this._draw(this.motes.write); this.motes.swap();
  }

  _vel(x, y, r2, vx, vy) {
    if (this.nV >= MAXS) return; const o = this.nV++ * 4, a = this.sP, b = this.sV;
    a[o] = x; a[o + 1] = y; a[o + 2] = r2; b[o] = vx; b[o + 1] = vy;
  }
  _dye(x, y, r2, r, g, b) {
    if (this.mD >= MAXS) return; const o = this.mD++ * 4, a = this.dP, c = this.dC;
    a[o] = x; a[o + 1] = y; a[o + 2] = r2; c[o] = r; c[o + 1] = g; c[o + 2] = b;
  }

  /** PLAY: head-steered stylus stirs (velocity along its motion ∝ speed + faint dominant-band trail);
   *  blink → ink droplets from both forehead nozzles; clench → velocity ripple ring from the cortex centre */
  _play(st, dt) {
    const Rn = this.Rn, asp = this.aspect, sty = this.sty, R = this.head.ry;
    const sp = Math.hypot(sty.vx, sty.vy);
    if (sty.on && sp > R * 0.04) {   // deadband: a still head leaves the water still
      const x = sty.x / this.cssW, y = 1 - sty.y / this.cssH, k = this.playK * this.playK;
      const toTex = this.vel.read.h / this.cssH, g = Math.min(1, dt * 9) * k;
      const cap = Math.min(1, (R * 3) / sp);   // capped at 3 head radii / s
      this._vel(x, y, (Rn * 0.05) ** 2, sty.vx * toTex * g * cap, -sty.vy * toTex * g * cap);
      // trail tinted by the current dominant band
      const bs = st.bands; let bi = 2, bv = -1;
      if (bs) for (let b = 0; b < 5; b++) { const l = bs[BANDS[b]] || 0; if (l > bv) { bv = l; bi = b; } }
      const amt = Math.min(1, sp / (R * 2)) * dt * 1.6 * k;
      this._dye(x, y, (Rn * 0.018) ** 2, COL[bi][0] * amt, COL[bi][1] * amt, COL[bi][2] * amt);
    }
    if (this.drop > 0) {   // ink droplet: bright splash ring from each forehead nozzle + small outward kick
      const W = this.bw;
      for (let s = 1; s <= 2; s++) {
        let cr = 0, cg = 0, cb = 0;
        for (let b = 0; b < 5; b++) { const w = W[s * 5 + b]; cr += COL[b][0] * w; cg += COL[b][1] * w; cb += COL[b][2] * w; }
        if (cr + cg + cb < 0.05) { cr = COL[2][0]; cg = COL[2][1]; cb = COL[2][2]; }   // no band reading: alpha cyan
        cr = cr * 0.65 + 0.35; cg = cg * 0.65 + 0.35; cb = cb * 0.65 + 0.35;              // bright splash
        const cx = this.nz[s].x, cy = this.nz[s].y, r0 = Rn * 0.04;
        this._dye(cx, cy, (Rn * 0.016) ** 2, cr * 0.5, cg * 0.5, cb * 0.5);
        for (let k = 0; k < 6; k++) {
          const a = k * (Math.PI / 3) + s, ux = Math.cos(a), uy = Math.sin(a);
          this._dye(cx + (ux * r0) / asp, cy + uy * r0, (Rn * 0.012) ** 2, cr * 0.42, cg * 0.42, cb * 0.42);
        }
        for (let k = 0; k < 4; k++) {
          const a = k * (Math.PI / 2) + 0.4 + s, ux = Math.cos(a), uy = Math.sin(a);
          this._vel(cx + (ux * r0 * 0.7) / asp, cy + uy * r0 * 0.7, (Rn * 0.035) ** 2, ux * 22, uy * 22);
        }
      }
      this.drop = 0;
    }
    if (this.ripple > 0) {   // clench: ripple ring of velocity from the cortex centre
      const cx = this.head.x / this.cssW, cy = 1 - this.head.y / this.cssH, r0 = Rn * 0.3;
      for (let k = 0; k < 8; k++) {
        const a = k * (Math.PI / 4) + 0.39, ux = Math.cos(a), uy = Math.sin(a);
        this._vel(cx + (ux * r0) / asp, cy + uy * r0, (Rn * 0.16) ** 2, ux * 55, uy * 55);
      }
      this.ripple = 0;
    }
  }

  /** HARMONY: a thin gold thread weaves through the four sensor sites (TP9 → AF7 → AF8 → TP10 and back), ∝ harmony */
  _thread(dt) {
    this.threadPh += dt * (Math.PI * 2 / 16);
    const H = this.head, ph = this.threadPh, a = 1.75 * Math.sin(ph), rad = 1.0 + 0.07 * Math.sin(ph * 7.0);
    const x = (H.x + Math.sin(a) * H.rx * rad) / this.cssW, y = 1 - (H.y - Math.cos(a) * H.ry * rad) / this.cssH;
    const amt = this.gold * dt * 7.0;
    this._dye(x, y, (this.Rn * 0.014) ** 2, GOLD[0] * amt, GOLD[1] * amt, GOLD[2] * amt);
  }

  /** not live: no stepping, no injection; ink holds still and fades to a black pool (half-life ~30s) */
  _fade(dt) {
    const Q = this.P.copy; this._use(Q, this.dye.read);
    this._tex(Q, 'uSrc', this.dye.read, 0); this.gl.uniform1f(Q.u.uK, Math.exp(-dt * 0.023));
    this._draw(this.dye.write); this.dye.swap();
  }

  _composite(noOutline = false) {
    const gl = this.gl, P = this.P, W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, s = W / this.cssW;
    // ---- bloom: bright ink → quarter res → separable blur ----
    let Q = P.bright; this._use(Q, this.bloomA);
    this._tex(Q, 'uDye', this.dye.read, 0); gl.uniform2f(Q.u.uDyeTexel, this.dye.read.tx, this.dye.read.ty);
    this._draw(this.bloomA);
    Q = P.blur; this._use(Q, this.bloomA);
    this._tex(Q, 'uSrc', this.bloomA, 0); gl.uniform2f(Q.u.uDir, this.bloomA.tx * 1.5, 0); this._draw(this.bloomB);
    this._tex(Q, 'uSrc', this.bloomB, 0); gl.uniform2f(Q.u.uDir, 0, this.bloomA.ty * 1.5); this._draw(this.bloomA);

    // ---- camera projection of the layers beneath the surface (window parallax, same rig as the arms) ----
    const C = this.cam, R = this.head.ry, cw2 = this.cssW / 2, ch2 = this.cssH / 2;
    const sC = C.Dk / (C.Dk + R * 0.75);           // cortex sits ~0.75 head radii below the surface
    const sF = C.Dk / (C.Dk + R * 2.6);            // machine floor, deepest
    const hxw = this.head.x - cw2, hyw = ch2 - this.head.y;   // head centre in centred world px (y up)

    Q = P.show; this._use(Q, this.dye.read);
    this._tex(Q, 'uDye', this.dye.read, 0); this._tex(Q, 'uBloom', this.bloomA, 1); this._tex(Q, 'uCortex', this.cortex, 2);
    gl.uniform2f(Q.u.uDyeTexel, this.dye.read.tx, this.dye.read.ty);
    gl.uniform2f(Q.u.uRes, W, H);
    gl.uniform4f(Q.u.uHead, this.head.x * s, H - this.head.y * s, this.head.rx * s, this.head.ry * s);
    gl.uniform1f(Q.u.uOutline, noOutline ? 0 : this.outline);
    gl.uniform1f(Q.u.uCA, 0.012);
    const swell = this.lung > 0 ? 1 + 0.06 * this.lung : 1;   // cortex swells with the breath (exactly 1 when off)
    gl.uniform3f(Q.u.uCtx, (cw2 + C.ox * (1 - sC) + hxw * sC) * s, (ch2 + C.oy * (1 - sC) + hyw * sC) * s, R * sC * s * swell);
    gl.uniform1f(Q.u.uCAsp, this.head.rx / this.head.ry);
    gl.uniform3f(Q.u.uBr, this.lung, this.gold, this.flash);
    gl.uniform3f(Q.u.uFloor, (cw2 + C.ox * (1 - sF) + hxw * sF) * s, (ch2 + C.oy * (1 - sF) + hyw * sF) * s, R * 1.6 * sF * s);
    gl.uniform3fv(Q.u.uSC, this.siteCol);
    const lock = this.live && this.lockBpm > 0;
    gl.uniform2f(Q.u.uScan, lock ? this.beatPhase : 0, lock ? this.beatConf * 0.8 : 0);
    gl.uniform1f(Q.u.uWake, this.wake);
    gl.uniform1f(Q.u.uPr, s);
    this._draw(null);

    // ---- suspended motes (additive points) ----
    if (this.wake > 0 && this.moteN > 0) {
      Q = P.motes; gl.useProgram(Q.p);
      this._tex(Q, 'uPos', this.motes.read, 0); this._tex(Q, 'uDye', this.dye.read, 1);
      gl.uniform1i(Q.u.uW, MOTE_W);
      gl.uniform2f(Q.u.uCss, this.cssW, this.cssH);
      gl.uniform3f(Q.u.uCam, C.ox, C.oy, C.Dk);
      gl.uniform1f(Q.u.uDepth, R * 1.6);
      gl.uniform1f(Q.u.uPr, s); gl.uniform1f(Q.u.uWake, this.wake);
      const sh = this.gold > 0.8 ? (this.gold - 0.8) / 0.2 : 0;   // shimmer only near full harmony
      gl.uniform1f(Q.u.uGold, sh * sh * (3 - 2 * sh)); gl.uniform1f(Q.u.uTime, this.tt);
      gl.bindVertexArray(this.emptyVao);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, this.moteN);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(this.vao);
    }
  }

  _save() {
    this._composite(true);   // snapshot = fluid + cortex + motes (no head outline; arms live on their own canvas)
    const a = document.createElement('a');
    a.download = `hbi-ink-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.href = this.canvas.toDataURL('image/png'); a.click();
    this._composite();
  }

  /** frames running slow (>22ms avg for ~2s): drop pressure iterations, then pixel ratio, then dye res */
  _adapt(dt) {
    this.ftAvg += (dt * 1000 - this.ftAvg) * 0.05;
    this.slow = this.ftAvg > 22 ? this.slow + dt : 0;
    if (this.slow < 2) return;
    this.slow = 0; this.ftAvg = 16;
    if (this.iters > 12) this.iters = 12;
    else if (this.moteN > MOTE_W * MOTE_H / 2) this.moteN = (MOTE_W * MOTE_H) / 2;
    else if (this.pr > 0.75) { this.pr = Math.max(0.75, this.pr - 0.25); this.resize(); }
    else if ((this.dyeRes || DYE_RES) > 256) { this.dyeRes = 256; this.resize(); }
  }
}
