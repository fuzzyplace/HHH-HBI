// Composition root: builds the pieces and wires them together. Signal math lives in src/dsp, devices in src/input,
// pictures in src/visuals, sound in src/audio, the guided journey in src/journey. Everything visual or audible reads
// only the `state` object below.
import { BAND_NAMES } from './dsp/bands.js';
import { SignalPipeline } from './dsp/pipeline.js';
import { BreathSync } from './dsp/sync.js';
import { Body } from './input/body.js';
import { FeatureInputs } from './input/features.js';
import { Synth } from './audio/synth.js';
import { Recorder, Replayer, saveSession, listSessions, exportSession, deleteSession } from './session/recorder.js';
import { SessionGuide } from './session/guide.js';
import { Journey, LENGTHS } from './journey/journey.js';
import { Screens } from './journey/screens.js';
import { Lab } from './ui/lab.js';
import { initTelemetry, track, trackOnce } from './telemetry.js';
initTelemetry();

const $ = id => document.getElementById(id);
const CH = ['TP9', 'AF7', 'AF8', 'TP10'];
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

// ---------------------------------------------------------------- state: the only thing views and sound read
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
  play: false, head: { x: 0, y: 0 },                        // PLAY: head orientation stirs the art
  breath: { on: false, phase: 0, level: 0 }, sync: 0, harmony: 0,   // BREATHE: machine breath + heart-rhythm sync
  music: 'chord',
  // state.camera (and any later input) is added by inputs.register below
};

// ---------------------------------------------------------------- core pieces
const pipe = new SignalPipeline();
const CAL_KEY = 'hbi.calibration.v2';   // local-only: eyes-open/closed index levels (dB) + timestamp, no device IDs
try { localStorage.removeItem('hbi.calibration.v1'); } catch {}
try { const j = JSON.parse(store.get(CAL_KEY) || 'null'); if (j && !pipe.importCalibration(j)) localStorage.removeItem(CAL_KEY); } catch {}
const body = new Body(pipe);
const inputs = new FeatureInputs(state);
inputs.register('camera', () => import('./input/camera.js'), { motion: 0, x: 0, y: 0, vx: 0, vy: 0, light: 0 });
const synth = new Synth();
const journey = new Journey();
const screens = new Screens(act);
const guide = new SessionGuide(), rec = new Recorder(), gv = {}, repEvents = [];
const breathSync = new BreathSync();
const lab = new Lab($('lab'));
let sig = null;                       // latest pipeline result
let sessionCal = false;               // calibrated (or saved baseline accepted) since this source started
let calWas = pipe.calibrated ? 'done' : 'none';   // calibration UI state: none | running | done
let beatBase = 0, beatAt = 0, motionUntil = 0;
let replay = null, sessionList = [], lastSession = null, syncPeak = 0, noPulseSince = 0;
window.hbiSynth = synth;

// ---------------------------------------------------------------- messages + cheap DOM writes
let msgTimer = 0;
const msg = t => {
  const el = $('msg'); el.textContent = t; el.classList.remove('fade');
  clearTimeout(msgTimer); msgTimer = setTimeout(() => el.classList.add('fade'), 7000);
};
const ui = new Map();   // DOM writes only when the value changes (the DSP tick runs at 20Hz)
const put = (id, prop, v) => { const k = id + '.' + prop; if (ui.get(k) === v) return; ui.set(k, v); const el = $(id); if (prop === 'width') el.style.width = v; else el[prop] = v; };
const pct = v => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
const setStatus = label => { $('status').hidden = label === 'OFF'; $('status').textContent = label; };

