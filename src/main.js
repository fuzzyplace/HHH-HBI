import { BAND_NAMES } from './dsp/bands.js';
import { SignalPipeline } from './dsp/pipeline.js';
import { Lab } from './ui/lab.js';
import { SimulatedSource } from './input/simulated.js';
import { GpuScene } from './visuals/gpu.js';
import { Scene } from './visuals/scene.js';
import { Synth } from './audio/synth.js';

const $ = id => document.getElementById(id);
let scene, hydra = null, hydraSnap = false;
try { scene = await GpuScene.create($('c')); }
catch (e) { console.warn('GPU scene failed, 2D fallback', e); scene = new Scene($('c')); }
window.hbi = scene;
const flashFn = () => scene.flash || 0;

// Views: PAINT (feedback particles on #c), SPRAY and ORBS (calm 3D, own canvases, created on first use)
const VIEWS = ['spray', 'orbs', 'paint'];
const VIEW_CANVAS = { paint: 'c', spray: 'cspray', orbs: 'corbs' };
const views = { paint: scene };
let view = 'paint', cur = scene;
async function setView(v) {
  if (!views[v]) {
    try {
      const mod = v === 'spray' ? await import('./visuals/spray.js') : await import('./visuals/orbs.js');
      views[v] = new (v === 'spray' ? mod.SprayView : mod.OrbsView)($(VIEW_CANVAS[v]));
    } catch (e) { console.warn(e); msg(`${v} view unavailable: ${e.message}`); return; }
  }
  if (v !== 'paint' && hydra?.on) { hydra.toggle(); $('mode').textContent = 'Glitch (G)'; }
  view = v; cur = views[v];
  for (const k of VIEWS) $(VIEW_CANVAS[k]).hidden = k !== v;
  cur.resize?.();
  $('view').textContent = `View: ${v.toUpperCase()} (V)`;
  try { localStorage.setItem('hbi.view', v); } catch {}
}
const nextView = () => setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]);
window.hbiViews = () => ({ view, cur, views, state });   // console/debug handle (no signal data beyond the state object)
const synth = new Synth();
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
    source: $('status').textContent, secondsSinceSwap: Math.round((performance.now() - diag.since) / 1000),
    events: { blink: diag.blink || 0, clench: diag.clench || 0, beat: diag.beat || 0 },
    rejectedPct: diag.ticks ? Math.round((100 * diag.rejected) / diag.ticks) : 0,
    quality: Object.fromEntries(CH.map((n, i) => [n, { label: sig.quality[i].label, std: r1(sig.quality[i].std), score: r1(sig.quality[i].score) }])),
    relax: r1(sig.relax), focus: r1(sig.focus), relaxDb: r1(sig.relaxDb), focusDb: r1(sig.focusDb),
    bandDb: Object.fromEntries(BAND_NAMES.map(k => [k, r1(sig.dB[k])])),
    bands: Object.fromEntries(BAND_NAMES.map(k => [k, r1(sig.bands[k])])),
    bpm: Math.round(sig.bpm), calibration: sig.calibration.state, calibrationResult: sig.calibration.result, artifactNow: { ...sig.artifact }, held: [...sig.held],
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
};
let calWas = pipe.calibrated ? 'done' : 'none';   // calibration UI state: none | running | done
const rate = { eeg: 0, ppg: 0, imu: 0 };   // samples/sec counters for stream health
const CH = ['TP9', 'AF7', 'AF8', 'TP10'];
const COLORS = { delta: '#8a4dff', theta: '#ff2bd6', alpha: '#00fff0', beta: '#ffb000', gamma: '#ffffff' };

const state = {
  bands: Object.fromEntries(BAND_NAMES.map(k => [k, 0])),
  ch: Array.from({ length: 4 }, () => Object.fromEntries(BAND_NAMES.map(k => [k, 0]))),
  relax: 0.5, focus: 0.5,   // primary drivers (0..1): calm vs activation — see docs/SIGNALS.md
  beatPhase: 0, beatConf: 0, // heart clock: 0..1 through the current beat, lock confidence — the heartbeat paces every view
  asym: 0, bpm: 0, tilt: { x: 0, y: 0 }, gyro: { x: 0, y: 0, z: 0 }, battery: null,
};

