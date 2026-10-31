# HHH-HBI — Human Brain Interface

A real-time cyberpunk audio-visual meditation instrument driven by a Muse 2 EEG headband. Part of Hackers Healing Hackers (H.H.H.). It is an art/meditation tool, not a medical device.

Stack: Vite, vanilla JS, Canvas2D, WebAudio, [muse-js](https://github.com/urish/muse-js) over Web Bluetooth.

## Run

```bash
npm install
npm run dev      # dev server
npm run build    # production build
```

The app runs with zero hardware: a simulated Muse source (EEG, PPG, motion, blinks) is the default.

## Muse 2 connection

Web Bluetooth only works in **Chrome or Edge**, on `localhost` or HTTPS. See `docs/HARDWARE.md` for the hardware test guide.

## Deploy (Vercel)

Static build — Vercel auto-detects Vite; `vercel.json` pins `npm run build` → `dist/`. Vercel's HTTPS satisfies Web Bluetooth's secure-context requirement, so the deployed site can connect a Muse in Chrome/Edge.

## Docs

- `docs/PLAN.md` — roadmap and signal→visual/audio mapping table
- `CLAUDE.md` and `.claude/agents/` — project rules and subagent definitions