// ---------------------------------------------------------------- views
// INK (fluid + injector arms, two canvases) is the journey's view; SPRAY, ORBS and PAINT open up in free play
const VIEWS = ['ink', 'spray', 'orbs', 'paint'];
const VIEW_CANVAS = { ink: ['cink', 'carms'], spray: ['cspray'], orbs: ['corbs'], paint: ['c'] };
let scene = null, hydra = null, hydraSnap = false;   // scene = PAINT, built on first use
const flashFn = () => scene?.flash || 0;
const LOADERS = {
  ink: async () => new (await import('./visuals/ink.js')).InkView($('cink'), $('carms')),
  spray: async () => new (await import('./visuals/spray.js')).SprayView($('cspray')),
  orbs: async () => new (await import('./visuals/orbs.js')).OrbsView($('corbs')),
  paint: async () => {
    try { scene = await (await import('./visuals/gpu.js')).GpuScene.create($('c')); }
    catch (e) { console.warn('GPU scene failed, 2D fallback', e); scene = new (await import('./visuals/scene.js')).Scene($('c')); }
    return (window.hbi = scene);
  },
};
const NOOP_VIEW = { frame() {}, onBeat() {}, onBlink() {}, clear() {}, snapshot() {}, resize() {} };   // until the first view loads
const views = {};
let view = null, cur = NOOP_VIEW, loading = null;   // one view load at a time (a second press mid-load would build a duplicate)
async function setView(v, remember = true) {
  if (loading || !VIEWS.includes(v)) return;
  if (!views[v]) {
    try { loading = v; views[v] = await LOADERS[v](); }
    catch (e) {
      console.warn(e); msg(`${v.toUpperCase()} view unavailable: ${e.message}`);
      if (v === 'ink' && !view) { loading = null; return setView('spray', remember); }   // first load without WebGL2
      return;
    }
    finally { if (loading === v) loading = null; }
  }
  if (v !== 'paint' && hydra?.on) { hydra.toggle(); $('mode').setAttribute('aria-pressed', 'false'); }
  if (v !== view) track('view', { v });
  view = v; cur = views[v];
  for (const k of VIEWS) for (const id of VIEW_CANVAS[k]) $(id).hidden = k !== v;
  cur.resize?.();
  for (const b of $('views').children) { const on = b.dataset.view === v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
  if (remember) store.set('hbi.view', v);
}
const nextView = () => setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]);
window.hbiViews = () => ({ view, cur, views, state });   // console/debug handle (no signal data beyond the state object)

// ---------------------------------------------------------------- sound: on by default, starts on the first gesture
let muted = store.get('hbi.muted') === '1';
const showMute = () => { $('mute').setAttribute('aria-pressed', muted); $('mute').setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound'); };
async function startAudio() {
  if (synth.ctx) return;
  await synth.start(); synth.setMuted(muted); synth.setMusic(state.music);
  track('audio_start', { muted });
  $('soundhint').hidden = true;
}
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, startAudio, { passive: true });
function toggleMute() {
  muted = !muted; showMute(); store.set('hbi.muted', muted ? '1' : '0');
  if (synth.ctx) synth.setMuted(muted);
}
$('mute').onclick = toggleMute;
showMute();

// ---------------------------------------------------------------- the body source (headset or simulator)
body.on('swap', label => {
  sessionCal = false;   // every new source re-syncs: contact check + calibration before anything moves
  if (calWas === 'running') { pipe.cancelCalibration(); settleCalibration(); }
  if (guide.on) finishPractice(true, `Practice ended: switched to ${label}`);
  if (replay) stopReplay();
  state.battery = null; $('batt').hidden = true; $('bpm').hidden = label === 'OFF';
  $('simbtns').hidden = label !== 'SIM';
  $('dconnect').textContent = label === 'MUSE 2' ? 'Use simulator' : 'Connect Muse';
  setStatus(label);
});
body.on('message', msg);
body.on('status', setStatus);
body.on('battery', p => { state.battery = p; $('batt').hidden = false; $('batt').textContent = `🔋 ${Math.round(p)}%`; });
body.on('lost', () => {
  if (journey.guided) { if (guide.on) finishPractice(true, null); journey.go(journey.path === 'muse' ? 'connect' : 'welcome'); screens.connectError('Your Muse disconnected. Switch it on and connect again.'); }
  else msg('Muse disconnected. Connect again from ⋯, or use the simulator.');
});

async function connectMuse() {
  screens.connectError(null); screens.connecting(true, body.hasBluetooth);
  track('connect_attempt');
  try { await body.connectMuse(); track('connect_ok'); return true; }
  catch (e) {
    track('connect_fail', { reason: e.reason || 'other' });
    const text = e.reason === 'cancelled' ? 'No headset chosen. Make sure it is switched on, then press Connect again.' : `Couldn't connect: ${e.message}`;
    if (journey.guided) screens.connectError(text); else msg(text);
    return false;
  } finally { screens.connecting(false, body.hasBluetooth); }
}

// ---------------------------------------------------------------- the journey
journey.minutes = LENGTHS.includes(+store.get('hbi.minutes')) ? +store.get('hbi.minutes') : 5;
screens.length(journey.minutes);
screens.onLength = m => { journey.minutes = m; store.set('hbi.minutes', m); };
screens.skipAvailable(store.get('hbi.journeyDone') === '1');
screens.connecting(false, body.hasBluetooth);

