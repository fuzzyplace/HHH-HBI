import { MuseClient } from 'muse-js';
import { Emitter } from './emitter.js';

// Muse 2 adapter: muse-js observables -> source-interface events (same as simulated.js).
// Electrode order: 0=TP9 1=AF7 2=AF8 3=TP10 (4=AUX is never enabled).
//
// Events:
//   eeg {ch, samples:Float32Array}   ppg {ch, samples:Float32Array}   accel {x,y,z}   gyro {x,y,z}
//   battery (pct)
//   reconnecting {attempt, max, delayMs}  — link dropped, retry #attempt scheduled in delayMs
//   reconnected {attempt}                  — streams restored (PPG re-enabled, client restarted)
//   disconnect (null)                      — gave up after max attempts; app falls back to SIM
//   error {message}                        — non-fatal stream problem
// stop() cancels any pending reconnect and suppresses all further events.

const MUSE_SERVICE = 0xfe8d;
const CONNECT_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 8000];

export class MuseSource extends Emitter {
  constructor() {
    super();
    this.client = null;
    this.device = null;
    this.subs = [];
    this.last = [0, 0, 0, 0];
    this._state = 'idle'; // idle | starting | running | reconnecting | stopped
    this._gen = 0;        // bumped by stop(); stale async work checks it and bails
    this._startPromise = null;
    this._retryTimer = null;
    this._onDrop = () => this._handleDrop();
  }

  /** Device name for UI display only (e.g. "Muse-1A2B"). Never log/persist device IDs. */
  get deviceName() { return this.device?.name || this.client?.deviceName || ''; }

  /** dropped packets arrive as NaN — hold last good value */
  clean(ch, samples) {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) { const v = samples[i]; out[i] = Number.isFinite(v) ? (this.last[ch] = v) : this.last[ch]; }
    return out;
  }

  /** Idempotent: repeated calls while starting/running return the same promise. */
  start() {
    if (this._startPromise) return this._startPromise;
    const gen = ++this._gen;
    this._state = 'starting';
    this._startPromise = this._start(gen).catch(e => {
      if (gen === this._gen) { this._teardown(true); this._state = 'idle'; this._startPromise = null; }
      throw e;
    });
    return this._startPromise;
  }

  stop() {
    this._gen++;
    this._state = 'stopped';
    clearTimeout(this._retryTimer); this._retryTimer = null;
    this._teardown(true);
    this._startPromise = null;
  }

  async _start(gen) {
    if (typeof navigator === 'undefined' || !navigator.bluetooth) {
      throw new Error('Web Bluetooth unavailable — use Chrome or Edge on localhost/https');
    }
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({ filters: [{ services: [MUSE_SERVICE] }] });
    } catch (e) {
      if (e?.name === 'NotFoundError') {
        if (/adapter/i.test(e.message || '')) throw new Error('Bluetooth is off or unavailable — turn Bluetooth on and retry');
        throw new Error('No device selected');
      }
      if (e?.name === 'SecurityError') throw new Error('Bluetooth blocked — click Connect directly, on localhost/https');
      throw new Error('Bluetooth request failed: ' + (e?.message || e));
    }
    if (gen !== this._gen) throw new Error('Muse connection cancelled');
    this.device = device;
    device.addEventListener('gattserverdisconnected', this._onDrop);
    await this._connect(gen);
    if (gen !== this._gen) throw new Error('Muse connection cancelled');
    this._state = 'running';
  }

  /** Connect GATT on the already-chosen device (no chooser), subscribe, enable PPG, start. */
  async _connect(gen) {
    const device = this.device;
    const client = (this.client = new MuseClient());
    client.enablePpg = true; // must be set before connect() so PPG characteristics are wired
    let dead = false, timer = null;
    const alive = () => { if (dead || gen !== this._gen) throw new Error('Muse connection cancelled'); };
    const work = (async () => {
      const server = await device.gatt.connect();
      alive();
      await client.connect(server); // muse-js: connect(gatt) skips requestDevice
      alive();
      this._subscribe(client, gen);
      await client.start(); // p50 preset (PPG on) + resume
      alive();
    })();
    work.catch(() => {}); // loser of the race must not surface as unhandled
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Muse connection timed out')), CONNECT_TIMEOUT_MS); });
    try {
      await Promise.race([work, timeout]);
    } catch (e) {
      dead = true;
      if (gen === this._gen) this._teardown(false);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  _subscribe(c, gen) {
    const err = (what) => (e) => { if (gen === this._gen) this.emit('error', { message: `${what} stream error: ${e?.message || e}` }); };
    const safe = (fn, what) => (v) => {
      if (gen !== this._gen) return;
      try { fn(v); } catch (e) { this.emit('error', { message: `${what} handler error: ${e?.message || e}` }); }
    };
    this.subs.push(
      c.eegReadings.subscribe({
        next: safe(r => { if (r.electrode < 4) this.emit('eeg', { ch: r.electrode, samples: this.clean(r.electrode, r.samples) }); }, 'EEG'),
        error: err('EEG'),
      }),
      c.ppgReadings.subscribe({
        next: safe(r => this.emit('ppg', { ch: r.ppgChannel, samples: Float32Array.from(r.samples) }), 'PPG'),
        error: err('PPG'),
      }),
      c.accelerometerData.subscribe({
        next: safe(a => { const n = a.samples.length; if (n) this.emit('accel', a.samples[n - 1]); }, 'Accel'),
        error: err('Accel'),
      }),
      c.gyroscopeData.subscribe({
        next: safe(g => { const n = g.samples.length; if (n) this.emit('gyro', g.samples[n - 1]); }, 'Gyro'),
        error: err('Gyro'),
      }),
      c.telemetryData.subscribe({
        next: safe(t => this.emit('battery', t.batteryLevel), 'Telemetry'),
        error: err('Telemetry'),
      }),
    );
  }

  _handleDrop() {
    if (this._state !== 'running') return; // ignore our own disconnects and drops mid-connect
    this._state = 'reconnecting';
    this._teardown(false);
    this._scheduleRetry(1);
  }

  _scheduleRetry(attempt) {
    const gen = this._gen;
    if (attempt > MAX_ATTEMPTS) { this._giveUp(); return; }
    const delayMs = BACKOFF_MS[attempt - 1];
    this.emit('reconnecting', { attempt, max: MAX_ATTEMPTS, delayMs });
    this._retryTimer = setTimeout(async () => {
      this._retryTimer = null;
      if (gen !== this._gen || !this.device) return;
      try {
        await this._connect(gen);
        if (gen !== this._gen) return;
        this._state = 'running';
        this.emit('reconnected', { attempt });
      } catch {
        if (gen !== this._gen) return;
        this._scheduleRetry(attempt + 1);
      }
    }, delayMs);
  }

  _giveUp() {
    this._state = 'idle';
    this._teardown(true);
    this._startPromise = null;
    this.emit('disconnect', null);
  }

  /** Unsubscribe streams and drop the GATT link. forget=true also releases the device. */
  _teardown(forget) {
    for (const s of this.subs) { try { s.unsubscribe(); } catch {} }
    this.subs.length = 0;
    try { this.client?.disconnect(); } catch {}
    this.client = null;
    const d = this.device;
    if (d) {
      if (forget) d.removeEventListener('gattserverdisconnected', this._onDrop);
      try { if (d.gatt?.connected) d.gatt.disconnect(); } catch {}
    }
    if (forget) this.device = null;
  }
}
