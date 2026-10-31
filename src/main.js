import { BAND_NAMES } from './dsp/bands.js';
import { SignalPipeline } from './dsp/pipeline.js';
import { Lab } from './ui/lab.js';
import { SimulatedSource } from './input/simulated.js';
import { GpuScene } from './visuals/gpu.js';
import { Scene } from './visuals/scene.js';
import { Synth } from './audio/synth.js';
import { Recorder, Replayer, saveSession, listSessions, exportSession } from './session/recorder.js';
import { SessionGuide } from './session/guide.js';

const $ = id => document.getElementById(id);
let scene, hydra = null, hydraSnap = false;
try { scene = await GpuScene.create($('c')); }
catch (e) { console.warn('GPU scene failed, 2D fallback', e); scene = new Scene($('c')); }
window.hbi = scene;
const flashFn = () => scene.flash || 0;

// Views: INK (fluid + injector arms, two canvases), SPRAY and ORBS (calm 3D), PAINT (feedback particles on #c)
const VIEWS = ['ink', 'spray', 'orbs', 'paint'];
const VIEW_CANVAS = { ink: ['cink', 'carms'], spray: ['cspray'], orbs: ['corbs'], paint: ['c'] };
const LOADERS = {
  ink: async () => new (await import('./visuals/ink.js')).InkView($('cink'), $('carms')),
  spray: async () => new (await import('./visuals/spray.js')).SprayView($('cspray')),
  orbs: async () => new (await import('./visuals/orbs.js')).OrbsView($('corbs')),
};
const views = { paint: scene };
let view = 'paint', cur = scene;
let loading = null;   // one view load at a time: a second V press mid-load would build a duplicate on the same canvas
async function setView(v) {
  if (loading) return;
  if (!views[v]) {
    try { loading = v; views[v] = await LOADERS[v](); }
    catch (e) {
      console.warn(e); msg(`${v.toUpperCase()} view unavailable: ${e.message}`);
      if (v === 'ink' && view === 'paint' && !views.spray) { loading = null; return setView('spray'); }   // first load without WebGL2
      return;
    }
    finally { if (loading === v) loading = null; }
  }
  if (v !== 'paint' && hydra?.on) { hydra.toggle(); $('mode').textContent = 'Glitch (G)'; }
  view = v; cur = views[v];
  for (const k of VIEWS) for (const id of VIEW_CANVAS[k]) $(id).hidden = k !== v;
  cur.resize?.();
  $('view').textContent = `View: ${v.toUpperCase()} (V)`;
  $('mode').hidden = v !== 'paint';
  try { localStorage.setItem('hbi.view', v); } catch {}
}
const nextView = () => setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]);
window.hbiViews = () => ({ view, cur, views, state });   // console/debug handle (no signal data beyond the state object)
const synth = new Synth();
// guided sessions + recording/replay (declared before useSim(): swapTo ends a running session)
const rec = new Recorder(), guide = new SessionGuide(), gv = {}, repEvents = [];
let replay = null, sessionList = [], sourceLabel = 'SIM';
window.hbiSynth = synth;
const pipe = new SignalPipeline();
const CAL_KEY = 'hbi.calibration.v2';   // local-only: eyes-open/closed index levels (dB) + timestamp, no device IDs
try { localStorage.removeItem('hbi.calibration.v1'); } catch {}   // v1 (single-state z-score) no longer applies
try { const j = JSON.parse(localStorage.getItem(CAL_KEY) || 'null'); if (j && !pipe.importCalibration(j)) localStorage.removeItem(CAL_KEY); } catch {}
let sig = null;   // latest pipeline result
let beatBase = 0, beatAt = 0;   // last heart phase from the pipeline, extrapolated per frame
// hardware-test readout: run hbiDiag() in DevTools and paste the JSON (signal stats only, no device IDs)
const diag = { since: 0, ticks: 0, rejected: 0 };
const r1 = v => Math.round(v * 100) / 100;
window.hbiDiag = () => {
  if (!sig) return null;
  const out = {
    source: $('status').textContent, ready: state.ready, secondsSinceSwap: Math.round((performance.now() - diag.since) / 1000),
    events: { blink: diag.blink || 0, clench: diag.clench || 0, beat: diag.beat || 0 },
    rejectedPct: diag.ticks ? Math.round((100 * diag.rejected) / diag.ticks) : 0,
    quality: Object.fromEntries(CH.map((n, i) => [n, { label: sig.quality[i].label, std: r1(sig.quality[i].std), score: r1(sig.quality[i].score) }])),
    relax: r1(sig.relax), focus: r1(sig.focus), relaxDb: r1(sig.relaxDb), focusDb: r1(sig.focusDb),
    bandDb: Object.fromEntries(BAND_NAMES.map(k => [k, r1(sig.dB[k])])),
    bands: Object.fromEntries(BAND_NAMES.map(k => [k, r1(sig.bands[k])])),
    bpm: Math.round(sig.bpm), heartLock: r1(sig.beatConf), heartSource: sig.heartSource,
    calibration: sig.calibration.state, calibrationResult: sig.calibration.result, artifactNow: { ...sig.artifact }, held: [...sig.held],
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
};
let calWas = pipe.calibrated ? 'done' : 'none';   // calibration UI state: none | running | done
const rate = { eeg: 0, ppg: 0, imu: 0 };   // samples/sec counters for stream health
const CH = ['TP9', 'AF7', 'AF8', 'TP10'];

const state = {
  // readiness gate: nothing moves, paints or sounds until 'live' (streaming + contact + calibrated this session)
  ready: 'idle',
  bands: Object.fromEntries(BAND_NAMES.map(k => [k, 0])),
  ch: Array.from({ length: 4 }, () => Object.fromEntries(BAND_NAMES.map(k => [k, 0]))),
  quality: Array.from({ length: 4 }, () => ({ label: 'off', score: 0 })),
  held: [false, false, false, false], motion: false,   // artifact holds per channel; motion glitches every injector
  relax: 0.5, focus: 0.5,   // primary drivers (0..1): calm vs activation — see docs/SIGNALS.md
  beatPhase: 0, beatConf: 0, // heart clock: 0..1 through the current beat, lock confidence — only real beats move anything
  bpm: 0, tilt: { x: 0, y: 0 }, gyro: { x: 0, y: 0, z: 0 }, battery: null,
};

const msg = t => ($('msg').textContent = t);

let source = null;
let lastEeg = 0, motionUntil = 0;
let sessionCal = false;   // calibrated (or saved baseline confirmed) since this source started
const setStatus = label => ($('status').textContent = label);
// handlers ignore events from any source that isn't the live one (e.g. a Muse still connecting while SIM runs)
function wire(src) {
  const live = fn => d => { if (source === src) fn(d); };
  src.on('eeg', live(({ ch, samples }) => { pipe.push(ch, samples); if (ch === 0) { rate.eeg += samples.length; lastEeg = performance.now(); } }));
  src.on('ppg', live(({ ch, samples }) => { pipe.pushPpg(ch, samples); if (ch === 1) rate.ppg += samples.length; }));   // all 3 channels: 0 is ambient light, the pulse is on 1/2
  src.on('accel', live(a => { rate.imu++; pipe.pushMotion('accel', a); if (replay) return; state.tilt.x += (Math.max(-1, Math.min(1, a.x)) - state.tilt.x) * 0.1; state.tilt.y += (Math.max(-1, Math.min(1, a.y)) - state.tilt.y) * 0.1; }));
  src.on('gyro', live(g => { pipe.pushMotion('gyro', g); if (replay) return; state.gyro.x = g.x; state.gyro.y = g.y; state.gyro.z = g.z; }));
  src.on('battery', live(p => { state.battery = p; $('batt').textContent = `🔋 ${Math.round(p)}%`; }));
  src.on('reconnecting', live(({ attempt, max }) => { msg(`Muse signal lost — reconnecting (${attempt}/${max})`); setStatus('MUSE 2 · RECONNECTING'); }));
  src.on('reconnected', live(() => { msg('Muse 2 reconnected'); setStatus('MUSE 2'); }));
  src.on('error', live(({ message }) => msg('Muse: ' + message)));
  src.on('disconnect', live(() => { msg('Muse disconnected — back to SIM'); useSim(); }));
}
function swapTo(src, label) {
  const prev = source;
  source = src;
  prev?.stop();
  Object.assign(diag, { since: performance.now(), ticks: 0, rejected: 0, blink: 0, clench: 0, beat: 0 });
  pipe.reset();   // re-learn adaptive ranges per source; calibration is kept, a running one is stopped
  if (calWas === 'running') settleCalibration(`Calibration stopped — switched to ${label}`);
  sessionCal = false; lastEeg = 0;   // every new source re-syncs: contact check + calibration before anything moves
  state.battery = null; $('batt').textContent = '🔋 --';
  $('simbtns').hidden = label !== 'SIM';
  if (guide.on) finishSession(`Session ended — switched to ${label}`);
  if (replay) stopReplay();
  sourceLabel = label; setStatus(label);
}
function useSim() { const s = (window.sim = new SimulatedSource()); wire(s); swapTo(s, 'SIM'); s.start(); }
useSim();

let connecting = false;
$('connect').onclick = async () => {
  if (connecting) return;
  connecting = true; $('connect').disabled = true; msg('Pick your Muse in the Chrome dialog…');
  try {
    const { MuseSource } = await import('./input/muse.js');
    const m = new MuseSource(); wire(m);
    await m.start();                      // SIM keeps streaming until the headset is actually streaming
    window.sim = null; swapTo(m, 'MUSE 2'); msg(`${m.deviceName || 'Muse 2'} connected — check the sensor map, then calibrate`);
  } catch (e) { msg('Connect failed: ' + e.message + ' — staying on SIM'); }
  finally { connecting = false; $('connect').disabled = false; }
};

// Sound is on by default: browsers only allow audio after a gesture, so the first click/key starts it
let muted = false;
try { muted = localStorage.getItem('hbi.muted') === '1'; } catch {}
const showMute = () => { $('mute').textContent = muted ? 'Unmute (M)' : 'Mute (M)'; $('mute').classList.toggle('done', muted); };
async function startAudio() {
  if (synth.ctx) return;
  await synth.start(); synth.setMuted(muted);
  $('soundhint').hidden = true;
}
$('soundhint').hidden = false;
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, startAudio, { once: false, passive: true });
function toggleMute() {
  muted = !muted; showMute();
  try { localStorage.setItem('hbi.muted', muted ? '1' : '0'); } catch {}
  if (synth.ctx) synth.setMuted(muted);
}
$('mute').onclick = toggleMute;
showMute();

