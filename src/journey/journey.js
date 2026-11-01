// The guided journey — one path from arriving at the page to free play:
//   welcome → connect (Muse only) → fit → baseline → ready → practice → reflect → explore
// Pure stage logic: it moves on by itself only where the body decides (the headset starts streaming; three sensors
// hold contact). Every other step is the person's choice, made through main.js calling go().

import { Emitter } from '../input/emitter.js';

export const STAGES = ['welcome', 'connect', 'fit', 'baseline', 'ready', 'practice', 'reflect', 'explore'];
export const FIT_HOLD_MS = 2000;   // contact must hold this long before the baseline step opens
export const LENGTHS = [3, 5, 10];   // practice minutes offered

export class Journey extends Emitter {
  stage = 'welcome'; prev = null; path = null; minutes = 5; fitSince = null;

  /** path: 'muse' | 'sim' */
  begin(path) { this.path = path; this.go(path === 'muse' ? 'connect' : 'fit'); }
  go(stage, info = {}) {
    if (!STAGES.includes(stage) || stage === this.stage) return;
    const from = this.stage;
    this.prev = from; this.stage = stage; this.fitSince = null;
    this.emit('stage', { stage, from, ...info });
  }
  /** each DSP tick: { streaming, contactN (sensors with usable contact), now } */
  tick({ streaming, contactN, now }) {
    if (this.stage === 'connect' && streaming) this.go('fit');
    else if (this.stage === 'fit') {
      if (streaming && contactN >= 3) { this.fitSince ??= now; if (now - this.fitSince >= FIT_HOLD_MS) this.go('baseline'); }
      else this.fitSince = null;
    }
  }
  get guided() { return this.stage !== 'explore'; }
  /** where Back leads from the baseline step: back to free play or the ready card if you came from there, else the start */
  get backFromBaseline() { return this.prev === 'explore' || this.prev === 'ready' ? this.prev : 'welcome'; }
}