// messages float just above whatever sits at the bottom (the dock, the practice caption, or nothing)
const floor = () => { const el = journey.stage === 'explore' ? $('dockwrap') : journey.stage === 'practice' ? $('practice') : null; document.body.style.setProperty('--dock-h', (el?.offsetHeight || 0) + 'px'); };
new ResizeObserver(floor).observe($('dockwrap'));
new ResizeObserver(floor).observe($('practice'));

journey.on('stage', ({ stage, from }) => {
  screens.show(stage); floor();
  if (stage !== 'explore' && ui.get('quiet')) { ui.set('quiet', false); document.body.classList.remove('quiet'); }
  track('journey', { stage, path: journey.path || 'none' });
  if (stage === 'welcome') { body.off(); journey.path = null; screens.skipAvailable(store.get('hbi.journeyDone') === '1'); }
  if (stage === 'connect') screens.connecting(false, body.hasBluetooth);
  if (stage === 'baseline' && calWas !== 'running') screens.baselineIntro(pipe.calibrated);
  if (stage === 'explore') {
    store.set('hbi.journeyDone', '1');
    $('soundhint').hidden = !!synth.ctx;
    setView(VIEWS.includes(store.get('hbi.view')) ? store.get('hbi.view') : 'ink');
  } else if (from === 'explore' || from === 'welcome') {
    if (state.play) togglePlay(); if (state.breath.on) setBreath(false);
    toggleDock(true); if (lab.open) toggleLab();
    setView('ink', false);
  }
});

/** every journey button lands here (data-act="…") */
function act(name) {
  switch (name) {
    case 'muse': journey.begin('muse'); break;
    case 'sim': body.useSim(); journey.begin('sim'); break;
    case 'connect': connectMuse(); break;
    case 'welcome': journey.go('welcome'); break;
    case 'calibrate': journey.go('baseline'); startCalibration(); break;
    case 'reuse': reuseBaseline(); break;
    case 'cancelcal': cancelCalibration(); screens.baselineIntro(pipe.calibrated); break;
    case 'back': cancelCalibration(); journey.go(journey.backFromBaseline); break;
    case 'practice': beginPractice(); break;
    case 'endpractice': finishPractice(true, null); break;
    case 'again': journey.go(state.ready === 'live' ? 'ready' : 'baseline'); break;
    case 'watch': if (lastSession) { journey.go('explore'); startReplay(lastSession); } break;
    case 'explore':
      if (!body.source) { body.useSim(); if (pipe.calibrated) sessionCal = true; }   // straight to free play: simulator on a saved baseline
      journey.go('explore'); break;
  }
}

// ---------------------------------------------------------------- calibration (the journey's baseline step)
const contactOk = q => q.label === 'good' || q.label === 'noisy';
function readiness(r, now) {
  if (!body.streaming(now)) return 'idle';
  if (r.quality.filter(contactOk).length < 3) return 'contact';
  if (!sessionCal || r.calibration.state === 'running') return 'uncalibrated';
  return 'live';
}
function startCalibration() {
  if (calWas === 'running') return;
  if (replay || guide.on) { msg('Finish the practice or playback first'); return; }
  if (state.ready === 'idle' || state.ready === 'contact') { journey.go('fit'); return; }
  pipe.startCalibration({ open: 10, closed: 10 });
}
function reuseBaseline() {
  if (!pipe.calibrated || calWas === 'running' || state.ready === 'idle' || state.ready === 'contact') return;
  sessionCal = true; journey.go('ready'); screens.ready(null);
}
function settleCalibration() { calWas = pipe.calibrated ? 'done' : 'none'; screens.baselineIntro(pipe.calibrated); }
function cancelCalibration() { if (calWas === 'running') { pipe.cancelCalibration(); settleCalibration(); } }
function updateCalibration(c) {
  if (c.state === 'running') {
    if (calWas === 'running' && c.phase === 'closed' && ui.get('calph') !== 'closed') synth.cue(1);
    if (c.phase !== ui.get('calph')) body.sim?.setMode(c.phase === 'closed' ? 'calm' : 'focus');   // the simulated person follows the steps
    ui.set('calph', c.phase); screens.baselineRun(c);
  }
  if (c.state === calWas) return;
  if (calWas === 'running' && c.state === 'done') {
    store.set(CAL_KEY, JSON.stringify(pipe.exportCalibration()));
    sessionCal = true; synth.cue(2);
    track('calibrated', { verdict: c.result.verdict, source: body.label });
    const g = c.result.alphaGainDb, gs = `${g >= 0 ? '+' : ''}${g.toFixed(1)} dB`;
    screens.ready(c.result.verdict === 'strong' || body.onSim ? null : c.result.verdict === 'weak'
      ? `Your eyes-closed alpha rose only ${gs}, so the picture will be subtle. Dampening the ear sensors and measuring again can help.`
      : `Your eyes-closed alpha didn't rise (${gs}). Check the ear sensors touch skin, then measure again. Default ranges are in use meanwhile.`);
    journey.go('ready');
  }
  if (c.state !== 'running') { ui.delete('calph'); body.sim?.setMode('auto'); }
  calWas = c.state;
}