const snap = () => (hydra?.on ? (hydraSnap = true) : cur.snapshot());
$('snap').onclick = snap;
const toggleMode = async () => {
  if (view !== 'paint') await setView('paint');   // the glitch synth layers over the PAINT view only
  try {
    if (!hydra) { const { HydraLayer } = await import('./visuals/hydra.js'); hydra = new HydraLayer($('c'), state, flashFn); }
  } catch (e) { msg('Glitch-synth unavailable: ' + e.message); return; }
  $('mode').textContent = hydra.toggle() ? 'Glitch: ON (G)' : 'Glitch (G)';
};
$('mode').onclick = toggleMode;
$('clear').onclick = () => cur.clear();
$('view').onclick = nextView;
$('hide').onclick = () => $('hud').classList.toggle('hidden');
$('simbtns').onclick = e => e.target.dataset.m && window.sim?.setMode?.(e.target.dataset.m);
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'h') $('hud').classList.toggle('hidden');
  if (e.key === 's') snap();
  if (e.key === 'g') toggleMode();
  if (e.key === 'v') nextView();
  if (e.key === 'm') toggleMute();
  if (e.key === 'Enter') reuseBaseline();
  if (e.key === 'r') toggleSession();
  if (e.key === 'p') toggleReplay();
  if (e.key === 'Escape') { if (guide.on) finishSession('Session ended early'); else if (replay) stopReplay('Playback stopped'); }
});

