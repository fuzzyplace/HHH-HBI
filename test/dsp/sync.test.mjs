import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BreathSync } from '../../src/dsp/sync.js';
import { HeartTracker } from '../../src/dsp/ppg.js';

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const F = 5.5 / 60;   // breath guide, breaths per second

/** beats whose rate swings with the breath (amp bpm, lag phase) plus jitter; feeds BreathSync */
function run(amp, jitter, sec = 90, guideF = F) {
  const s = new BreathSync();
  let t = 0;
  while (t < sec) {
    const hr = 66 + amp * Math.sin(2 * Math.PI * guideF * t - 0.8) + jitter * rnd();
    const ibi = 60 / hr; t += ibi;
    s.push(ibi, t, (t * F) % 1);
  }
  return s.update(t);
}

test('heart rate swinging with the breath guide scores high', () => {
  assert.ok(run(5, 0.5) > 0.7, String(run(5, 0.5)));
});
test('random heart-rate variation scores low', () => {
  assert.ok(run(0, 4) < 0.2, String(run(0, 4)));
});
test('a swing at a different rhythm than the guide scores low', () => {
  assert.ok(run(5, 0.5, 90, 13 / 60) < 0.25, String(run(5, 0.5, 90, 13 / 60)));
});
test('needs ~30s of beats before scoring', () => {
  assert.equal(run(5, 0.5, 15), 0);
});

test('heart tracker reports real beat intervals near the true period', () => {
  const h = new HeartTracker(), ibis = [];
  let t = 0;
  for (let k = 0; k < 400; k++) {
    for (let ch = 0; ch < 3; ch++) {
      const buf = new Float32Array(6);
      for (let i = 0; i < 6; i++) { const tt = t + i / 64, ph = (tt * 70 / 60) % 1; buf[i] = ch === 1 ? 150000 - 400 * Math.exp(-(((ph - 0.2) / 0.08) ** 2)) + 30 * rnd() : 20000; }
      h.push(ch, buf);
    }
    t += 6 / 64; h.step(6 / 64);
    if (k > 150) ibis.push(...h.ibiOut);
  }
  assert.ok(ibis.length > 20, `${ibis.length} intervals`);
  const mean = ibis.reduce((a, b) => a + b, 0) / ibis.length;
  assert.ok(Math.abs(mean - 60 / 70) < 0.03, `mean ibi ${mean}`);
});
