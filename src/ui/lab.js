// Signal Lab: a plain view of what the pipeline is measuring, for checking the headband against reality.
// Reads only the pipeline result (sig); draws at the DSP rate (10Hz), never in the render loop.
import { BANDS } from '../dsp/bands.js';

const HIST = 600;   // 30s at 20Hz (DSP tick rate)
const BAND_COLORS = { delta: '#8a4dff', theta: '#ff2bd6', alpha: '#00fff0', beta: '#ffb000', gamma: '#ffffff' };
const QC = { good: '#00ff9c', noisy: '#ffb000', 'no contact': '#ff3355', railed: '#ff3355' };
const CH = ['TP9', 'AF7', 'AF8', 'TP10'];

export class Lab {
  constructor(el) {
    this.el = el; this.c = el.querySelector('canvas'); this.g = this.c.getContext('2d');
    this.relax = new Float32Array(HIST); this.focus = new Float32Array(HIST); this.mark = new Uint8Array(HIST);
    this.i = 0; this.n = 0;
    const d = Math.min(devicePixelRatio || 1, 2);
    this.W = 440; this.H = 360; this.c.width = this.W * d; this.c.height = this.H * d;
    this.c.style.width = this.W + 'px'; this.c.style.height = this.H + 'px';
    this.g.scale(d, d);
  }
  get open() { return !this.el.hidden; }
  toggle() { this.el.hidden = !this.el.hidden; return this.open; }

  /** record every tick (so history is there when opened); draw only when visible */
  update(sig) {
    const i = this.i;
    this.relax[i] = sig.relax; this.focus[i] = sig.focus;
    this.mark[i] = sig.events.includes('blink') ? 1 : sig.events.includes('clench') ? 2 : sig.artifact.rejected ? 3 : 0;
    this.i = (i + 1) % HIST; this.n = Math.min(HIST, this.n + 1);
    if (this.open) this.draw(sig);
  }

  draw(sig) {
    const g = this.g, W = this.W;
    g.clearRect(0, 0, W, this.H);
    g.font = '11px ui-monospace, Menlo, monospace'; g.textBaseline = 'top';

    // spectrum 1–45Hz, averaged over channels in use
    const x0 = 34, y0 = 22, w = W - x0 - 10, h = 130, psd = sig.psd;
    let lo = Infinity, hi = -Infinity;
    for (let k = 1; k < psd.length; k++) { if (psd[k] < lo) lo = psd[k]; if (psd[k] > hi) hi = psd[k]; }
    if (!Number.isFinite(lo) || hi - lo < 1) { lo = -20; hi = 20; }
    lo = Math.floor(lo / 5) * 5; hi = Math.ceil(hi / 5) * 5;
    const X = f => x0 + ((f - 1) / 44) * w, Y = v => y0 + h - ((v - lo) / (hi - lo)) * h;
    for (const [k, [a, b]] of Object.entries(BANDS)) {
      g.fillStyle = BAND_COLORS[k] + (k === 'alpha' ? '26' : '12');
      g.fillRect(X(a), y0, X(b) - X(a), h);
      g.fillStyle = BAND_COLORS[k]; g.fillText(k, X(a) + 2, y0 + h + 3);
    }
    g.strokeStyle = '#ffffff22'; g.strokeRect(x0, y0, w, h);
    g.fillStyle = '#9aa'; g.fillText(`${hi}dB`, 0, y0 - 4); g.fillText(`${lo}`, 4, y0 + h - 8);
    g.fillText('spectrum (1–45Hz, µV²/Hz in dB)', x0, 4);
    for (const f of [10, 20, 30, 40]) g.fillText(`${f}`, X(f) - 6, y0 + h + 15);
    g.strokeStyle = '#ffffff'; g.lineWidth = 1.5; g.beginPath();
    for (let k = 1; k < psd.length; k++) { const x = X(k), y = Y(psd[k]); k === 1 ? g.moveTo(x, y) : g.lineTo(x, y); }
    g.stroke();

    // 30s history of the two indices
    const hy = y0 + h + 40, hh = 90;
    g.strokeStyle = '#ffffff22'; g.strokeRect(x0, hy, w, hh);
    g.fillStyle = '#9aa'; g.fillText('last 30s', x0, hy - 13); g.fillText('1', 22, hy - 4); g.fillText('0', 22, hy + hh - 8);
    for (let j = 0; j < this.n; j++) {
      const idx = (this.i - this.n + j + HIST) % HIST, m = this.mark[idx];
      if (!m) continue;
      g.fillStyle = m === 1 ? '#00fff066' : m === 2 ? '#ff2bd666' : '#ff335522';
      g.fillRect(x0 + (j / HIST) * w, hy, Math.max(1, w / HIST), hh);
    }
    for (const [arr, col] of [[this.relax, '#00fff0'], [this.focus, '#ffb000']]) {
      g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath();
      for (let j = 0; j < this.n; j++) {
        const v = arr[(this.i - this.n + j + HIST) % HIST], x = x0 + ((HIST - this.n + j) / HIST) * w, y = hy + hh - v * hh;
        j === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    }

    // readouts
    const ty = hy + hh + 8;
    g.fillStyle = '#00fff0'; g.fillText(`RELAX ${sig.relax.toFixed(2)}  (${sig.relaxDb.toFixed(1)} dB α vs β+γ)`, x0, ty);
    g.fillStyle = '#ffb000'; g.fillText(`FOCUS ${sig.focus.toFixed(2)}  (${sig.focusDb.toFixed(1)} dB β vs θ)`, x0, ty + 14);
    let x = x0;
    for (let c = 0; c < 4; c++) {
      const q = sig.quality[c];
      g.fillStyle = QC[q.label] || '#fff'; g.fillText(`● ${CH[c]}${sig.held[c] ? '⏸' : ''}`, x, ty + 30); x += 62;
    }
    g.fillStyle = '#9aa';
    const cr = sig.calibration.result;
    g.fillText(cr ? `calibration: eyes-closed alpha ${cr.alphaGainDb >= 0 ? '+' : ''}${cr.alphaGainDb.toFixed(1)} dB (${cr.verdict})` : 'calibration: none yet (press C)', x0, ty + 46);
  }
}
