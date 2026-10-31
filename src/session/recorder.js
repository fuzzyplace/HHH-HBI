// Session recording + replay. Records the derived `state` stream (never raw samples, never device IDs)
// at the DSP rate (20Hz) as packed Float32 frames, plus beat/blink events and phase changes.
// Sessions live only in this browser (IndexedDB 'hbi' → 'sessions', newest 8 kept); Export is a user click.

const BANDS = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
const LABELS = ['off', 'good', 'noisy', 'no contact', 'railed'];
const READY = ['idle', 'contact', 'uncalibrated', 'live'];
export const PHASES = ['open', 'closed', 'open2'];
// frame layout (floats)
const O = { bands: 0, ch: 5, qs: 25, ql: 29, held: 33, motion: 37, relax: 38, focus: 39, bpm: 40, conf: 41, phase: 42, tilt: 43, gyro: 45, alphaDb: 48, ready: 49, sess: 50 };
export const FW = 51;
export const FPS = 20;
const KEEP = 8;

export class Recorder {
  constructor() { this.on = false; }
  start(meta = {}) {
    this.on = true; this.n = 0; this.cap = FPS * 60 * 4; this.frames = new Float32Array(this.cap * FW);
    this.events = []; this.marks = []; this.phase = -1; this.t0 = Date.now(); this.meta = meta;
  }
  /** one DSP tick: state + events emitted this tick + extras (alphaDb, session phase index) */
  push(st, events, alphaDb, phase) {
    if (!this.on) return;
    if (this.n >= this.cap) { const f = new Float32Array(this.cap * 2 * FW); f.set(this.frames); this.frames = f; this.cap *= 2; }
    const f = this.frames, o = this.n * FW;
    BANDS.forEach((b, k) => { f[o + O.bands + k] = st.bands[b]; for (let i = 0; i < 4; i++) f[o + O.ch + i * 5 + k] = st.ch[i][b]; });
    for (let i = 0; i < 4; i++) {
      f[o + O.qs + i] = st.quality[i].score; f[o + O.ql + i] = Math.max(0, LABELS.indexOf(st.quality[i].label)); f[o + O.held + i] = st.held[i] ? 1 : 0;
    }
    f[o + O.motion] = st.motion ? 1 : 0; f[o + O.relax] = st.relax; f[o + O.focus] = st.focus;
    f[o + O.bpm] = st.bpm; f[o + O.conf] = st.beatConf; f[o + O.phase] = st.beatPhase;
    f[o + O.tilt] = st.tilt.x; f[o + O.tilt + 1] = st.tilt.y;
    f[o + O.gyro] = st.gyro.x; f[o + O.gyro + 1] = st.gyro.y; f[o + O.gyro + 2] = st.gyro.z;
    f[o + O.alphaDb] = alphaDb; f[o + O.ready] = READY.indexOf(st.ready); f[o + O.sess] = phase;
    if (phase !== this.phase) { this.marks.push({ i: this.n, phase: PHASES[phase] }); this.phase = phase; }
    for (const e of events) if (e === 'beat' || e === 'blink' || e === 'clench') this.events.push([this.n, e]);
    this.n++;
  }
  stop() {
    if (!this.on) return null;
    this.on = false;
    const s = {
      id: `s${this.t0}`, t: this.t0, n: this.n, fps: FPS, fw: FW, frames: this.frames.slice(0, this.n * FW),
      events: this.events, marks: this.marks, ...this.meta,
    };
    s.summary = summarize(s);
    this.frames = null;
    return s;
  }
}

