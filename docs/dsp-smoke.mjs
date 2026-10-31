// node docs/dsp-smoke.mjs — sanity check DSP against simulated source
import { SignalPipeline } from '../src/dsp/pipeline.js';
import { SimulatedSource } from '../src/input/simulated.js';
const s = new SimulatedSource(), p = new SignalPipeline();
s.on('eeg', ({ ch, samples }) => p.push(ch, samples));
s.on('ppg', ({ ch, samples }) => p.pushPpg(ch, samples));   // 0 ambient, 1 infrared, 2 red
s.setMode('focus');
let beats = 0, r, ms = 0;
for (let i = 0; i < 600; i++) {                // ~60s sim time in 100ms ticks
  for (let j = 0; j < 4; j++) { s.last = performance.now() - 25; s.tick(); }
  ms += 100; r = p.tick(ms); beats += r.events.filter(e => e === 'beat').length;
}
console.log('focus band dB', Object.fromEntries(Object.entries(r.dB).map(([k, v]) => [k, +v.toFixed(1)])));
console.log('relax', r.relax.toFixed(2), 'focus', r.focus.toFixed(2));
console.log('bpm', r.bpm.toFixed(1), 'conf', r.beatConf.toFixed(2), 'via', r.heartSource, 'beats', beats);
