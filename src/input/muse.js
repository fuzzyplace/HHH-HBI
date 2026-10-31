import { MuseClient } from 'muse-js';
import { Emitter } from './emitter.js';

// muse-js electrode order: 0=TP9 1=AF7 2=AF8 3=TP10 4=AUX
export class MuseSource extends Emitter {
  constructor() { super(); this.client = null; this.subs = []; }
  async start() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth unavailable — use Chrome/Edge');
    const c = (this.client = new MuseClient());
    c.enablePpg = true;
    await c.connect();
    await c.start();
    this.subs.push(
      c.eegReadings.subscribe(r => { if (r.electrode < 4) this.emit('eeg', { ch: r.electrode, samples: Float32Array.from(r.samples) }); }),
      c.ppgReadings.subscribe(r => this.emit('ppg', { ch: r.ppgChannel, samples: Float32Array.from(r.samples) })),
      c.accelerometerData.subscribe(a => { const s = a.samples[a.samples.length - 1]; this.emit('accel', s); }),
      c.gyroscopeData.subscribe(g => { const s = g.samples[g.samples.length - 1]; this.emit('gyro', s); }),
      c.telemetryData.subscribe(t => this.emit('battery', t.batteryLevel)),
      c.connectionStatus.subscribe(s => { if (!s) this.emit('disconnect', null); }),
    );
  }
  stop() { this.subs.forEach(s => s.unsubscribe()); this.client?.disconnect(); }
}
