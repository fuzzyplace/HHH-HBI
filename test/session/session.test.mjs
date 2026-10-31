import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, Replayer } from '../../src/session/recorder.js';
import { SessionGuide } from '../../src/session/guide.js';

const B = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
const mkState = () => ({
  ready: 'live', bands: Object.fromEntries(B.map(b => [b, 0.3])), ch: [0, 1, 2, 3].map(() => Object.fromEntries(B.map(b => [b, 0.3]))),
  quality: [0, 1, 2, 3].map(() => ({ label: 'good', score: 0.9 })), held: [false, true, false, false], motion: false,
  relax: 0.3, focus: 0.5, bpm: 70, beatConf: 0.8, beatPhase: 0.2, tilt: { x: 0, y: 0 }, gyro: { x: 0, y: 0, z: 0 },
});

function runSession(min = 1) {
  const g = new SessionGuide(), r = new Recorder(), st = mkState(), tones = [];
  g.start(min, 0); r.start({ closedMin: min });
  let o = {};
  for (let t = 0; ; t += 50) {
    o = g.step(t, o);
    st.relax = o.phase === 'closed' ? 0.8 : 0.3;
    r.push(st, t % 850 === 0 ? ['beat'] : [], o.phase === 'closed' ? -2 : -6, o.phaseIndex);
    if (o.tone) tones.push([Math.round(t / 1000), o.tone.kind, o.tone.n]);
    if (o.done) break;
  }
  return { s: r.stop(), tones };
}

test('guide: open 30s → closed N min → open 30s, falling countdown in, rising count out, chime', () => {
  const { s, tones } = runSession(1);
  assert.deepEqual(s.marks.map(m => [m.i, m.phase]), [[0, 'open'], [600, 'closed'], [1800, 'open2']]);
  assert.deepEqual(tones.filter(t => t[1] === 'down').map(t => t[2]), [5, 4, 3, 2, 1]);
  assert.deepEqual(tones.filter(t => t[1] === 'up').map(t => t[2]), [1, 2, 3, 4, 5]);
  assert.equal(tones.filter(t => t[1] === 'closed').length, 1);
  assert.equal(tones.filter(t => t[1] === 'open').length, 1);
});

test('summary compares eyes closed with eyes open', () => {
  const { s } = runSession(1);
  assert.equal(s.summary.closed.sec, 60);
  assert.ok(Math.abs(s.summary.closed.relax - 0.8) < 1e-6 && Math.abs(s.summary.open.relax - 0.3) < 1e-6);
  assert.ok(Math.abs(s.summary.closed.alphaDb - s.summary.open.alphaDb - 4) < 1e-4);
});

test('replay restores the state stream and every beat', () => {
  const { s } = runSession(1);
  const rp = new Replayer(s), st = mkState(), out = [];
  st.ready = 'idle'; st.held[1] = false;
  let beats = 0;
  while (!rp.done) { rp.step(st, out); beats += out.filter(e => e === 'beat').length; }
  assert.equal(beats, s.events.length);
  assert.equal(st.ready, 'live');
  assert.equal(st.held[1], true);
  assert.ok(!JSON.stringify(Object.keys(s)).match(/device|mac|name/i), 'no device identifiers stored');
});
