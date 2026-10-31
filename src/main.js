import { BandAnalyzer, Normalizer, BAND_NAMES } from './dsp/bands.js';
import { HeartRate } from './dsp/ppg.js';
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
const analyzer = new BandAnalyzer(4);
let norm = new Normalizer();
let chNorm = Array.from({ length: 4 }, () => new Normalizer());
const rate = { eeg: 0, ppg: 0, imu: 0 };   // samples/sec counters for stream health
const CH = ['TP9', 'AF7', 'AF8', 'TP10'];
const COLORS = { delta: '#8a4dff', theta: '#ff2bd6', alpha: '#00fff0', beta: '#ffb000', gamma: '#ffffff' };

const state = {
  bands: Object.fromEntries(BAND_NAMES.map(k => [k, 0])),
  ch: Array.from({ length: 4 }, () => Object.fromEntries(BAND_NAMES.map(k => [k, 0]))),
  asym: 0, bpm: 0, tilt: { x: 0, y: 0 }, gyro: { x: 0, y: 0, z: 0 }, battery: null,
};
const hr = new HeartRate(() => { scene.onBeat(); synth.beat(); });
let lastBlink = 0, p2pBase = 60;

// HUD bars
$('bars').innerHTML = BAND_NAMES.map(k => `<div class="bar"><span>${k}</span><i id="b-${k}" style="color:${COLORS[k]};background:${COLORS[k]};width:0"></i></div>`).join('');
const msg = t => ($('msg').textContent = t);

let source = null;
const setStatus = label => ($('status').textContent = label + (scene?.webgpu ? ' · WebGPU' : scene?.renderer ? ' · WebGL2' : ''));
// handlers ignore events from any source that isn't the live one (e.g. a Muse still connecting while SIM runs)
function wire(src) {
  const live = fn => d => { if (source === src) fn(d); };
  src.on('eeg', live(({ ch, samples }) => { analyzer.push(ch, samples); if (ch === 0) rate.eeg += samples.length; }));
  src.on('ppg', live(({ ch, samples }) => { if (ch === 0) { hr.push(samples); rate.ppg += samples.length; } }));
  src.on('accel', live(a => { rate.imu++; state.tilt.x += (Math.max(-1, Math.min(1, a.x)) - state.tilt.x) * 0.1; state.tilt.y += (Math.max(-1, Math.min(1, a.y)) - state.tilt.y) * 0.1; }));
  src.on('gyro', live(g => { state.gyro.x = g.x; state.gyro.y = g.y; state.gyro.z = g.z; }));
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
  norm = new Normalizer(); chNorm = Array.from({ length: 4 }, () => new Normalizer());   // re-learn ranges per source
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
addEventListener('keydown', e => { if (e.key === 'h') $('hud').classList.toggle('hidden'); if (e.key === 's') snap(); if (e.key === 'g') toggleMode(); });

// DSP @10Hz
setInterval(() => {
  const { channels, avg } = analyzer.compute();
  const n = norm.apply(avg);
  for (const k of BAND_NAMES) state.bands[k] += (n[k] - state.bands[k]) * 0.3;
  channels.forEach((c, i) => { const v = chNorm[i].apply(c); for (const k of BAND_NAMES) state.ch[i][k] += (v[k] - state.ch[i][k]) * 0.3; });
  const L = (channels[0].alpha + channels[1].alpha) / 2, R = (channels[2].alpha + channels[3].alpha) / 2;
  state.asym += ((R - L) / Math.max(1e-6, R + L) - state.asym) * 0.2;
  state.bpm = hr.bpm;
  $('bpm').textContent = `♥ ${hr.bpm ? Math.round(hr.bpm) : '--'}`;
  for (const k of BAND_NAMES) $('b-' + k).style.width = `${Math.round(state.bands[k] * 200)}px`;
  // blink / clench: frontal channel spike
  const now = performance.now();
  // adaptive: spike must be 1.6x the running frontal p2p baseline
  const p2p = Math.max(analyzer.p2pSince(1), analyzer.p2pSince(2));
  if (now - lastBlink > 800 && p2p > Math.max(150, p2pBase * 1.6)) { lastBlink = now; scene.onBlink(); synth.blink(); }
  p2pBase += (Math.min(p2p, p2pBase * 2) - p2pBase) * 0.02;
}, 100);

// Signal quality + stream health @1Hz. Contact via per-channel std (µV): ~3–60 good, >60 noisy, <1.5 flat/no contact.
setInterval(() => {
  $('sq').innerHTML = CH.map((n, i) => {
    const s = analyzer.std(i);
    const [c, t] = !Number.isFinite(s) || s < 1.5 ? ['#ff3355', 'no contact'] : s > 60 ? ['#ffb000', 'noisy'] : ['#00ff9c', 'good'];
    return `<span title="${n}: ${t} (σ ${s.toFixed(1)}µV)" style="color:${c}">● ${n}</span>`;
  }).join(' ') + `<br><span class="dim">EEG ${rate.eeg}Hz · PPG ${rate.ppg}Hz · IMU ${rate.imu}/s</span>`;
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
