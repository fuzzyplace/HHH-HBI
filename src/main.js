import { BandAnalyzer, Normalizer, BAND_NAMES } from './dsp/bands.js';
import { HeartRate } from './dsp/ppg.js';
import { SimulatedSource } from './input/simulated.js';
import { Scene } from './visuals/scene.js';
import { Synth } from './audio/synth.js';

const $ = id => document.getElementById(id);
const scene = new Scene($('c'));
const synth = new Synth();
const analyzer = new BandAnalyzer(4);
const norm = new Normalizer();
const chNorm = Array.from({ length: 4 }, () => new Normalizer());
const COLORS = { delta: '#8a4dff', theta: '#ff2bd6', alpha: '#00fff0', beta: '#ffb000', gamma: '#ffffff' };

const state = {
  bands: Object.fromEntries(BAND_NAMES.map(k => [k, 0])),
  ch: Array.from({ length: 4 }, () => Object.fromEntries(BAND_NAMES.map(k => [k, 0]))),
  asym: 0, bpm: 0, tilt: { x: 0, y: 0 }, gyro: { x: 0, y: 0, z: 0 }, battery: null,
};
const hr = new HeartRate(() => { scene.onBeat(); synth.beat(); });
let lastBlink = 0;

// HUD bars
$('bars').innerHTML = BAND_NAMES.map(k => `<div class="bar"><span>${k}</span><i id="b-${k}" style="color:${COLORS[k]};background:${COLORS[k]};width:0"></i></div>`).join('');
const msg = t => ($('msg').textContent = t);

let source = null;
function attach(src, label) {
  source?.stop();
  source = src;
  src.on('eeg', ({ ch, samples }) => analyzer.push(ch, samples));
  src.on('ppg', ({ ch, samples }) => ch === 0 && hr.push(samples));
  src.on('accel', a => { state.tilt.x += (Math.max(-1, Math.min(1, a.x)) - state.tilt.x) * 0.1; state.tilt.y += (Math.max(-1, Math.min(1, a.y)) - state.tilt.y) * 0.1; });
  src.on('gyro', g => { state.gyro.x = g.x; state.gyro.y = g.y; state.gyro.z = g.z; });
  src.on('battery', p => { state.battery = p; $('batt').textContent = `🔋 ${Math.round(p)}%`; });
  src.on('disconnect', () => { msg('Muse disconnected — back to SIM'); useSim(); });
  src.start();
  $('status').textContent = label;
}
function useSim() { attach(window.sim = new SimulatedSource(), 'SIM'); }
useSim();

$('connect').onclick = async () => {
  try {
    const { MuseSource } = await import('./input/muse.js');
    const m = new MuseSource(); await m.start(); attach(m, 'MUSE 2'); msg('Muse 2 connected');
  } catch (e) { msg('Connect failed: ' + e.message); }
};
$('audio').onclick = async () => { await synth.start(); $('audio').textContent = 'Audio ON'; };
$('snap').onclick = () => scene.snapshot();
$('clear').onclick = () => scene.clear();
$('hide').onclick = () => $('hud').classList.toggle('hidden');
$('simbtns').onclick = e => e.target.dataset.m && window.sim?.setMode?.(e.target.dataset.m);
addEventListener('keydown', e => { if (e.key === 'h') $('hud').classList.toggle('hidden'); if (e.key === 's') scene.snapshot(); });

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
  if (now - lastBlink > 800 && Math.max(analyzer.p2p(1), analyzer.p2p(2)) > 120) { lastBlink = now; scene.onBlink(); synth.blink(); }
}, 100);

let prev = performance.now();
(function loop(t) {
  const dt = Math.min(0.1, (t - prev) / 1000); prev = t;
  scene.frame(state, dt);
  synth.update(state);
  requestAnimationFrame(loop);
})(prev);