// Readiness: idle (no stream) → contact (fit the headband) → uncalibrated → live
const contactOk = q => q.label === 'good' || q.label === 'noisy';
function readiness(r, now) {
  if (!lastEeg || now - lastEeg > 1500) return 'idle';
  if (r.quality.filter(contactOk).length < 3) return 'contact';
  if (!sessionCal || r.calibration.state === 'running') return 'uncalibrated';
  return 'live';
}
function reuseBaseline() {
  if (!pipe.calibrated || sessionCal || state.ready !== 'uncalibrated' || calWas === 'running') return;
  sessionCal = true; msg('Using your saved baseline — recalibrate (C) any time');
}
$('step').onclick = reuseBaseline;

function stepText(ready, r) {
  const n = r.quality.filter(contactOk).length;
  if (ready === 'idle') return 'Connect your Muse to begin';
  if (ready === 'contact') return `Adjust the fit — ${n}/4 sensors reading (wet the sensors, headband snug)`;
  if (ready === 'uncalibrated') {
    if (r.calibration.state === 'running') return 'Calibrating…';
    return pipe.calibrated ? 'Calibrate (C) to begin — or Enter to reuse your saved baseline' : 'Calibrate (C) to begin';
  }
  return r.bpm ? 'Live' : 'Live — looking for your pulse (sit still)';
}

