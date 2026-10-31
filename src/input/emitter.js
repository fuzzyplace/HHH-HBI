export class Emitter {
  #h = {};
  on(evt, fn) { (this.#h[evt] ||= []).push(fn); return this; }
  emit(evt, data) { for (const fn of this.#h[evt] || []) fn(data); }
}
