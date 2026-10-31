import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalPipeline } from '../../src/dsp/pipeline.js';

const FS = 256;
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

/** feed `sec` seconds of signal f(ch, t) in 10Hz ticks; returns the last tick result */
function run(p, sec, f, t0 = { t: 0, ms: 0 }, onTick) {
  let r;
  for (let k = 0; k < sec * 10; k++) {
    for (let ch = 0; ch < 4; ch++) {
      const s = new Float32Array(FS / 10);
      for (let i = 0; i < s.length; i++) s[i] = f(ch, t0.t + i / FS);
      p.push(ch, s);
    }
    t0.t += 0.1; t0.ms += 100;
    r = p.tick(t0.ms);
    onTick?.(r);
  }
  return r;
}
const sine = (hz, amp = 20) => (ch, t) => amp * Math.sin(2 * Math.PI * hz * t) + 2 * rnd();
const dominant = b => Object.entries(b).sort((x, y) => y[1] - x[1])[0][0];
const rawDominant = p => dominant(p.relAvg);

test('sines land in the right band', () => {
  for (const [hz, band] of [[10, 'alpha'], [6, 'theta'], [20, 'beta'], [2.5, 'delta']]) {
    const p = new SignalPipeline();
    run(p, 3, sine(hz));
    assert.equal(rawDominant(p), band, `${hz}Hz`);
  }
});

test('flat signal is no contact; clean sine is good', () => {
  const p = new SignalPipeline();
  let r = run(p, 2, () => 0);
  assert.ok(r.quality.every(q => q.label === 'no contact'));
  assert.equal(r.artifact.rejected, true);
  r = run(new SignalPipeline(), 2, sine(10));
  assert.ok(r.quality.every(q => q.label === 'good'), JSON.stringify(r.quality));
});

test('strong 60Hz line noise lowers the score', () => {
  const r = run(new SignalPipeline(), 2, (ch, t) => 10 * Math.sin(2 * Math.PI * 10 * t) + 40 * Math.sin(2 * Math.PI * 60 * t));
  assert.ok(r.quality.every(q => q.score < 0.5 && q.label === 'noisy'), JSON.stringify(r.quality));
});

test('railed channel is flagged', () => {
  const r = run(new SignalPipeline(), 2, (ch, t) => (ch === 0 ? (Math.sin(2 * Math.PI * 3 * t) > 0 ? 1000 : -1000) : sine(10)(ch, t)));
  assert.equal(r.quality[0].label, 'railed');
  assert.equal(r.quality[1].label, 'good');
});

test('frontal blink fires one event and holds output', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  run(p, 3, sine(10), clock);
  const blinkAt = clock.t + 0.05;
  const events = [], rejected = [];
  run(p, 1.5, (ch, t) => sine(10)(ch, t) + ((ch === 1 || ch === 2) && t >= blinkAt && t < blinkAt + 0.08 ? 200 * Math.sin(((t - blinkAt) / 0.08) * Math.PI) : 0), clock,
    r => { events.push(...r.events); rejected.push(r.artifact.rejected); });
  assert.equal(events.filter(e => e === 'blink').length, 1);
  assert.ok(rejected.includes(true));
});

test('broadband high-frequency burst on temporal channels fires clench', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  run(p, 4, sine(10), clock);
  const events = [];
  run(p, 0.5, (ch, t) => sine(10)(ch, t) + (ch === 0 || ch === 3 ? 15 * (Math.sin(2 * Math.PI * 33 * t) + Math.sin(2 * Math.PI * 37 * t) + Math.sin(2 * Math.PI * 41 * t)) : 0), clock,
    r => events.push(...r.events));
  assert.ok(events.includes('clench'), events.join());
});

test('motion from gyro rejects the tick', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  run(p, 2, sine(10), clock);
  p.pushMotion('gyro', { x: 80, y: 0, z: 0 });
  const r = run(p, 0.1, sine(10), clock);
  assert.equal(r.artifact.motion, true);
  assert.equal(r.artifact.rejected, true);
});

