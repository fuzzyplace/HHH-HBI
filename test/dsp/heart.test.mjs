import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeartTracker } from '../../src/dsp/ppg.js';

let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

/** muse-like raw PPG: big unsigned level, small pulse that dips per beat (+ optional dicrotic bump), drift, noise */
function ppgAt(t, bpm, { amp = 400, dicrotic = 0.3, dc = 150000, noise = 40 } = {}) {
  const ph = (t * bpm / 60) % 1;
  const pulse = Math.exp(-(((ph - 0.2) / 0.08) ** 2)) + dicrotic * Math.exp(-(((ph - 0.5) / 0.1) ** 2));
  return dc + 1500 * Math.sin(t * 0.3) - amp * pulse + noise * rnd();
}

/** feed seconds of 3-channel PPG in 100ms steps; returns { pulses, last tracker state } */
function run(h, sec, gen, clock = { t: 0 }) {
  let pulses = 0;
  for (let k = 0; k < Math.round(sec * 10); k++) {
    const n = k % 5 === 4 ? 7 : 6;   // 6.4 samples per 100ms on average
    for (let ch = 0; ch < 3; ch++) {
      const buf = new Float32Array(n);
      for (let i = 0; i < n; i++) buf[i] = gen(ch, clock.t + i / 64);
      h.push(ch, buf);
    }
    clock.t += (k % 5 === 4 ? 7 : 6) / 64;
    pulses += h.step(0.1);
  }
  return pulses;
}

test('locks onto the pulse channel (not ambient) and counts beats at the true rate', () => {
  const h = new HeartTracker();
  const gen = (ch, t) => (ch === 0 ? 20000 + 60 * rnd() : ch === 1 ? ppgAt(t, 66) : ppgAt(t, 66, { amp: 150, dc: 90000, noise: 50 }));
  run(h, 15, gen);
  const pulses = run(h, 30, gen);
  assert.ok(Math.abs(h.bpm - 66) < 3, `bpm ${h.bpm}`);
  assert.ok(h.conf > 0.7, `conf ${h.conf}`);
  assert.ok(!h.bestName.startsWith('ambient'), h.bestName);
  assert.ok(Math.abs(pulses - 33) <= 3, `pulses ${pulses} (expected ≈33 in 30s at 66bpm; channel hand-overs can drop one)`);
});

test('a strong second bump does not double the rate', () => {
  const h = new HeartTracker();
  const gen = (ch, t) => (ch === 1 ? ppgAt(t, 58, { dicrotic: 0.8 }) : 20000 + 60 * rnd());
  run(h, 40, gen);
  assert.ok(Math.abs(h.bpm - 58) < 3, `bpm ${h.bpm}`);
});

test('noise only: no heartbeat, no pulses', () => {
  const h = new HeartTracker();
  const pulses = run(h, 30, (ch) => 100000 + 300 * rnd() + ch);
  assert.ok(h.conf < 0.25, `conf ${h.conf}`);
  assert.ok(pulses <= 2, `pulses ${pulses}`);
});

test('brief dropout: the clock keeps time, then stops when the lock is gone', () => {
  const h = new HeartTracker(), clock = { t: 0 };
  const good = (ch, t) => (ch === 1 ? ppgAt(t, 72) : 20000 + 60 * rnd());
  run(h, 20, good, clock);
  const during = run(h, 3, () => 150000, clock);              // sensor lifted: flat
  assert.ok(during >= 2, `flywheel pulses ${during}`);
  run(h, 20, () => 150000, clock);
  const later = run(h, 10, () => 150000, clock);
  assert.equal(later, 0, 'no pulses long after the signal is gone');
  assert.ok(h.conf < 0.25);
});

test('rate change is followed', () => {
  const h = new HeartTracker(), clock = { t: 0 };
  run(h, 20, (ch, t) => (ch === 1 ? ppgAt(t, 60) : 20000), clock);
  run(h, 25, (ch, t) => (ch === 1 ? ppgAt(t, 90) : 20000), clock);
  assert.ok(Math.abs(h.bpm - 90) < 4, `bpm ${h.bpm}`);
});
