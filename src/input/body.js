// The body source: one headset (Muse 2) or the simulator at a time, feeding the signal pipeline.
// main.js asks for a source (useSim / connectMuse / off) and listens here; nothing else touches the devices.
//
// Events: 'swap' (label) — a new source is live · 'message' (text) · 'battery' (pct) · 'status' (label)
//         'lost' (reason) — the headset dropped for good (the app decides what happens next)
import { Emitter } from './emitter.js';
import { SimulatedSource } from './simulated.js';

const coarse = m => (/unavailable/i.test(m) ? 'no_web_bluetooth' : /off/i.test(m) ? 'bt_off' : /No device/.test(m) ? 'cancelled'
  : /blocked/i.test(m) ? 'blocked' : /cancel/i.test(m) ? 'aborted' : 'other');

export class Body extends Emitter {
  source = null; label = 'OFF'; connecting = false;
  lastEeg = 0;                                   // ms of the last EEG packet (streaming check)
  rate = { eeg: 0, ppg: 0, imu: 0 };             // samples since the last health readout
  gyro = { x: 0, y: 0, z: 0 }; tilt = { x: 0, y: 0 };   // always the live headset, even during playback

  constructor(pipe) { super(); this.pipe = pipe; }
  get onSim() { return !!this.source && this.source instanceof SimulatedSource; }
  get sim() { return this.onSim ? this.source : null; }
  get hasBluetooth() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }
  streaming(now) { return !!this.lastEeg && now - this.lastEeg < 1500; }

  useSim() { const s = new SimulatedSource(); this.#wire(s); this.#swap(s, 'SIM'); s.start(); }
  off() { this.#swap(null, 'OFF'); }

  /** opens the browser's Bluetooth picker; resolves true once the headset streams. On failure the current source stays. */
  async connectMuse() {
    if (this.connecting) return false;
    this.connecting = true;
    try {
      const { MuseSource } = await import('./muse.js');
      const m = new MuseSource(); this.#wire(m);
      await m.start();
      this.#swap(m, 'MUSE 2');
      return true;
    } catch (e) { e.reason = coarse(e.message || ''); throw e; }
    finally { this.connecting = false; }
  }

  // handlers ignore events from any source that isn't the live one (e.g. a Muse still connecting while SIM runs)
  #wire(src) {
    const live = fn => d => { if (this.source === src) fn(d); };
    const p = this.pipe, r = this.rate;
    src.on('eeg', live(({ ch, samples }) => { p.push(ch, samples); if (ch === 0) { r.eeg += samples.length; this.lastEeg = performance.now(); } }));
    src.on('ppg', live(({ ch, samples }) => { p.pushPpg(ch, samples); if (ch === 1) r.ppg += samples.length; }));   // 0 is ambient light, the pulse is on 1/2
    src.on('accel', live(a => {
      r.imu++; p.pushMotion('accel', a);
      this.tilt.x += (Math.max(-1, Math.min(1, a.x)) - this.tilt.x) * 0.1; this.tilt.y += (Math.max(-1, Math.min(1, a.y)) - this.tilt.y) * 0.1;
    }));
    src.on('gyro', live(g => { this.gyro.x = g.x; this.gyro.y = g.y; this.gyro.z = g.z; p.pushMotion('gyro', g); }));
    src.on('battery', live(pct => this.emit('battery', pct)));
    src.on('reconnecting', live(({ attempt, max }) => { this.emit('message', `Muse signal lost — reconnecting (${attempt}/${max})`); this.emit('status', 'MUSE 2 · RECONNECTING'); }));
    src.on('reconnected', live(() => { this.emit('message', 'Muse 2 reconnected'); this.emit('status', 'MUSE 2'); }));
    src.on('error', live(({ message }) => this.emit('message', 'Muse: ' + message)));
    src.on('disconnect', live(() => { this.off(); this.emit('lost', 'disconnected'); }));
  }
  #swap(src, label) {
    const prev = this.source;
    this.source = src; prev?.stop();
    this.pipe.reset();   // re-learn adaptive ranges per source; calibration is kept
    this.lastEeg = 0; this.label = label;
    this.gyro.x = this.gyro.y = this.gyro.z = 0; this.tilt.x = this.tilt.y = 0;
    this.emit('swap', label);
  }
}
