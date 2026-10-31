import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalPipeline } from '../../src/dsp/pipeline.js';

const FS = 256;
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

/** feed `sec` seconds of signal f(ch, t) in 10Hz ticks; returns the last tick result */
function run(p, sec, f, t0 = { t: 0, ms: 0 }, onTick) {
  let r;
  for (let k = 0; k < Math.round(sec * 10); k++) {
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
const S = (hz, t) => Math.sin(2 * Math.PI * hz * t);
const sine = (hz, amp = 20) => (ch, t) => amp * S(hz, t) + 2 * rnd();
// stand-ins for the two calibration states: eyes open (beta/theta-heavy) vs eyes closed (strong alpha)
const eyesOpen = (ch, t) => 6 * S(10, t) + 12 * S(20, t + ch) + 8 * S(6, t) + 3 * rnd();
const eyesClosed = (ch, t) => 25 * S(10, t) + 4 * S(20, t + ch) + 6 * S(6, t) + 3 * rnd();
const argmax = o => Object.entries(o).sort((x, y) => y[1] - x[1])[0][0];

test('sines land in the right band', () => {
  for (const [hz, band] of [[10, 'alpha'], [6, 'theta'], [20, 'beta'], [2.5, 'delta']]) {
    const r = run(new SignalPipeline(), 3, sine(hz));
    assert.equal(argmax(r.dB), band, `${hz}Hz`);
  }
});

test('spectrum peaks at the sine frequency', () => {
  const r = run(new SignalPipeline(), 3, sine(10));
  const peak = r.psd.indexOf(Math.max(...r.psd.slice(1)));
  assert.equal(peak, 10);
});

test('flat signal is no contact; clean sine is good', () => {
  let r = run(new SignalPipeline(), 2, () => 0);
  assert.ok(r.quality.every(q => q.label === 'no contact'));
  assert.equal(r.artifact.rejected, true);
  r = run(new SignalPipeline(), 2, sine(10));
  assert.ok(r.quality.every(q => q.label === 'good'), JSON.stringify(r.quality));
});

test('strong 60Hz line noise lowers the score', () => {
  const r = run(new SignalPipeline(), 2, (ch, t) => 10 * S(10, t) + 40 * S(60, t));
  assert.ok(r.quality.every(q => q.score < 0.5 && q.label === 'noisy'), JSON.stringify(r.quality));
});

test('railed channel is flagged', () => {
  const r = run(new SignalPipeline(), 2, (ch, t) => (ch === 0 ? (S(3, t) > 0 ? 1000 : -1000) : sine(10)(ch, t)));
  assert.equal(r.quality[0].label, 'railed');
  assert.equal(r.quality[1].label, 'good');
});

test('blink fires one event and pauses only the frontal pair', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  run(p, 3, sine(10), clock);
  const blinkAt = clock.t + 0.05;
  const events = [], held = [];
  run(p, 1.5, (ch, t) => sine(10)(ch, t) + ((ch === 1 || ch === 2) && t >= blinkAt && t < blinkAt + 0.08 ? 200 * Math.sin(((t - blinkAt) / 0.08) * Math.PI) : 0), clock,
    r => { events.push(...r.events); held.push([...r.held, r.artifact.rejected]); });
  assert.equal(events.filter(e => e === 'blink').length, 1);
  assert.ok(held.some(h => h[1] && h[2] && !h[0] && !h[3]), 'AF7/AF8 held, TP9/TP10 live');
  assert.ok(held.every(h => !h[4]), 'a blink never freezes everything');
});

test('broadband high-frequency burst on temporal channels fires clench', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  run(p, 4, sine(10), clock);
  const events = [];
  run(p, 0.5, (ch, t) => sine(10)(ch, t) + (ch === 0 || ch === 3 ? 15 * (S(33, t) + S(37, t) + S(41, t)) : 0), clock, r => events.push(...r.events));
  assert.ok(events.includes('clench'), events.join());
});

test('motion from gyro pauses every channel', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  run(p, 2, sine(10), clock);
  p.pushMotion('gyro', { x: 80, y: 0, z: 0 });
  const r = run(p, 0.1, sine(10), clock);
  assert.equal(r.artifact.motion, true);
  assert.equal(r.artifact.rejected, true);
});

test('a steady signal gives a steady relax reading (noise is not stretched)', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  run(p, 5, eyesOpen, clock);
  const relax = [], focus = [];
  run(p, 10, eyesOpen, clock, r => { relax.push(r.relax); focus.push(r.focus); });
  const spread = a => Math.max(...a) - Math.min(...a);
  assert.ok(spread(relax) < 0.12, `relax spread ${spread(relax)}`);
  assert.ok(spread(focus) < 0.12, `focus spread ${spread(focus)}`);
});

test('eyes closed raises relax and lowers focus within a few seconds (uncalibrated)', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  const before = run(p, 15, eyesOpen, clock);
  const r0 = before.relax, f0 = before.focus;
  const after = run(p, 5, eyesClosed, clock);
  assert.ok(after.relax - r0 > 0.25, `relax ${r0.toFixed(2)} → ${after.relax.toFixed(2)}`);
  assert.ok(f0 - after.focus > 0.15, `focus ${f0.toFixed(2)} → ${after.focus.toFixed(2)}`);
});

