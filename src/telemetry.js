// Anonymous product telemetry (Vercel Web Analytics + Speed Insights). Cookieless, production builds only.
// Privacy rule: NO signal data ever leaves the browser — no EEG/PPG values, bands, heart rate, session contents,
// device names or IDs. Events carry only coarse product facts (which view, which mode, did calibration work).
// Honors Global Privacy Control / Do Not Track, and a manual opt-out: localStorage 'hbi.notrack' = '1'.
import { inject, track as vaTrack } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';

let optOut = false;
try { optOut = navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || localStorage.getItem('hbi.notrack') === '1'; } catch {}
const on = import.meta.env.PROD && !optOut;

// misuse/cost guard: per page load, each event name at most MAX_PER times and MAX_TOTAL overall
const MAX_PER = 20, MAX_TOTAL = 150, counts = new Map();
let total = 0;
const clean = v => (typeof v === 'string' ? v.slice(0, 80) : typeof v === 'number' ? Math.round(v * 100) / 100 : typeof v === 'boolean' ? v : null);

export function track(name, props) {
  if (!on || total >= MAX_TOTAL) return;
  const n = (counts.get(name) || 0) + 1;
  if (n > MAX_PER) return;
  counts.set(name, n); total++;
  const p = {};
  if (props) for (const k in props) { const v = clean(props[k]); if (v !== null) p[k] = v; }
  try { vaTrack(name, p); } catch {}
}

const once = new Set();
export const trackOnce = (key, name, props) => { if (!once.has(key)) { once.add(key); track(name, props); } };

// coarse error class only: message is trimmed and stripped of URLs/numbers (no stack, no user data)
const scrub = m => String(m || 'unknown').replace(/https?:\/\/\S+/g, '<url>').replace(/\d{3,}/g, '#').slice(0, 80);

export function initTelemetry() {
  if (!on) return;
  inject({
    mode: 'production',
    beforeSend: e => ({ ...e, url: e.url.split('?')[0].split('#')[0] }),   // drop query strings (debug flags) from pageviews
  });
  injectSpeedInsights();
  addEventListener('error', e => track('client_error', { kind: 'error', msg: scrub(e.message) }));
  addEventListener('unhandledrejection', e => track('client_error', { kind: 'promise', msg: scrub(e.reason?.message || e.reason) }));
  // what hardware/browser people actually bring (decides what to optimise and support)
  const gl2 = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
  track('capability', {
    webgl2: gl2, webgpu: 'gpu' in navigator, bluetooth: 'bluetooth' in navigator,
    mobile: matchMedia('(pointer: coarse)').matches, lang: (navigator.language || '').slice(0, 5),
  });
}