// dock readouts
const QCLASS = { good: 'q-good', noisy: 'q-noisy', 'no contact': 'q-bad', railed: 'q-bad', off: 'q-off' };
const pct = v => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
const meter = (k, v) => { $('m-' + k).style.width = pct(v); $('v-' + k).textContent = v.toFixed(2); };

// DSP @20Hz (heart clock resolution ≈50ms) — all signal math lives in src/dsp; main only consumes the result.
// During playback the recorded state stream replaces the live one (the headset keeps streaming underneath).
setInterval(() => {
  const now = performance.now();
  const r = (sig = pipe.tick(now));
  let events;
  if (replay) {
    events = replay.step(state, repEvents);
    beatBase = state.beatPhase; beatAt = now;
    if (replay.done) stopReplay('Playback finished — P to play again');
    else $('replayfill').style.width = pct(replay.progress);
  } else {
    events = r.events;
    const ready = (state.ready = readiness(r, now));
    const streaming = ready !== 'idle';
    for (const k of BAND_NAMES) { state.bands[k] = r.bands[k]; for (let i = 0; i < 4; i++) state.ch[i][k] = r.ch[i][k]; }
    for (let i = 0; i < 4; i++) {
      state.quality[i].label = streaming ? r.quality[i].label : 'off';
      state.quality[i].score = streaming ? r.quality[i].score : 0;
      state.held[i] = streaming && r.held[i];
    }
    if (r.artifact.motion) motionUntil = now + 1000;
    state.motion = streaming && now < motionUntil;
    state.bpm = r.bpm; state.relax = r.relax; state.focus = r.focus;
    state.beatConf = r.beatConf; beatBase = r.beatPhase; beatAt = now;
    lab.update(r);
    diag.ticks++; if (r.artifact.rejected) diag.rejected++;
    for (const e of events) diag[e] = (diag[e] || 0) + 1;
  }

  const ready = state.ready, live = ready === 'live';
  meter('relax', live ? state.relax : 0); meter('focus', live ? state.focus : 0);
  for (const k of BAND_NAMES) $('kb-' + k).style.width = pct(live ? state.bands[k] : 0);
  $('bpm').textContent = state.bpm ? `♥ ${Math.round(state.bpm)}` : state.beatConf > 0.05 ? '♥ …' : '♥ --';
  $('bpm').title = replay ? 'recorded heartbeat' : r.heartSource ? `heart lock ${Math.round(r.beatConf * 100)}% via ${r.heartSource} PPG` : 'looking for a pulse';
  $('step').textContent = replay ? `Replaying — ${replay.phase === 'closed' ? 'eyes closed' : 'eyes open'} part` : guide.on ? 'Session running' : stepText(ready, r);
  $('step').dataset.ready = ready;
  for (let i = 0; i < 4; i++) $('s-' + CH[i]).setAttribute('class', state.held[i] ? 'q-held' : QCLASS[state.quality[i].label] || 'q-off');

  for (const e of events) {
    if (!live) continue;   // before sync nothing reacts — not even to real beats
    if (e === 'beat') { const k = Math.min(1, state.beatConf * 1.2); cur.onBeat(k); synth.beat(k); $('bpm').classList.remove('beat'); void $('bpm').offsetWidth; $('bpm').classList.add('beat'); }
    else if (e === 'blink' || e === 'clench') { cur.onBlink(); synth.blink(); }   // mapping: blink/clench → disturbance + glitch, noise burst
  }
  if (!replay) { updateCalibration(r.calibration); runSession(now, r, events); }
}, 50);

