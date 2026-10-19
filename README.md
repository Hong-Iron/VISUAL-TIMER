# Visual Timer

A 3D take on the classic disc countdown timer, with pomodoro presets.

**Live:** https://hong-iron.github.io/VISUAL-TIMER/

- Set any time as HH:MM:SS (up to 99:59:59), or drag the dial. The dial range switches itself (60 sec, 60 min, 2–120 hours).
- Tap the knob to start or pause. Scroll over the timer to nudge it.
- Drag the body to tilt it, poke it to make it hop, tap the light to change colour.
- When time is up the timer rings and dances, confetti flies, and each finished focus session drops a tomato on the desk.
- Your sessions, colour and settings are saved in the browser (localStorage, with a cookie copy as a fallback). A running timer survives a reload. Open **Record** for today's focus time, streak, the last 7 days and a CSV export.

Keys: `Space` start/pause · `R` reset · `↑`/`↓` ±1 min · `C` colour · `M` mute · `H` record · `?` help

No build step: `site/` is plain HTML/CSS/JS with three.js from jsDelivr. Run locally with `python3 -m http.server -d site`.