// HUD bars
$('bars').innerHTML = BAND_NAMES.map(k => `<div class="bar"><span>${k}</span><i id="b-${k}" style="color:${COLORS[k]};background:${COLORS[k]};width:0"></i></div>`).join('');
const msg = t => ($('msg').textContent = t);

let source = null;
const setStatus = label => ($('status').textContent = label + (scene?.webgpu ? ' · WebGPU' : scene?.renderer ? ' · WebGL2' : ''));
// handlers ignore events from any source that isn't the live one (e.g. a Muse still connecting while SIM runs)
function wire(src) {
  const live = fn => d => { if (source === src) fn(d); };
  src.on('eeg', live(({ ch, samples }) => { pipe.push(ch, samples); if (ch === 0) rate.eeg += samples.length; }));
  src.on('ppg', live(({ ch, samples }) => { pipe.pushPpg(ch, samples); if (ch === 1) rate.ppg += samples.length; }));   // all 3 channels: 0 is ambient light, the pulse is on 1/2
  src.on('accel', live(a => { rate.imu++; pipe.pushMotion('accel', a); state.tilt.x += (Math.max(-1, Math.min(1, a.x)) - state.tilt.x) * 0.1; state.tilt.y += (Math.max(-1, Math.min(1, a.y)) - state.tilt.y) * 0.1; }));
  src.on('gyro', live(g => { pipe.pushMotion('gyro', g); state.gyro.x = g.x; state.gyro.y = g.y; state.gyro.z = g.z; }));
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
  state.battery = null; $('batt').textContent = '🔋 --';
  setStatus(label);
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
    await m.start();                      // SIM keeps painting until the headset is actually streaming
    window.sim = null; swapTo(m, 'MUSE 2'); msg(`${m.deviceName || 'Muse 2'} connected`);
  } catch (e) { msg('Connect failed: ' + e.message + ' — staying on SIM'); }
  finally { connecting = false; $('connect').disabled = false; }
};
$('audio').onclick = async () => { await synth.start(); $('audio').textContent = 'Audio ON'; };
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
addEventListener('keydown', e => { if (e.metaKey || e.ctrlKey || e.altKey) return; if (e.key === 'h') $('hud').classList.toggle('hidden'); if (e.key === 's') snap(); if (e.key === 'g') toggleMode(); if (e.key === 'v') nextView(); });

// DSP @20Hz (heart clock resolution ≈50ms) — all signal math lives in src/dsp; main only consumes the result
setInterval(() => {
  const r = (sig = pipe.tick(performance.now()));
  for (const k of BAND_NAMES) { state.bands[k] = r.bands[k]; for (let i = 0; i < 4; i++) state.ch[i][k] = r.ch[i][k]; }
  state.asym = r.asym; state.bpm = r.bpm; state.relax = r.relax; state.focus = r.focus;
  state.beatConf = r.beatConf; beatBase = r.beatPhase; beatAt = performance.now();
  meter('relax', r.relax); meter('focus', r.focus);
  lab.update(r);
  $('bpm').textContent = r.bpm ? `♥ ${Math.round(r.bpm)}` : r.beatConf > 0.05 ? '♥ …' : '♥ --';
  $('bpm').title = r.heartSource ? `heart lock ${Math.round(r.beatConf * 100)}% via ${r.heartSource} PPG` : 'looking for a pulse';
  for (const k of BAND_NAMES) $('b-' + k).style.width = `${Math.round(state.bands[k] * 200)}px`;
  diag.ticks++; if (r.artifact.rejected) diag.rejected++;
  for (const e of r.events) {
    diag[e] = (diag[e] || 0) + 1;
    if (e === 'beat') { const k = Math.min(1, r.beatConf * 1.2); cur.onBeat(k); synth.beat(k); $('bpm').classList.remove('beat'); void $('bpm').offsetWidth; $('bpm').classList.add('beat'); }
    else if (e === 'blink' || e === 'clench') { cur.onBlink(); synth.blink(); }   // mapping: blink/clench → flash + glitch, noise burst
  }
  updateCalibration(r.calibration);
}, 50);