/** per-phase means: relax, focus, alpha dB, band levels, heart rate */
export function summarize(s) {
  const out = {};
  for (const ph of PHASES) out[ph] = { sec: 0, relax: 0, focus: 0, alphaDb: 0, bpm: 0, bpmN: 0, bands: Object.fromEntries(BANDS.map(b => [b, 0])) };
  const f = s.frames;
  for (let i = 0; i < s.n; i++) {
    const o = i * s.fw, ph = out[PHASES[f[o + O.sess]]];
    if (!ph || f[o + O.ready] !== 3) continue;   // only live seconds count
    ph.sec++; ph.relax += f[o + O.relax]; ph.focus += f[o + O.focus]; ph.alphaDb += f[o + O.alphaDb];
    if (f[o + O.bpm] > 0) { ph.bpm += f[o + O.bpm]; ph.bpmN++; }
    BANDS.forEach((b, k) => (ph.bands[b] += f[o + O.bands + k]));
  }
  for (const ph of Object.values(out)) {
    const n = ph.sec || 1;
    ph.relax /= n; ph.focus /= n; ph.alphaDb /= n; ph.bpm = ph.bpmN ? ph.bpm / ph.bpmN : 0; delete ph.bpmN;
    for (const b of BANDS) ph.bands[b] /= n;
    ph.sec /= s.fps;
  }
  return out;
}

/** plays a session back into the shared state object, one frame per DSP tick */
export class Replayer {
  constructor(s) { this.s = s; this.i = 0; this.ev = 0; this.done = false; }
  get progress() { return this.s.n ? this.i / this.s.n : 1; }
  /** fill st from the next frame; returns events for that frame */
  step(st, out) {
    out.length = 0;
    const s = this.s;
    if (this.i >= s.n) { this.done = true; return out; }
    const f = s.frames, o = this.i * s.fw;
    BANDS.forEach((b, k) => { st.bands[b] = f[o + O.bands + k]; for (let i = 0; i < 4; i++) st.ch[i][b] = f[o + O.ch + i * 5 + k]; });
    for (let i = 0; i < 4; i++) {
      st.quality[i].score = f[o + O.qs + i]; st.quality[i].label = LABELS[f[o + O.ql + i]] || 'off'; st.held[i] = f[o + O.held + i] > 0;
    }
    st.motion = f[o + O.motion] > 0; st.relax = f[o + O.relax]; st.focus = f[o + O.focus];
    st.bpm = f[o + O.bpm]; st.beatConf = f[o + O.conf]; st.beatPhase = f[o + O.phase];
    st.tilt.x = f[o + O.tilt]; st.tilt.y = f[o + O.tilt + 1];
    st.gyro.x = f[o + O.gyro]; st.gyro.y = f[o + O.gyro + 1]; st.gyro.z = f[o + O.gyro + 2];
    st.ready = READY[f[o + O.ready]] || 'idle';
    this.phase = PHASES[f[o + O.sess]];
    while (this.ev < s.events.length && s.events[this.ev][0] <= this.i) out.push(s.events[this.ev++][1]);
    this.i++;
    return out;
  }
  reset() { this.i = 0; this.ev = 0; this.done = false; }
}

// ---- storage (IndexedDB; failures degrade to in-memory for this tab) ----
const mem = [];
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('hbi', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('sessions', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const tx = (d, mode, fn) => new Promise((res, rej) => {
  const t = d.transaction('sessions', mode), st = t.objectStore('sessions'), out = fn(st);
  t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error);
});
export async function saveSession(s) {
  mem.unshift(s); mem.splice(KEEP);
  try {
    const d = await db();
    await tx(d, 'readwrite', st => st.put(s));
    const all = await listSessions();
    if (all.length > KEEP) await tx(d, 'readwrite', st => { for (const x of all.slice(KEEP)) st.delete(x.id); });
  } catch (e) { console.warn('session storage unavailable — kept for this tab only', e); }
}
export async function listSessions() {
  try {
    const d = await db();
    const all = await tx(d, 'readonly', st => st.getAll());
    return all.sort((a, b) => b.t - a.t);
  } catch { return mem.slice(); }
}
export function exportSession(s) {
  const j = { ...s, frames: Array.from(s.frames, v => Math.round(v * 1000) / 1000), layout: O, labels: LABELS, phases: PHASES };
  const a = document.createElement('a');
  a.download = `hbi-session-${new Date(s.t).toISOString().replace(/[:.]/g, '-')}.json`;
  a.href = URL.createObjectURL(new Blob([JSON.stringify(j)], { type: 'application/json' }));
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