// Guided session: eyes open 30s → eyes closed N min → eyes open 30s, recorded for playback
const PHASE_UI = {
  open: ['EYES OPEN · 1 OF 3', 'Eyes open — soft gaze on the ink. Notice what it shows.', 'Close your eyes in…'],
  closed: ['EYES CLOSED · 2 OF 3', 'Eyes closed — breathe slowly. Rising tones will bring you back.', 'Coming back… open your eyes at the chime'],
  open2: ['EYES OPEN · 3 OF 3', 'Open your eyes — see how the ink changed.', ''],
};
function toggleSession() { guide.on ? finishSession('Session ended early') : beginSession(); }
function beginSession() {
  if (guide.on || replay) return;
  if (state.ready !== 'live') { msg('Sync first: the dock step must read Live before a session'); return; }
  if (calWas === 'running') return;
  const min = +$('medlen').value || 3;
  guide.start(min, performance.now()); rec.start({ closedMin: min, source: sourceLabel });
  $('sessov').hidden = false; $('session').textContent = 'End session (R)'; $('session').classList.add('done');
  msg(`Session: 30s eyes open, ${min} min eyes closed, 30s eyes open. Recording.`);
}
function runSession(now, r, events) {
  if (!guide.on) return;
  const g = guide.step(now, gv);
  rec.push(state, events, r.dB.alpha, g.phaseIndex);
  const [label, txt, countTxt] = PHASE_UI[g.phase];
  $('sessphase').textContent = label;
  $('sesstxt').textContent = g.count != null && countTxt ? countTxt : txt;
  $('sesscount').textContent = g.count ?? '';
  $('sessov').classList.toggle('count', g.count != null);
  $('sessov').classList.toggle('closed', g.phase === 'closed' && g.count == null);
  $('sessfill').style.width = pct(g.progress);
  if (g.tone) synth.sessionTone(g.tone.kind, g.tone.n);
  if (g.done) finishSession(null);
}
async function finishSession(text) {
  if (!guide.on) return;
  guide.stop();
  const s = rec.stop();
  $('sessov').hidden = true; $('session').textContent = 'Begin session (R)'; $('session').classList.remove('done');
  if (!s || s.n < 20 * 20) { msg((text || 'Session ended') + ' — too short to save'); return; }
  await saveSession(s); await refreshSessions(s.id);
  msg((text ? text + '. ' : '') + summaryText(s.summary) + ' — P to play it back');
}
function summaryText(sm) {
  const o = sm.open, o2 = sm.open2, c = sm.closed;
  const openN = o.sec + o2.sec;
  if (!c.sec || !openN) return 'Session saved';
  const avg = k => (o[k] * o.sec + o2[k] * o2.sec) / openN;
  const da = c.alphaDb - avg('alphaDb');
  const hr = c.bpm && avg('bpm') ? ` · ♥ ${Math.round(c.bpm)} vs ${Math.round(avg('bpm'))}` : '';
  return `Saved. Eyes closed vs open: relax ${c.relax.toFixed(2)} vs ${avg('relax').toFixed(2)} · alpha ${da >= 0 ? '+' : ''}${da.toFixed(1)} dB${hr}`;
}

// Playback: the saved state stream drives the current view and the sound exactly as it did live
async function refreshSessions(selectId) {
  sessionList = await listSessions();
  const fmt = s => `${new Date(s.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${s.closedMin} min`;
  $('sessions').innerHTML = sessionList.length ? sessionList.map(s => `<option value="${s.id}">${fmt(s)}</option>`).join('') : '<option value="">no sessions yet</option>';
  if (selectId) $('sessions').value = selectId;
  $('replay').disabled = $('export').disabled = !sessionList.length;
}
const selected = () => sessionList.find(s => s.id === $('sessions').value) || sessionList[0];
function toggleReplay() { replay ? stopReplay('Playback stopped') : startReplay(selected()); }
function startReplay(s) {
  if (!s || guide.on || calWas === 'running') return;
  replay = new Replayer(s);
  cur.clear(); setStatus('REPLAY');
  $('replaylabel').textContent = `Playback · ${new Date(s.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${s.closedMin} min eyes closed`;
  $('replaymarks').innerHTML = s.marks.map(m => `<i class="${m.phase === 'closed' ? 'closed' : 'open'}" style="left:${(100 * m.i / s.n).toFixed(2)}%"></i>`).join('');
  $('replayfill').style.width = '0%'; $('replaybar').hidden = false; $('replay').textContent = 'Stop (P)';
}
function stopReplay(text) {
  if (!replay) return;
  replay = null; $('replaybar').hidden = true; $('replay').textContent = 'Play back (P)';
  setStatus(sourceLabel);
  if (text) msg(text);
}
$('session').onclick = toggleSession;
$('sessend').onclick = () => finishSession('Session ended early');
$('replay').onclick = toggleReplay;
$('replaystop').onclick = () => stopReplay('Playback stopped');
$('export').onclick = () => { const s = selected(); if (s) exportSession(s); };
refreshSessions();