// Calibration: step 1 eyes open, step 2 eyes closed (10s clean each); a tone marks each step when audio is on
const CAL_STEPS = {
  open: ['STEP 1 OF 2 · EYES OPEN', 'Look softly at one point on the screen. Stay still, jaw relaxed.'],
  closed: ['STEP 2 OF 2 · EYES CLOSED', 'Close your eyes and relax. Two rising tones mean done — open your eyes then.'],
};
let calPhase = null;
function showCalibrated() { $('calib').classList.toggle('done', pipe.calibrated); $('calib').textContent = pipe.calibrated ? 'Recalibrate (C)' : 'Calibrate (C)'; }
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
    synth.cue(2);
    const g = c.result.alphaGainDb, gs = `${g >= 0 ? '+' : ''}${g.toFixed(1)} dB`;
    msg(c.result.verdict === 'strong' ? `Calibrated — eyes-closed alpha ${gs}: clear signal. RELAX/FOCUS now use your range.`
      : c.result.verdict === 'weak' ? `Calibrated — eyes-closed alpha only ${gs}: weak. Wet the ear sensors and try again for a clearer range.`
      : `Eyes-closed alpha didn't rise (${gs}) — check ear-sensor contact, then recalibrate. Using defaults meanwhile.`);
  }
  $('calov').hidden = c.state !== 'running';
  if (c.state !== 'running') calPhase = null;
  calWas = c.state; showCalibrated();
}
function startCalibration() {
  if (calWas === 'running') return;
  $('calfill').style.width = '0%'; pipe.startCalibration({ open: 10, closed: 10 });
  if (source === window.sim) msg('Calibrating on SIM — connect the Muse for a real baseline');
}
// settle UI state here so the next tick doesn't read a cancelled run as "finished"
function settleCalibration(text) {
  calWas = pipe.calibrated ? 'done' : 'none'; calPhase = null;
  $('calov').hidden = true; showCalibrated();
  msg(text + (pipe.calibrated ? ' — keeping previous baseline' : ''));
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
const meter = (k, v) => { $('m-' + k).style.width = `${Math.round(v * 200)}px`; $('v-' + k).textContent = v.toFixed(2); };
$('calcancel').onclick = cancelCalibration;
addEventListener('keydown', e => { if (e.metaKey || e.ctrlKey || e.altKey) return; if (e.key === 'c') startCalibration(); if (e.key === 'l') toggleLab(); if (e.key === 'Escape') cancelCalibration(); });
showCalibrated();

// Signal quality + stream health @1Hz (scores computed in src/dsp)
const QC = { good: '#00ff9c', noisy: '#ffb000', 'no contact': '#ff3355', railed: '#ff3355' };
setInterval(() => {
  if (!sig) return;
  $('sq').innerHTML = CH.map((n, i) => {
    const q = sig.quality[i];
    return `<span title="${n}: ${q.label} (σ ${q.std.toFixed(1)}µV, score ${q.score.toFixed(2)})" style="color:${QC[q.label] || '#fff'}">● ${n}</span>`;
  }).join(' ') + `<br><span class="dim">EEG ${rate.eeg}Hz · PPG ${rate.ppg}Hz · IMU ${rate.imu}/s${sig.artifact.rejected ? ' · artifact hold' : ''}</span>`;
  rate.eeg = rate.ppg = rate.imu = 0;
}, 1000);

let savedView = 'spray';
try { savedView = localStorage.getItem('hbi.view') || 'spray'; } catch {}
await setView(VIEWS.includes(savedView) ? savedView : 'spray');

let prev = performance.now();
(function loop(t) {
  const dt = Math.min(0.1, (t - prev) / 1000); prev = t;
  if (state.bpm) state.beatPhase = (beatBase + ((t - beatAt) / 1000) * (state.bpm / 60)) % 1;
  cur.frame(state, dt);
  if (hydra && view === 'paint') { hydra.tick(dt); if (hydraSnap) { hydraSnap = false; hydra.snapshot(); } }
  synth.update(state);
  requestAnimationFrame(loop);
})(prev);
