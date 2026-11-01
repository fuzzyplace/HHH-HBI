import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VisionFeatures } from '../../src/dsp/vision.js';

const W = 64, H = 48;
function frame(fill, square) {   // grey frame, optional bright square {x, y, s}
  const f = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const p = i * 4, x = i % W, y = (i / W) | 0;
    const v = square && x >= square.x && x < square.x + square.s && y >= square.y && y < square.y + square.s ? 240 : fill;
    f[p] = f[p + 1] = f[p + 2] = v; f[p + 3] = 255; }
  return f;
}
const noisy = (f, amt) => { const g = f.slice(); for (let i = 0; i < g.length; i += 4) { const n = (Math.random() - 0.5) * amt; g[i] += n; g[i + 1] += n; g[i + 2] += n; } return g; };

test('still frames with sensor noise read as no motion', () => {
  const v = new VisionFeatures(), base = frame(90);
  for (let k = 0; k < 60; k++) v.update(noisy(base, 8), W, H, 1 / 15);
  assert.ok(v.out.motion < 0.05, `motion ${v.out.motion}`);
  assert.ok(Math.abs(v.out.light - 90 / 255) < 0.05);
});

test('movement on the right of the camera image reads on the LEFT (mirrored), and travels', () => {
  const v = new VisionFeatures();
  v.update(frame(40), W, H, 1 / 15);
  for (let k = 0; k < 20; k++) v.update(frame(40, { x: 44 + (k % 2) * 4, y: 10, s: 10 }), W, H, 1 / 15);   // wiggling square, image right/top
  assert.ok(v.out.motion > 0.2, `motion ${v.out.motion}`);
  assert.ok(v.out.x < -0.3, `x ${v.out.x}`);
  assert.ok(v.out.y > 0.2, `y ${v.out.y}`);
  // sweep the square from image-right to image-left → selfie x moves right → vx > 0
  for (let k = 0; k < 12; k++) v.update(frame(40, { x: 50 - k * 4, y: 20, s: 10 }), W, H, 1 / 15);
  assert.ok(v.out.vx > 0, `vx ${v.out.vx}`);
});

test('motion fades back to zero once things stop moving', () => {
  const v = new VisionFeatures();
  v.update(frame(40), W, H, 1 / 15);
  for (let k = 0; k < 10; k++) v.update(frame(40, { x: (k % 2) * 20, y: 10, s: 16 }), W, H, 1 / 15);
  const still = frame(40, { x: 0, y: 10, s: 16 });
  for (let k = 0; k < 45; k++) v.update(still, W, H, 1 / 15);
  assert.ok(v.out.motion < 0.02, `motion ${v.out.motion}`);
});