// Calibration: step 1 eyes open, step 2 eyes closed (10s clean each); a tone marks each step when audio is on
const CAL_STEPS = {
  open: ['STEP 1 OF 2 · EYES OPEN', 'Look softly at one point on the screen. Stay still, jaw relaxed.'],
  closed: ['STEP 2 OF 2 · EYES CLOSED', 'Close your eyes and relax. Two rising tones mean done — open your eyes then.'],
};
let calPhase = null;
function showCalibrated() { $('calib').classList.toggle('done', sessionCal); $('calib').textContent = pipe.calibrated ? 'Recalibrate (C)' : 'Calibrate (C)'; }
function updateCalibration(c) {
  if (c.state === 'running') {
    if (c.phase !== calPhase) {
      if (calPhase) synth.cue(1);   // open → closed
      calPhase = c.phase; [$('calstep').textContent, $('caltxt').textContent] = CAL_STEPS[c.phase];
    }
    $('calfill').style.width = `${Math.round(c.phaseProgress * 100)}%`;
    $('calleft').textContent = `about ${Math.ceil(c.phaseLeft)}s left in this step`;
  }
  if (c.state === calWas) return;
  if (calWas === 'running' && c.state === 'done') {
    try { localStorage.setItem(CAL_KEY, JSON.stringify(pipe.exportCalibration())); } catch {}
    sessionCal = true;
    synth.cue(2);
    const g = c.result.alphaGainDb, gs = `${g >= 0 ? '+' : ''}${g.toFixed(1)} dB`;
    msg(c.result.verdict === 'strong' ? `Calibrated — eyes-closed alpha ${gs}: clear signal. You're live.`
      : c.result.verdict === 'weak' ? `Calibrated — eyes-closed alpha only ${gs}: weak. Wet the ear sensors and recalibrate for a clearer range.`
      : `Eyes-closed alpha didn't rise (${gs}) — check ear-sensor contact, then recalibrate. Using defaults meanwhile.`);
  }
  $('calov').hidden = c.state !== 'running';
  if (c.state !== 'running') calPhase = null;
  calWas = c.state; showCalibrated();
}
function startCalibration() {
  if (calWas === 'running') return;
  if (replay || guide.on) { msg('Finish the session or playback before calibrating'); return; }
  if (state.ready === 'idle' || state.ready === 'contact') { msg('Get at least 3 sensors reading first (see the sensor map)'); return; }
  $('calfill').style.width = '0%'; pipe.startCalibration({ open: 10, closed: 10 });
  if (source === window.sim) msg('Calibrating on SIM — connect the Muse for a real baseline');
}
// settle UI state here so the next tick doesn't read a cancelled run as "finished"
function settleCalibration(text) {
  calWas = pipe.calibrated ? 'done' : 'none'; calPhase = null;
  $('calov').hidden = true; showCalibrated();
  msg(text + (pipe.calibrated ? ' — saved baseline still available (Enter)' : ''));
}
function cancelCalibration() {
  if (calWas !== 'running') return;
  pipe.cancelCalibration();
  settleCalibration('Calibration cancelled');
}
$('calib').onclick = startCalibration;
const lab = new Lab($('lab'));
const toggleLab = () => { $('labbtn').classList.toggle('done', lab.toggle()); };
$('labbtn').onclick = toggleLab;
$('calcancel').onclick = cancelCalibration;
addEventListener('keydown', e => { if (e.metaKey || e.ctrlKey || e.altKey) return; if (e.key === 'c') startCalibration(); if (e.key === 'l') toggleLab(); if (e.key === 'Escape') cancelCalibration(); });
showCalibrated();

// stream health @1Hz
setInterval(() => {
  if (!sig) return;
  $('rates').textContent = `EEG ${rate.eeg}Hz · PPG ${rate.ppg}Hz · IMU ${rate.imu}/s${sig.artifact.rejected && state.ready !== 'idle' ? ' · artifact hold' : ''}`;
  rate.eeg = rate.ppg = rate.imu = 0;
}, 1000);

let savedView = 'ink';
try { savedView = localStorage.getItem('hbi.view') || 'ink'; } catch {}
await setView(VIEWS.includes(savedView) ? savedView : 'ink');

let prev = performance.now();
(function loop(t) {
  const dt = Math.min(0.1, (t - prev) / 1000); prev = t;
  if (state.bpm) state.beatPhase = (beatBase + ((t - beatAt) / 1000) * (state.bpm / 60)) % 1;
  cur.frame(state, dt);
  if (hydra && view === 'paint' && state.ready === 'live') { hydra.tick(dt); if (hydraSnap) { hydraSnap = false; hydra.snapshot(); } }
  synth.update(state);
  requestAnimationFrame(loop);
})(prev);
