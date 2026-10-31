import { BAND_NAMES } from './dsp/bands.js';
import { SignalPipeline } from './dsp/pipeline.js';
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
const synth = new Synth();
const pipe = new SignalPipeline();
const CAL_KEY = 'hbi.calibration.v1';   // local-only baseline (band stats + timestamp, no device IDs)
try { const j = JSON.parse(localStorage.getItem(CAL_KEY) || 'null'); if (j && !pipe.importCalibration(j)) localStorage.removeItem(CAL_KEY); } catch {}
let sig = null;   // latest pipeline result
let calWas = pipe.calibrated ? 'done' : 'none';   // calibration UI state: none | running | done
const rate = { eeg: 0, ppg: 0, imu: 0 };   // samples/sec counters for stream health
const CH = ['TP9', 'AF7', 'AF8', 'TP10'];
const COLORS = { delta: '#8a4dff', theta: '#ff2bd6', alpha: '#00fff0', beta: '#ffb000', gamma: '#ffffff' };

const state = {
  bands: Object.fromEntries(BAND_NAMES.map(k => [k, 0])),
  ch: Array.from({ length: 4 }, () => Object.fromEntries(BAND_NAMES.map(k => [k, 0]))),
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
  src.on('ppg', live(({ ch, samples }) => { if (ch === 0) { pipe.pushPpg(samples); rate.ppg += samples.length; } }));
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
const snap = () => (hydra?.on ? (hydraSnap = true) : scene.snapshot());
$('snap').onclick = snap;
const toggleMode = async () => {
  try {
    if (!hydra) { const { HydraLayer } = await import('./visuals/hydra.js'); hydra = new HydraLayer($('c'), state, flashFn); }
  } catch (e) { msg('Glitch-synth unavailable: ' + e.message); return; }
  $('mode').textContent = hydra.toggle() ? 'Mode: GLITCH-SYNTH' : 'Mode: PARTICLES';
};
$('mode').onclick = toggleMode;
$('clear').onclick = () => scene.clear();
$('hide').onclick = () => $('hud').classList.toggle('hidden');
$('simbtns').onclick = e => e.target.dataset.m && window.sim?.setMode?.(e.target.dataset.m);
addEventListener('keydown', e => { if (e.metaKey || e.ctrlKey || e.altKey) return; if (e.key === 'h') $('hud').classList.toggle('hidden'); if (e.key === 's') snap(); if (e.key === 'g') toggleMode(); });

// DSP @10Hz — all signal math lives in src/dsp; main only consumes the result
setInterval(() => {
  const r = (sig = pipe.tick(performance.now()));
  for (const k of BAND_NAMES) { state.bands[k] = r.bands[k]; for (let i = 0; i < 4; i++) state.ch[i][k] = r.ch[i][k]; }
  state.asym = r.asym; state.bpm = r.bpm;
  $('bpm').textContent = `♥ ${r.bpm ? Math.round(r.bpm) : '--'}`;
  for (const k of BAND_NAMES) $('b-' + k).style.width = `${Math.round(state.bands[k] * 200)}px`;
  for (const e of r.events) {
    if (e === 'beat') { scene.onBeat(); synth.beat(); }
    else if (e === 'blink' || e === 'clench') { scene.onBlink(); synth.blink(); }   // mapping: blink/clench → flash + glitch, noise burst
  }
  updateCalibration(r.calibration);
}, 100);

// Calibration: 30s eyes-closed rest baseline; only artifact-free windows count
function showCalibrated() { $('calib').classList.toggle('done', pipe.calibrated); $('calib').textContent = pipe.calibrated ? 'Recalibrate (C)' : 'Calibrate (C)'; }
function updateCalibration(c) {
  if (c.state === 'running') $('calfill').style.width = `${Math.round(c.progress * 100)}%`;
  if (c.state === calWas) return;
  if (calWas === 'running' && c.state === 'done') {
    try { localStorage.setItem(CAL_KEY, JSON.stringify(pipe.exportCalibration())); } catch {}
    msg('Baseline saved — visuals now track your own range');
  }
  $('calov').hidden = c.state !== 'running';
  calWas = c.state; showCalibrated();
}
function startCalibration() {
  if (calWas === 'running') return;
  $('calfill').style.width = '0%'; pipe.startCalibration(30);
  if (source === window.sim) msg('Calibrating on SIM — connect the Muse for a real baseline');
}
// settle UI state here so the next tick doesn't read a cancelled run as "finished"
function settleCalibration(text) {
  calWas = pipe.calibrated ? 'done' : 'none';
  $('calov').hidden = true; showCalibrated();
  msg(text + (pipe.calibrated ? ' — keeping previous baseline' : ''));
}
function cancelCalibration() {
  if (calWas !== 'running') return;
  pipe.cancelCalibration();
  settleCalibration('Calibration cancelled');
}
$('calib').onclick = startCalibration;
$('calcancel').onclick = cancelCalibration;
addEventListener('keydown', e => { if (e.metaKey || e.ctrlKey || e.altKey) return; if (e.key === 'c') startCalibration(); if (e.key === 'Escape') cancelCalibration(); });
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

let prev = performance.now();
(function loop(t) {
  const dt = Math.min(0.1, (t - prev) / 1000); prev = t;
  scene.frame(state, dt);
  if (hydra) { hydra.tick(dt); if (hydraSnap) { hydraSnap = false; hydra.snapshot(); } }
  synth.update(state);
  requestAnimationFrame(loop);
})(prev);
