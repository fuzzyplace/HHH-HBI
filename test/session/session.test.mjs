import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, Replayer, summarize } from '../../src/session/recorder.js';
import { SessionGuide } from '../../src/session/guide.js';

const B = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
const mkState = () => ({
  ready: 'live', bands: Object.fromEntries(B.map(b => [b, 0.3])), ch: [0, 1, 2, 3].map(() => Object.fromEntries(B.map(b => [b, 0.3]))),
  quality: [0, 1, 2, 3].map(() => ({ label: 'good', score: 0.9 })), held: [false, true, false, false], motion: false,
  relax: 0.3, focus: 0.5, bpm: 70, beatConf: 0.8, beatPhase: 0.2, tilt: { x: 0, y: 0 }, gyro: { x: 0, y: 0, z: 0 },
});

function runSession(min = 3) {
  const g = new SessionGuide(), r = new Recorder(), st = mkState(), tones = [];
  g.start(min, 0); r.start({ minutes: min });
  let o = {};
  for (let t = 0; ; t += 50) {
    o = g.step(t, o);
    st.relax = o.phase === 'rest' ? 0.8 : 0.3;
    r.push(st, t % 850 === 0 ? ['beat'] : [], o.phase === 'rest' ? -2 : -6, o.phaseIndex);
    if (o.tone) tones.push([Math.round(t / 1000), o.tone.kind, o.tone.n]);
    if (o.done) break;
  }
  return { s: r.stop(), tones };
}

test('practice: arrive 30s → breathe → rest (eyes closed) → return 30s, with counts and cues', () => {
  const { s, tones } = runSession(3);   // 3 min: 30 + 60 + 60 + 30 s
  assert.deepEqual(s.marks.map(m => [m.i, m.phase]), [[0, 'arrive'], [600, 'breathe'], [1800, 'rest'], [3000, 'return']]);
  assert.deepEqual(s.phases, ['arrive', 'breathe', 'rest', 'return']);
  assert.deepEqual(tones.filter(t => t[1] === 'down').map(t => t[2]), [5, 4, 3, 2, 1]);
  assert.deepEqual(tones.filter(t => t[1] === 'up').map(t => t[2]), [1, 2, 3, 4, 5]);
  for (const k of ['begin', 'closed', 'open']) assert.equal(tones.filter(t => t[1] === k).length, 1, k);
});

test('summary compares resting (eyes closed) with arriving', () => {
  const { s } = runSession(3);
  assert.equal(s.summary.rest.sec, 60);
  assert.ok(Math.abs(s.summary.rest.relax - 0.8) < 1e-6 && Math.abs(s.summary.arrive.relax - 0.3) < 1e-6);
  assert.ok(Math.abs(s.summary.rest.alphaDb - s.summary.arrive.alphaDb - 4) < 1e-4);
});

test('sessions saved before the journey still summarize and replay by their old phase names', () => {
  const { s } = runSession(3);
  delete s.phases;   // old format: indices meant open / closed / open2
  const sm = summarize(s);
  assert.ok(sm.open && sm.closed && sm.open2);
  assert.equal(new Replayer(s).phase, 'open');
});

test('replay restores the state stream and every beat', () => {
  const { s } = runSession(3);
  const rp = new Replayer(s), st = mkState(), out = [];
  st.ready = 'idle'; st.held[1] = false;
  let beats = 0;
  while (!rp.done) { rp.step(st, out); beats += out.filter(e => e === 'beat').length; }
  assert.equal(beats, s.events.length);
  assert.equal(st.ready, 'live');
  assert.equal(st.held[1], true);
  assert.ok(!JSON.stringify(Object.keys(s)).match(/device|mac|name/i), 'no device identifiers stored');
});

test('scrubbing: fast-forward fires each event once, rewind fires none, pause holds', () => {
  const { s } = runSession(3);
  const rp = new Replayer(s), st = mkState(), out = [];
  let fwd = 0;
  while (!rp.done) { rp.step(st, out, 3); fwd += out.filter(e => e === 'beat').length; }
  assert.equal(fwd, s.events.length);
  const back = new Replayer(s); back.pos = s.n - 1; back.ev = s.events.length;
  let rew = 0;
  for (let k = 0; k < 1000; k++) { back.step(st, out, -4); rew += out.length; }
  assert.equal(rew, 0); assert.equal(back.pos, 0);
  const p = new Replayer(s); p.step(st, out, 0); p.step(st, out, 0);
  assert.equal(p.pos, 0);
});
