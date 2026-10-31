/** Hacker data-rain: glyphs drawn from live EEG microvolt values. Rendered to a canvas used as a GPU texture. */
const LABELS = ['TP9', 'AF7', 'AF8', 'TP10', 'µV', 'α', 'β', 'θ', 'δ', 'γ', '0x', 'HBI'];
export class DataRain {
  constructor(w = 1024, h = 576, fs = 15) {
    this.canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    this.g = this.canvas.getContext('2d');
    this.fs = fs; this.cw = Math.ceil(fs * 0.62);
    this.cols = Math.floor(w / this.cw);
    this.y = Array.from({ length: this.cols }, () => Math.random() * h);
    this.feed = () => (Math.random() * 255 | 0).toString(16);
    this.acc = 0;
  }
  /** returns true when texture changed */
  update(dt, intensity = 0.5) {
    this.acc += dt; if (this.acc < 1 / 20) return false; this.acc = 0;
    const { g, canvas: { width: W, height: H }, fs, cw } = this;
    g.fillStyle = 'rgba(0,0,0,0.14)'; g.fillRect(0, 0, W, H);
    g.font = `${fs}px ui-monospace,Menlo,monospace`; g.textBaseline = 'top';
    for (let c = 0; c < this.cols; c++) {
      if (Math.random() > 0.25 + intensity * 0.6) continue;
      const s = Math.random() < 0.03 ? LABELS[(Math.random() * LABELS.length) | 0] : this.feed().slice(-1).toUpperCase();
      g.fillStyle = Math.random() < 0.1 ? '#eaffff' : Math.random() < 0.15 ? '#ff2bd6' : '#00ff9c';
      g.fillText(s, c * cw, this.y[c]);
      this.y[c] += fs;
      if (this.y[c] > H && Math.random() > 0.9) this.y[c] = -fs * (Math.random() * 10 | 0);
    }
    return true;
  }
  clear() { this.g.clearRect(0, 0, this.canvas.width, this.canvas.height); }
}