test('calibration counts only clean time, completes, round-trips', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  run(p, 2, sine(10), clock);
  p.startCalibration(3);
  let r = run(p, 3, () => 0, clock);                 // no contact: no progress (first window is skipped, then nothing usable)
  assert.equal(r.calibration.state, 'running');
  assert.ok(r.calibration.cleanSeconds < 0.05, String(r.calibration.cleanSeconds));
  r = run(p, 4, sine(10), clock);
  assert.equal(r.calibration.state, 'done');
  assert.equal(p.calibrated, true);
  // a baseline-like input sits near the middle of the range
  r = run(p, 3, sine(10), clock);
  for (const v of Object.values(r.bands)) assert.ok(v > 0.3 && v < 0.7, JSON.stringify(r.bands));
  const j = JSON.parse(JSON.stringify(p.exportCalibration()));
  assert.ok(!JSON.stringify(j).match(/id|mac|device/i));
  const q = new SignalPipeline();
  assert.equal(q.importCalibration(j), true);
  assert.deepEqual(q.exportCalibration(), p.exportCalibration());
});

test('importCalibration rejects garbage', () => {
  const p = new SignalPipeline();
  for (const g of [null, 42, {}, { version: 9 }, { version: 1, bands: ['x'] }, { version: 1, bands: ['delta', 'theta', 'alpha', 'beta', 'gamma'], avg: { mean: [1], std: [1] }, ch: [] }])
    assert.equal(p.importCalibration(g), false);
  assert.equal(p.calibrated, false);
});

test('tick reuses its result object; reset keeps calibration', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  const a = run(p, 0.1, sine(10), clock), b = run(p, 0.1, sine(10), clock);
  assert.equal(a, b);
  p.startCalibration(1); run(p, 3, sine(10), clock);
  assert.equal(p.calibrated, true);
  p.reset();
  assert.equal(p.calibrated, true);
});

test('ppg beats surface as events', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  const events = [];
  for (let k = 0; k < 50; k++) {
    const s = new Float32Array(6);
    for (let i = 0; i < 6; i++) { const t = (k * 6 + i) / 64; s[i] = 1000 + 300 * Math.max(0, Math.sin(2 * Math.PI * 1.2 * t)) ** 8; }
    p.pushPpg(s);
    events.push(...run(p, 0.1, sine(10), clock).events);
  }
  assert.ok(events.filter(e => e === 'beat').length >= 3, events.join());
});

test('a railed or floating temporal electrode cannot lock the pipeline in clench', () => {
  for (const [name, bad] of [['railed', t => (Math.sin(2 * Math.PI * 3 * t) > 0 ? 1000 : -1000)], ['floating', () => 300 * rnd()]]) {
    const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
    run(p, 5, sine(10), clock);
    const events = [], rejected = [];
    run(p, 15, (ch, t) => (ch === 0 ? bad(t) : sine(10)(ch, t)), clock, r => { events.push(...r.events); rejected.push(r.artifact.rejected); });
    const tail = rejected.slice(-50);
    assert.ok(events.filter(e => e === 'clench').length <= 1, `${name}: ${events.filter(e => e === 'clench').length} clench events`);
    assert.ok(tail.filter(Boolean).length === 0, `${name}: still rejecting at the end`);
  }
});

test('a floating frontal electrode does not fire blinks', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  run(p, 3, sine(10), clock);
  const events = [];
  run(p, 15, (ch, t) => (ch === 1 ? 300 * rnd() : sine(10)(ch, t)), clock, r => events.push(...r.events));
  // the moment the electrode lifts can read as one blink; it must not keep firing
  assert.ok(events.filter(e => e === 'blink').length <= 1, events.join());
});

test('sustained high-frequency level becomes the new baseline', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  run(p, 4, sine(10), clock);
  const hi = (ch, t) => sine(10)(ch, t) + (ch === 0 || ch === 3 ? 15 * (Math.sin(2 * Math.PI * 33 * t) + Math.sin(2 * Math.PI * 41 * t)) : 0);
  const rejected = [];
  run(p, 10, hi, clock, r => rejected.push(r.artifact.rejected));
  assert.ok(rejected.slice(-30).every(v => !v), 'should stop rejecting once the level is the new normal');
});

test('a channel with contact for under half the calibration borrows the average baseline', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  run(p, 2, sine(10), clock);
  p.startCalibration(3);
  const start = clock.t;
  let j = null;   // snapshot at completion, before the slow baseline drift moves it
  run(p, 5, (ch, t) => (ch === 3 && t < start + 3.6 ? 0 : sine(10)(ch, t)), clock, r => { if (!j && r.calibration.state === 'done') j = p.exportCalibration(); });
  assert.equal(p.calibrated, true);
  // std is untouched by drift: a borrowed baseline matches the average exactly, a channel's own does not
  assert.deepEqual(j.ch[3].std, j.avg.std);
  assert.notDeepEqual(j.ch[0].std, j.avg.std);
});
