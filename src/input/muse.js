import { MuseClient } from 'muse-js';
import { Emitter } from './emitter.js';

// muse-js electrode order: 0=TP9 1=AF7 2=AF8 3=TP10 4=AUX
export class MuseSource extends Emitter {
  constructor() { super(); this.client = null; this.subs = []; this.last = [0, 0, 0, 0]; }
  /** dropped packets arrive as NaN — hold last good value */
  clean(ch, samples) {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) { const v = samples[i]; out[i] = Number.isFinite(v) ? (this.last[ch] = v) : this.last[ch]; }
    return out;
  }
  async start() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth unavailable — use Chrome/Edge');
    const c = (this.client = new MuseClient());
    c.enablePpg = true;
    await c.connect();
    await c.start();
    this.subs.push(
      c.eegReadings.subscribe(r => { if (r.electrode < 4) this.emit('eeg', { ch: r.electrode, samples: this.clean(r.electrode, r.samples) }); }),
      c.ppgReadings.subscribe(r => this.emit('ppg', { ch: r.ppgChannel, samples: Float32Array.from(r.samples) })),
      c.accelerometerData.subscribe(a => { const s = a.samples[a.samples.length - 1]; this.emit('accel', s); }),
      c.gyroscopeData.subscribe(g => { const s = g.samples[g.samples.length - 1]; this.emit('gyro', s); }),
      c.telemetryData.subscribe(t => this.emit('battery', t.batteryLevel)),
      c.connectionStatus.subscribe(s => { if (!s && !this.stopping) this.emit('disconnect', null); }),
    );
  }
  stop() { this.stopping = true; this.subs.forEach(s => s.unsubscribe()); this.client?.disconnect(); }
}