// ---------------------------------------------------------------- the practice: arrive → breathe → rest → return
function beginPractice() {
  if (guide.on || replay) return;
  if (state.ready !== 'live') { journey.go(state.ready === 'uncalibrated' ? 'baseline' : 'fit'); return; }
  const min = journey.minutes;
  track('session_start', { min, source: body.label });
  guide.start(min, performance.now()); rec.start({ minutes: min, source: body.label });
  syncPeak = 0; noPulseSince = 0;
  if (state.play) togglePlay();
  journey.go('practice');
}
function runPractice(now, r, events) {
  if (!guide.on) return;
  const g = guide.step(now, gv);
  rec.push(state, events, r.dB.alpha, g.phaseIndex);
  const breathing = g.phase === 'breathe';
  if (g.phase !== ui.get('pph')) { ui.set('pph', g.phase); body.sim?.setMode(g.phase === 'breathe' || g.phase === 'rest' ? 'calm' : 'auto'); }
  if (breathing !== state.breath.on) setBreath(breathing, true);
  if (breathing) syncPeak = Math.max(syncPeak, state.sync);
  if (state.bpm) noPulseSince = 0; else noPulseSince ||= now;
  const hint = state.ready === 'idle' ? 'Waiting for the headset signal…' : state.ready === 'contact' ? 'The signal faded. Adjust the band gently.'
    : noPulseSince && now - noPulseSince > 10000 ? 'Finding your pulse. Keep your head still.' : '';
  screens.practice(g, g.total, { word: state.breath.phase < 0.5 ? 'breathe in' : 'breathe out', sync: state.bpm ? state.sync : null, hint });
  if (g.tone) g.tone.kind === 'begin' ? synth.cue(1) : synth.sessionTone(g.tone.kind, g.tone.n);
  if (g.done) finishPractice(false, null);
}
async function finishPractice(early, text) {
  if (!guide.on) return;
  guide.stop(); setBreath(false, true); ui.delete('pph'); body.sim?.setMode('auto');
  const s = rec.stop();
  const saved = !!s && s.n >= 20 * 20;
  track('session_end', { saved, early, min: s ? Math.round(s.n / 20 / 6) / 10 : 0 });
  if (!saved) { journey.go('ready'); msg(text || 'Practice ended: too short to save'); return; }
  lastSession = s;
  screens.reflect(s.summary, syncPeak, true);
  journey.go('reflect');
  if (text) msg(text);
  await saveSession(s); await refreshSessions(s.id);
}

