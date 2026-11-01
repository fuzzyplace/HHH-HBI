// Extra inputs beside the headset (camera now; microphone, MIDI etc. later). Each one turns its sensor into a few
// normalized numbers on `state[id]`; visuals and audio only ever read those numbers.
//
// An input module default-exports a class with:
//   static id, static label
//   async start()     ask permission / open the device — throw with a readable message on failure
//   stop()            release the device
//   read(out, now)    fill `out` (= state[id]) with normalized values; called at the DSP rate (20Hz)
// and declares its resting values in `static rest` (what state[id] reads while off).
//
// To add an input: write src/input/<name>.js to that contract, register it in main.js, map it in the views/synth
// (guard on `state[id].on`), and add its row to the mapping table in docs/PLAN.md.

export class FeatureInputs {
  #defs = new Map(); #live = new Map();
  constructor(state) { this.state = state; }
  /** load: () => Promise<module with default class> — lazy, so an unused input costs nothing */
  register(id, load, rest) { this.#defs.set(id, load); this.state[id] = { on: false, ...rest }; this.rest = { ...this.rest, [id]: rest }; }
  isOn(id) { return this.#live.has(id); }
  async enable(id) {
    if (this.#live.has(id)) return true;
    const Cls = (await this.#defs.get(id)()).default, inp = new Cls();
    await inp.start();
    this.#live.set(id, inp); this.state[id].on = true;
    return true;
  }
  disable(id) {
    const inp = this.#live.get(id);
    if (!inp) return;
    inp.stop(); this.#live.delete(id);
    Object.assign(this.state[id], this.rest[id], { on: false });
  }
  async toggle(id) { if (this.isOn(id)) { this.disable(id); return false; } return this.enable(id); }
  read(now) { for (const [id, inp] of this.#live) inp.read(this.state[id], now); }
}