test('two-step calibration: anchors relax/focus and reports eyes-closed alpha gain', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  run(p, 2, eyesOpen, clock);
  p.startCalibration(6);   // 3s open + 3s closed (+2s settle each)
  const phases = new Set();
  let r = run(p, 6, eyesOpen, clock, x => phases.add(x.calibration.phase));
  assert.equal(r.calibration.phase, 'closed');
  r = run(p, 6, eyesClosed, clock, x => phases.add(x.calibration.phase));
  assert.equal(r.calibration.state, 'done');
  assert.ok(phases.has('open') && phases.has('closed'));
  assert.equal(r.calibration.result.verdict, 'strong');
  assert.ok(r.calibration.result.alphaGainDb > 3, String(r.calibration.result.alphaGainDb));
  r = run(p, 8, eyesClosed, clock);
  assert.ok(r.relax > 0.7, `closed relax ${r.relax}`);
  assert.ok(r.focus < 0.25, `closed focus ${r.focus}`);
  r = run(p, 8, eyesOpen, clock);
  assert.ok(r.relax < 0.35, `open relax ${r.relax}`);
  assert.ok(r.focus > 0.35 && r.focus < 0.65, `open focus ${r.focus}`);

  const j = JSON.parse(JSON.stringify(p.exportCalibration()));
  assert.ok(!JSON.stringify(j).match(/id|mac|device/i));
  const q = new SignalPipeline();
  assert.equal(q.importCalibration(j), true);
  assert.deepEqual(q.exportCalibration(), p.exportCalibration());
});

test('calibration pauses while there is no contact', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  run(p, 2, eyesOpen, clock);
  p.startCalibration(6);
  const r = run(p, 4, () => 0, clock);
  assert.equal(r.calibration.state, 'running');
  assert.equal(r.calibration.phase, 'open');
  assert.ok(r.calibration.cleanSeconds < 0.05, String(r.calibration.cleanSeconds));
});

test('importCalibration rejects garbage and old versions', () => {
  const p = new SignalPipeline();
  const v1 = { version: 1, bands: ['delta', 'theta', 'alpha', 'beta', 'gamma'], avg: { mean: [0, 0, 0, 0, 0], std: [1, 1, 1, 1, 1] }, ch: [] };
  for (const g of [null, 42, {}, { version: 9 }, v1, { version: 2, relax: { open: 1 }, focus: { open: 1, closed: 2 }, alphaGainDb: 1 }])
    assert.equal(p.importCalibration(g), false);
  assert.equal(p.calibrated, false);
});

test('tick reuses its result object; reset keeps calibration', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  const a = run(p, 0.1, sine(10), clock), b = run(p, 0.1, sine(10), clock);
  assert.equal(a, b);
  p.startCalibration(2); run(p, 4, eyesOpen, clock); run(p, 4, eyesClosed, clock);
  assert.equal(p.calibrated, true);
  p.reset();
  assert.equal(p.calibrated, true);
});

test('ppg beats surface as events', () => {
  const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
  const events = [];
  for (let k = 0; k < 200; k++) {   // 20s: the heart lock needs a few seconds of pulse
    const s = new Float32Array(6);
    for (let i = 0; i < 6; i++) { const t = (k * 6 + i) / 64; s[i] = 150000 - 400 * Math.max(0, Math.sin(2 * Math.PI * 1.2 * t)) ** 8; }
    p.pushPpg(1, s);
    events.push(...run(p, 0.1, sine(10), clock).events);
  }
  assert.ok(events.filter(e => e === 'beat').length >= 10, events.filter(e => e === 'beat').length + ' beats');
});

test('a railed or floating temporal electrode cannot lock the pipeline in clench', () => {
  for (const [name, bad] of [['railed', t => (S(3, t) > 0 ? 1000 : -1000)], ['floating', () => 300 * rnd()]]) {
    const p = new SignalPipeline(), clock = { t: 0, ms: 0 };
    run(p, 5, sine(10), clock);
    const events = [], rejected = [];
    run(p, 15, (ch, t) => (ch === 0 ? bad(t) : sine(10)(ch, t)), clock, r => { events.push(...r.events); rejected.push(r.artifact.rejected); });
    assert.ok(events.filter(e => e === 'clench').length <= 1, `${name}: ${events.filter(e => e === 'clench').length} clench events`);
    assert.ok(rejected.slice(-50).every(v => !v), `${name}: still rejecting at the end`);
  }
});

test('a floating frontal electrode does not keep firing blinks', () => {
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
  const hi = (ch, t) => sine(10)(ch, t) + (ch === 0 || ch === 3 ? 15 * (S(33, t) + S(41, t)) : 0);
  const rejected = [];
  run(p, 10, hi, clock, r => rejected.push(r.artifact.rejected));
  assert.ok(rejected.slice(-30).every(v => !v), 'should stop rejecting once the level is the new normal');
});