// ---------------------------------------------------------------- playback: a saved practice drives the view and sound again
const when = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const lengthOf = s => s.minutes ? `${s.minutes} min practice` : `${s.closedMin} min eyes closed`;
async function refreshSessions(selectId) {
  sessionList = await listSessions();
  $('sessions').innerHTML = sessionList.length ? sessionList.map(s => `<option value="${s.id}">${when(s.t)} · ${lengthOf(s)}</option>`).join('') : '<option value="">no practices yet</option>';
  if (selectId) $('sessions').value = selectId;
  $('replay').disabled = $('export').disabled = $('delsession').disabled = !sessionList.length;
}
const selected = () => sessionList.find(s => s.id === $('sessions').value) || sessionList[0];
function toggleReplay() { replay ? stopReplay('Playback stopped') : startReplay(selected()); }
function startReplay(s) {
  if (!s || guide.on || calWas === 'running') return;
  replay = new Replayer(s); replayPaused = false;
  track('replay', { play: state.play });
  if (state.play) $('playhint').textContent = PLAY_HINT.replay;
  cur.clear(); setStatus('REPLAY');
  $('replaylabel').textContent = `Playback · ${when(s.t)} · ${lengthOf(s)}`;
  $('replaymarks').innerHTML = s.marks.map(m => `<i class="${m.phase === 'rest' || m.phase === 'closed' ? 'closed' : 'open'}" style="left:${(100 * m.i / s.n).toFixed(2)}%" title="${m.phase}"></i>`).join('');
  $('replayfill').style.width = '0%'; $('replaybar').hidden = false; $('replay').textContent = 'Stop';
}
function stopReplay(text) {
  if (!replay) return;
  replay = null; $('replaybar').hidden = true; $('replay').textContent = 'Play back';
  $('playhint').textContent = PLAY_HINT.live;
  setStatus(body.label);
  if (text) msg(text);
}
$('replay').onclick = toggleReplay;
$('replaystop').onclick = () => stopReplay('Playback stopped');
$('export').onclick = () => { const s = selected(); if (s) { exportSession(s); track('export'); } };
$('delsession').onclick = async () => {
  const s = selected();
  if (!s || replay?.s === s) return;
  if (!confirm('Delete this saved practice from this browser? This cannot be undone.')) return;
  await deleteSession(s.id); if (lastSession?.id === s.id) lastSession = null;
  await refreshSessions(); msg('Practice deleted'); track('session_delete');
};
refreshSessions();

// ---------------------------------------------------------------- free play controls
const snap = () => { track('snapshot', { view }); return hydra?.on ? (hydraSnap = true) : cur.snapshot(); };
const toggleMode = async () => {
  if (view !== 'paint') await setView('paint');   // the glitch synth layers over the PAINT view only
  try { if (!hydra) { const { HydraLayer } = await import('./visuals/hydra.js'); hydra = new HydraLayer($('c'), state, flashFn); } }
  catch (e) { msg('Glitch synth unavailable: ' + e.message); return; }
  $('mode').setAttribute('aria-pressed', hydra.toggle());
};
function toggleDock(show = $('hud').classList.contains('hidden')) {   // touch screens have no H key: a faint pill brings it back
  $('hud').classList.toggle('hidden', !show); $('showdock').hidden = show;
  if (!show) { $('more').hidden = true; $('morebtn').setAttribute('aria-expanded', 'false'); }
}
const toggleLab = () => $('labbtn').classList.toggle('done', lab.toggle());
async function toggleCamera() {
  $('cambtn').disabled = true;
  try {
    const on = await inputs.toggle('camera');
    $('cambtn').setAttribute('aria-pressed', on);
    msg(on ? 'Camera on: your movement now stirs the water and the air in the sound. Nothing is recorded or sent.' : 'Camera off');
    track('camera', { on });
  } catch (e) { msg('Camera unavailable: ' + e.message); track('camera', { on: false, fail: true }); }
  finally { $('cambtn').disabled = false; }
}
$('snap').onclick = snap;
$('mode').onclick = toggleMode;
$('clear').onclick = () => cur.clear();
$('views').onclick = e => { const v = e.target.closest('button')?.dataset.view; if (v) setView(v); };
$('hide').onclick = () => toggleDock(false);
$('showdock').onclick = () => toggleDock(true);
$('morebtn').onclick = () => { const open = $('more').hidden; $('more').hidden = !open; $('morebtn').setAttribute('aria-expanded', open); };
$('simbtns').onclick = e => e.target.dataset.m && body.sim?.setMode(e.target.dataset.m);
$('labbtn').onclick = toggleLab;
$('cambtn').onclick = toggleCamera;
$('calib').onclick = () => act('calibrate');
$('dconnect').onclick = () => (body.label === 'MUSE 2' ? body.useSim() : connectMuse());
// the dock's one button: whatever gets you back on track, or into a guided practice
const dockStep = ready => (replay ? ['Playing back', null] : ready === 'live' ? ['Live', ['Guided practice', () => act('again')]]
  : ready === 'uncalibrated' ? ['Measure your baseline to wake the ink', ['Measure baseline', () => act('calibrate')]]
  : ready === 'contact' ? [`Adjust the band · ${state.quality.filter(contactOk).length}/4 sensors reading`, null]
  : [body.source ? 'Waiting for the headset signal…' : 'No headset connected', body.source ? null : ['Connect Muse', connectMuse]]);
let againFn = null;
$('again').onclick = () => againFn?.();

addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('select')) return;
  const k = e.key.toLowerCase();
  if (k === 'm') return toggleMute();
  if (k === 'escape') {
    if (guide.on) return finishPractice(true, null);
    if (calWas === 'running') return act('cancelcal');
    if (!$('more').hidden) return $('morebtn').click();
    if (replay) return stopReplay('Playback stopped');
    return;
  }
  if (journey.guided) return;   // shortcuts belong to free play; the journey is driven by its buttons
  const keys = { h: () => toggleDock(), s: snap, g: toggleMode, v: nextView, p: toggleReplay, j: togglePlay, b: () => setBreath(!state.breath.on), n: toggleMusic, k: toggleCamera, l: toggleLab, c: () => act('calibrate') };
  keys[k]?.();
});

// immersive: live + no pointer/key for 6s → the dock sinks and fades until you move
let lastInput = performance.now();
for (const ev of ['pointermove', 'pointerdown', 'keydown', 'touchstart']) addEventListener(ev, () => { lastInput = performance.now(); }, { passive: true });

// ---------------------------------------------------------------- PLAY, BREATHE, GROOVE
// PLAY: turn your head to stir the water (or scrub a playback), blink to drop ink, clench to ripple.
// Head orientation integrates the gyro (deg/s) with a slow leak back to centre; a 60° turn ≈ full range.
const PLAY_HINT = {
  live: 'PLAY · turn your head to stir the water · blink to drop ink · clench your jaw to send a ripple',
  replay: 'PLAY · turn your head to scrub (left rewinds, right speeds up) · nod to pause',
};
const DEAD = 3, LEAK_S = 6, FULL_DEG = 60;
let lastNod = 0, replayPaused = false;
function updateHead(dt) {
  const h = state.head, g = body.gyro, dz = v => (Math.abs(v) < DEAD ? 0 : v);
  h.x = Math.max(-1, Math.min(1, h.x * Math.exp(-dt / LEAK_S) + (dz(g.z) * dt) / FULL_DEG));   // yaw: assumed gyro z (check on hardware)
  h.y = Math.max(-1, Math.min(1, h.y * Math.exp(-dt / LEAK_S) + (dz(g.x) * dt) / FULL_DEG));   // pitch: assumed gyro x
  if (state.play && replay && Math.abs(g.x) > 90 && performance.now() - lastNod > 1200) {     // a quick nod pauses playback
    lastNod = performance.now(); replayPaused = !replayPaused; msg(replayPaused ? 'Paused: nod to resume' : 'Playing');
  }
}
/** playback speed: 1× normally; in PLAY, head turn sets −4×…+4× (centre band = 1×), nod pauses */
function replayRate() {
  if (!state.play) return 1;
  if (replayPaused) return 0;
  const x = state.head.x;
  return Math.abs(x) < 0.15 ? 1 : Math.sign(x) * (1 + 3 * (Math.abs(x) - 0.15) / 0.85);
}
function togglePlay() {
  state.play = !state.play; replayPaused = false;
  $('playbtn').setAttribute('aria-pressed', state.play);
  $('playhint').hidden = !state.play; $('playhint').textContent = replay ? PLAY_HINT.replay : PLAY_HINT.live;
  track('mode', { mode: 'play', on: state.play });
}
$('playbtn').onclick = togglePlay;

// BREATHE: the machine breathes at 5.5 breaths/min; when your heart rhythm follows it, harmony blooms
const BREATH_HZ = 5.5 / 60;
let breath0 = 0, syncAt = 0;
const breathUI = { word: '', sync: '', harm: false };
function updateBreath(t, dt) {
  const b = state.breath;
  if (b.on) {
    b.phase = (((t - breath0) / 1000) * BREATH_HZ) % 1;
    b.level = b.phase < 0.5 ? (1 - Math.cos((Math.PI * b.phase) / 0.5)) / 2 : (1 + Math.cos((Math.PI * (b.phase - 0.5)) / 0.5)) / 2;
    if (t - syncAt > 1000) { syncAt = t; state.sync = state.bpm ? breathSync.update(t / 1000) : 0; }
  }
  const target = b.on && state.ready === 'live' && state.bpm && state.sync > 0.45 ? 1 : 0;
  state.harmony += (target - state.harmony) * (1 - Math.exp(-dt / (target > state.harmony ? 8 : 4)));
  if (b.on && !journey.guided) {   // dock readout, DOM only when something visible changes
    const word = b.phase < 0.5 ? 'breathe in' : 'breathe out', hv = state.harmony > 0.5, sv = state.sync.toFixed(2);
    if (word !== breathUI.word) $('breathword').textContent = breathUI.word = word;
    if (sv !== breathUI.sync) { $('m-sync').style.width = pct(state.sync); $('v-sync').textContent = breathUI.sync = sv; }
    if (hv !== breathUI.harm) { $('breathui').classList.toggle('harmony', (breathUI.harm = hv)); if (hv) track('harmony', { secs: Math.round((t - breath0) / 1000) }); }
  }
}
function setBreath(on, quiet = false) {
  const b = state.breath;
  if (b.on === on) return;
  b.on = on; breath0 = performance.now(); breathSync.reset(); state.sync = 0;
  if (!on) { b.level = 0; b.phase = 0; }
  $('breathbtn').setAttribute('aria-pressed', on); $('breathui').hidden = !on;
  if (!quiet) { track('mode', { mode: 'breathe', on }); if (on) msg('Breathe with the machine: in as the arms reach in, out as they draw back. Sync builds after about 30s of steady pulse.'); }
}
$('breathbtn').onclick = () => setBreath(!state.breath.on);

