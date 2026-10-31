// node docs/dsp-smoke.mjs — sanity check DSP against simulated source
import { BandAnalyzer } from '../src/dsp/bands.js';
import { HeartRate } from '../src/dsp/ppg.js';
import { SimulatedSource } from '../src/input/simulated.js';
const s = new SimulatedSource(), a = new BandAnalyzer(4); let beats = 0;
const hr = new HeartRate(() => beats++);
s.on('eeg', ({ ch, samples }) => a.push(ch, samples)); s.on('ppg', ({ ch, samples }) => ch === 0 && hr.push(samples));
s.setMode('focus');
let t = 0; const realNow = performance.now.bind(performance);
for (let i = 0; i < 1500; i++) { s.last = realNow() - 40; s.tick(); }  // ~60s sim time
const { avg } = a.compute();
console.log('focus rel power', Object.fromEntries(Object.entries(avg).map(([k, v]) => [k, +v.toFixed(2)])));
console.log('bpm', hr.bpm.toFixed(1), 'beats', beats);
