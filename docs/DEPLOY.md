# Deploy & observability (Vercel)

Static Vite build (`dist/`), no server. `vercel.json` sets the build, caching and security headers.

**Live:** https://hhh-hbi.vercel.app (team `stdclub`, project `hhh-hbi`, Hobby plan).
Deploy: `vercel deploy --prod` from the repo (linked via `.vercel/`, gitignored).

## Hosting
- `npm ci && npm run build`; output `dist/`. Hashed `/assets/*` cached 1 year (immutable); `index.html` always revalidates.
- HTTPS everywhere, which Web Bluetooth needs (secure context).

## Security headers (`vercel.json`)
| Header | Why |
|---|---|
| Content-Security-Policy | only same-origin code; `'unsafe-eval'` is required by Hydra (glitch mode compiles shaders from code); no framing |
| Permissions-Policy | Bluetooth for this origin only; camera/mic/location/USB/etc. off |
| X-Frame-Options DENY + `frame-ancestors 'none'` | no clickjacking of the Connect/Bluetooth prompt |
| HSTS, nosniff, Referrer-Policy, COOP | standard hardening |

## Analytics (privacy rule: no signal data leaves the browser)
`src/telemetry.js`, production only, cookieless:
- **Vercel Web Analytics**: page views, referrers, countries, devices, browsers (query strings stripped).
- **Vercel Speed Insights**: real-user Core Web Vitals (LCP, INP, CLS, TTFB).
- **Custom events**: coarse product facts only. **Need Vercel Pro**: on the current Hobby plan they are sent but not shown in the dashboard.

| Event | Props | Answers |
|---|---|---|
| capability | webgl2, webgpu, bluetooth, mobile, lang | what hardware people bring |
| audio_start | muted | did sound start |
| connect_attempt / connect_ok / connect_fail | reason (no_web_bluetooth, bt_off, cancelled, blocked, aborted, other) | Muse connect funnel |
| calibrated | verdict, source | does calibration work |
| live | source, secs (time from load) | time-to-live, SIM vs MUSE 2 |
| view | v | which views are used |
| mode | mode (play, breathe, music), on/v | feature use |
| harmony | secs | breathe-sync success |
| session_start / session_end | min, source / saved, early, min | session completion |
| replay, export, session_delete, snapshot | – | feature use |
| client_error | kind, msg (scrubbed, 80 chars) | crashes in the wild |

Never sent: EEG/PPG values, bands, heart rate, session contents, device names/IDs.
Guard: each event ≤20 per page load, ≤150 total. Opt-out: GPC, Do Not Track, or `localStorage.hbi.notrack = '1'`.

## Dashboard (vercel.com → project)
- Web Analytics and Speed Insights: enabled (verified via API on first deploy).
- **Firewall**: Bot Protection = Challenge (live since 2026-10-31; browsers and verified bots pass, scripts like plain `curl` get 429). DDoS mitigation on by default. Under attack: `vercel firewall attack-mode`. Check traffic: `vercel firewall overview`.
- **Settings → Spend Management**: set a cap/alerts (bandwidth abuse on a static site).
- **Git**: install the Vercel GitHub App on `fuzzyplace` (github.com/apps/vercel), then `vercel git connect` → push to `main` deploys production, other branches get preview URLs.
- **Deployment Protection**: keep Vercel Authentication on *preview* deployments only.
- **Observability** tab: edge request counts, 4xx/5xx, top paths, bandwidth.