// Music: CHORD (binaural band chord) or GROOVE (heart-locked tech house from your bands)
state.music = store.get('hbi.music') === 'groove' ? 'groove' : 'chord';
const showMusic = () => $('musicbtn').setAttribute('aria-pressed', state.music === 'groove');
function toggleMusic() {
  state.music = state.music === 'groove' ? 'chord' : 'groove';
  store.set('hbi.music', state.music); synth.setMusic(state.music); showMusic();
  track('mode', { mode: 'music', v: state.music });
  msg(state.music === 'groove' ? 'Groove: your heart sets the tempo, each band plays a part (needs a pulse lock)' : 'Chord: one tone per band');
}
$('musicbtn').onclick = toggleMusic;
showMusic();

// ---------------------------------------------------------------- DSP tick @20Hz
// all signal math lives in src/dsp; here the result is copied into state and the page is updated.
// During playback the recorded state stream replaces the live one (the headset keeps streaming underneath).
const QCLASS = { good: 'q-good', noisy: 'q-noisy', 'no contact': 'q-bad', railed: 'q-bad', off: 'q-off' };
const dots = CH.map(n => document.querySelectorAll(`[data-s="${n}"]`));   // both sensor maps (fit card + dock)
const diag = { since: 0, ticks: 0, rejected: 0 };
body.on('swap', () => Object.assign(diag, { since: performance.now(), ticks: 0, rejected: 0, blink: 0, clench: 0, beat: 0 }));
setInterval(() => {
  const now = performance.now();
  const r = (sig = pipe.tick(now));
  inputs.read(now);
  let events;
  if (replay) {
    events = replay.step(state, repEvents, replayRate());
    beatBase = state.beatPhase; beatAt = now;
    if (replay.done) stopReplay('Playback finished: P to play again');
    else put('replayfill', 'width', pct(replay.progress));
  } else {
    events = r.events;
    const ready = (state.ready = readiness(r, now)), streaming = ready !== 'idle';
    if (ready === 'live') trackOnce('live:' + body.label, 'live', { source: body.label, secs: Math.round(now / 1000) });
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
    Object.assign(state.gyro, body.gyro); state.tilt.x = body.tilt.x; state.tilt.y = body.tilt.y;
    if (state.breath.on) for (const ibi of r.ibis) breathSync.push(ibi, now / 1000, state.breath.phase);
    lab.update(r);
    diag.ticks++; if (r.artifact.rejected) diag.rejected++;
    for (const e of events) diag[e] = (diag[e] || 0) + 1;
    const contactN = state.quality.filter(contactOk).length;
    journey.tick({ streaming, contactN, now });
    if (journey.stage === 'fit') screens.fit(contactN, streaming, body.onSim);
  }

  const ready = state.ready, live = ready === 'live';
  for (let i = 0; i < 4; i++) { const c = state.held[i] ? 'q-held' : QCLASS[state.quality[i].label] || 'q-off'; if (ui.get('dot' + i) !== c) { ui.set('dot' + i, c); for (const d of dots[i]) d.setAttribute('class', c); } }
  put('bpm', 'textContent', state.bpm ? `♥ ${Math.round(state.bpm)}` : state.beatConf > 0.05 ? '♥ …' : '♥ --');
  put('bpm', 'title', replay ? 'recorded heartbeat' : r.heartSource ? `heart lock ${Math.round(r.beatConf * 20) * 5}% via ${r.heartSource} PPG` : 'looking for a pulse');
  if (!journey.guided) {   // the dock exists only in free play
    for (const k of ['relax', 'focus']) { const v = live ? state[k] : 0; put('m-' + k, 'width', pct(v)); put('v-' + k, 'textContent', v.toFixed(2)); }
    for (const k of BAND_NAMES) put('kb-' + k, 'width', pct(live ? state.bands[k] : 0));
    const [text, btn] = dockStep(ready);
    put('step', 'textContent', text); if ($('step').dataset.ready !== ready) $('step').dataset.ready = ready;
    againFn = btn?.[1] || null; put('again', 'hidden', !btn); if (btn) put('again', 'textContent', btn[0]);
    const quiet = live && now - lastInput > 6000 && $('more').hidden;
    if (quiet !== ui.get('quiet')) { ui.set('quiet', quiet); document.body.classList.toggle('quiet', quiet); }
  }

  for (const e of events) {
    if (!live) continue;   // before sync nothing reacts — not even to real beats
    if (e === 'beat') { const k = Math.min(1, state.beatConf * 1.2); cur.onBeat(k); synth.beat(k); $('bpm').classList.remove('beat'); void $('bpm').offsetWidth; $('bpm').classList.add('beat'); }
    else if (e === 'blink' || e === 'clench') {   // blink/clench → disturbance + glitch + noise; in PLAY they're instruments (drop / ripple)
      cur.onBlink(e);
      if (state.play) (e === 'blink' ? synth.drop() : synth.ripple()); else synth.blink();
    }
  }
  if (!replay) { updateCalibration(r.calibration); runPractice(now, r, events); }
}, 50);

