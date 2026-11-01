// The journey's page side: one card per stage, the practice caption and the reflection. No signal logic —
// main.js decides, this only shows. Buttons carry data-act="…" and are routed to the onAct callback.

const $ = id => document.getElementById(id);
const pct = v => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;

const PRACTICE = {
  arrive: ['Arrive', 'Eyes open, soft gaze. Notice the ink: every stream of it comes from you.', ''],
  breathe: ['Breathe', 'Breathe with the cue: about five seconds in, five seconds out. Easy, never forced.', 'Close your eyes in…'],
  rest: ['Rest', 'Eyes closed. Let the sound hold you. Rising tones will bring you back.', 'Coming back… open your eyes at the chime'],
  return: ['Return', 'Open your eyes slowly. See what your stillness made.', ''],
};
const CAL = {
  open: ['Eyes open', 'Look softly at one point on the screen. Stay still, jaw relaxed.'],
  closed: ['Eyes closed', 'Close your eyes and relax. Two rising tones mean done: open your eyes then.'],
};

export class Screens {
  #last = {};
  constructor(onAct) {
    document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && !b.disabled) onAct(b.dataset.act, b); });
    this.onLength = null;
    $('lengths').onclick = e => { const m = +e.target.closest('button')?.dataset.min; if (m) { this.length(m); this.onLength?.(m); } };
  }
  /** show the card (or caption) for this stage; the dock belongs to 'explore' */
  show(stage) {
    for (const c of document.querySelectorAll('#journey .card')) c.hidden = c.dataset.stage !== stage;
    const card = document.querySelector(`#journey .card[data-stage="${stage}"]`);
    $('journey').hidden = !card;
    $('practice').hidden = stage !== 'practice';
    $('dockwrap').hidden = stage !== 'explore';
    document.body.dataset.stage = stage;
    const h = card?.querySelector('h1,h2');   // screen readers land on the new step's heading
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  }
  length(min) { for (const b of $('lengths').children) { const on = +b.dataset.min === min; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); } $('r-go').textContent = `Begin the ${min}-minute practice`; }
  skipAvailable(on) { $('skip').hidden = !on; }

  connecting(on, hasBluetooth) {
    $('connect').disabled = on || !hasBluetooth;
    $('connect').textContent = on ? 'Looking for your Muse…' : 'Connect';
    if (!hasBluetooth) this.connectError("This browser can't reach Bluetooth headbands. Open this page in Chrome or Edge on a computer or an Android phone, or try the simulator.");
  }
  connectError(text) { $('conn-err').hidden = !text; $('conn-err').textContent = text || ''; }

  fit(contactN, streaming, sim) {
    const t = !streaming ? 'Waiting for the headset signal…' : contactN >= 3 ? 'Good contact. Hold still…' : `${contactN} of 4 sensors reading`;
    if (t !== this.#last.fit) $('fit-n').textContent = this.#last.fit = t;
    $('fit-n').classList.toggle('ok', streaming && contactN >= 3);
    $('fit-eye').textContent = sim ? 'Simulated headband · Settle in' : 'Step 2 of 3 · Settle in';
  }

  baselineIntro(canReuse) { $('b-intro').hidden = false; $('b-run').hidden = true; $('b-back').hidden = false; $('reuse').hidden = !canReuse; }
  baselineRun(c) {
    $('b-intro').hidden = true; $('b-run').hidden = false; $('b-back').hidden = true;
    if (c.phase !== this.#last.cal) { this.#last.cal = c.phase; [$('calstep').textContent, $('caltxt').textContent] = CAL[c.phase] || CAL.open; }
    $('calfill').style.width = pct(c.phaseProgress);
    $('calleft').textContent = `about ${Math.ceil(c.phaseLeft)}s left`;
  }

  /** note: null, or a line about signal strength from the calibration verdict */
  ready(note) { $('r-note').hidden = !note; $('r-note').textContent = note || ''; }

  /** g: the practice guide's step output; extra: { word, sync (0..1 | null), hint } */
  practice(g, total, extra) {
    const [name, txt, countTxt] = PRACTICE[g.phase];
    const text = g.count != null && countTxt ? countTxt : txt;
    if (name !== this.#last.pn) { this.#last.pn = name; $('p-name').textContent = name; $('p-step').textContent = `${g.phaseIndex + 1} of 4`; }
    if (text !== this.#last.pt) $('p-txt').textContent = this.#last.pt = text;
    $('p-count').textContent = g.count ?? '';
    $('practice').classList.toggle('closed', g.phase === 'rest' && g.count == null);
    $('practice').classList.toggle('count', g.count != null);
    const breathing = g.phase === 'breathe' && g.count == null;
    $('p-breath').hidden = !breathing;
    if (breathing) {
      if (extra.word !== this.#last.word) $('p-word').textContent = this.#last.word = extra.word;
      const s = extra.sync == null ? '' : extra.sync > 0.45 ? 'your heart is following the breath' : '';
      if (s !== this.#last.sync) { $('p-sync').textContent = this.#last.sync = s; $('p-breath').classList.toggle('harmony', !!s); }
    }
    if ((extra.hint || '') !== this.#last.hint) $('p-hint').textContent = this.#last.hint = extra.hint || '';
    $('p-fill').style.width = pct(total);
  }

  /** summary: recorder per-phase means; syncPeak 0..1 */
  reflect(sm, syncPeak, canWatch) {
    const a = sm?.arrive, r = sm?.rest, rows = [];
    if (a?.sec && r?.sec) {
      if (a.bpm && r.bpm) rows.push(['Heart rate', `${Math.round(a.bpm)} → ${Math.round(r.bpm)} bpm`, 'arriving → resting']);
      rows.push(['Calm', `${pct(a.relax)} → ${pct(r.relax)}`, 'arriving → resting, against your baseline']);
      const da = r.alphaDb - a.alphaDb;
      rows.push(['Alpha rhythm', `${da >= 0 ? '+' : ''}${da.toFixed(1)} dB`, 'eyes closed vs open']);
    }
    if (syncPeak > 0.05) rows.push(['Heart and breath', `${pct(syncPeak)} in step`, 'at their closest while breathing']);
    $('stats').innerHTML = rows.length
      ? rows.map(([k, v, d]) => `<div><dt>${k}</dt><dd>${v}<small>${d}</small></dd></div>`).join('')
      : '<div><dt>Signal</dt><dd>Not enough clean signal to compare this time<small>a snug fit and a little stillness help</small></dd></div>';
    $('watch').hidden = !canWatch;
  }
}
