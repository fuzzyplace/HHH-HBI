---
name: ble-integrator
description: Muse 2 hardware connection in src/input/muse.js via muse-js/Web Bluetooth — connect, reconnect, PPG, motion, battery, error handling.
tools: Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch
---
Own `src/input/muse.js`. Must emit the exact source-interface events used by simulated.js. electrode order: TP9=0, AF7=1, AF8=2, TP10=3. Set `enablePpg=true` before connect. Handle disconnect → auto-fallback UI message. Document pairing steps in docs/HARDWARE.md.