// stream health @1Hz
setInterval(() => {
  if (!sig) return;
  const r = body.rate;
  if (!journey.guided) $('rates').textContent = `EEG ${r.eeg}Hz · PPG ${r.ppg}Hz · IMU ${r.imu}/s${sig.artifact.rejected && state.ready !== 'idle' ? ' · artifact hold' : ''}`;
  r.eeg = r.ppg = r.imu = 0;
}, 1000);

// hardware-test readout: run hbiDiag() in DevTools and paste the JSON (signal stats only, no device IDs)
const r1 = v => Math.round(v * 100) / 100;
window.hbiDiag = () => {
  if (!sig) return null;
  const out = {
    source: body.label, stage: journey.stage, ready: state.ready, secondsSinceSwap: Math.round((performance.now() - diag.since) / 1000),
    events: { blink: diag.blink || 0, clench: diag.clench || 0, beat: diag.beat || 0 },
    rejectedPct: diag.ticks ? Math.round((100 * diag.rejected) / diag.ticks) : 0,
    quality: Object.fromEntries(CH.map((n, i) => [n, { label: sig.quality[i].label, std: r1(sig.quality[i].std), score: r1(sig.quality[i].score) }])),
    relax: r1(sig.relax), focus: r1(sig.focus), relaxDb: r1(sig.relaxDb), focusDb: r1(sig.focusDb),
    bandDb: Object.fromEntries(BAND_NAMES.map(k => [k, r1(sig.dB[k])])),
    bands: Object.fromEntries(BAND_NAMES.map(k => [k, r1(sig.bands[k])])),
    bpm: Math.round(sig.bpm), heartLock: r1(sig.beatConf), heartSource: sig.heartSource,
    modes: { play: state.play, breath: state.breath.on, music: state.music, camera: state.camera.on }, sync: r1(state.sync), harmony: r1(state.harmony),
    head: { x: r1(state.head.x), y: r1(state.head.y) },
    calibration: sig.calibration.state, calibrationResult: sig.calibration.result, artifactNow: { ...sig.artifact }, held: [...sig.held],
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
};

// ---------------------------------------------------------------- start: the welcome card over a still, dark pool
screens.show('welcome');
await setView('ink', false);

let prev = performance.now();
(function loop(t) {
  const dt = Math.min(0.1, (t - prev) / 1000); prev = t;
  if (state.bpm) state.beatPhase = (beatBase + ((t - beatAt) / 1000) * (state.bpm / 60)) % 1;
  updateHead(dt); updateBreath(t, dt);
  cur.frame(state, dt);
  if (hydra && view === 'paint' && state.ready === 'live') { hydra.tick(dt); if (hydraSnap) { hydraSnap = false; hydra.snapshot(); } }
  synth.update(state);
  requestAnimationFrame(loop);
})(prev);
