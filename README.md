# Visual Timer

A 3D take on the classic disc countdown timer, with pomodoro presets.

**Live:** https://hong-iron.github.io/VISUAL-TIMER/

- Set any time as HH:MM:SS (up to 99:59:59), or drag the dial. The dial range switches itself (60 sec, 60 min, 2–120 hours).
- Tap the knob to start or pause. Scroll over the timer to nudge it.
- Drag the body to tilt it, poke it to make it hop, tap the light to change colour.
- When time is up the timer rings and dances, confetti flies, and each finished focus session drops a tomato on the desk.
- **Share my record** (in Record) makes a brag card for today, the last 7 days or all time: a snapshot of your 3D timer, total focus, a rank from Tomato Sprout to Time Lord, tomatoes and streak. Share it, save the PNG, copy it, or post on X.
- **Mini window** (picture-in-picture, `P`): just the timer's face, always on top of other windows. Chrome and Edge on desktop get a window where you can click and drag the dial to set the time, tap the knob to start/pause, scroll to nudge, and use start/pause, reset and +1 min on hover; other browsers with video picture-in-picture get the face as a floating video whose play/pause button runs the timer.
- Your sessions, colour and settings are saved in the browser (localStorage, with a cookie copy as a fallback). A running timer survives a reload. Open **Record** for today's focus time, streak, the last 7 days and a CSV export.

Keys: `Space` start/pause · `R` reset · `↑`/`↓` ±1 min · `C` colour · `M` mute · `H` record · `?` help

Link previews use `site/og.png`, rendered from the page itself with `?og` (headless Chrome at 1200×630).

No build step: `site/` is plain HTML/CSS/JS with three.js from jsDelivr. Run locally with `python3 -m http.server -d site`.

## Support

If the timer helps you focus, you can buy me a coffee:

- 카카오페이: https://qr.kakaopay.com/FKcOJKyOy1f405462
- Buy Me a Coffee: https://buymeacoffee.com/hongiron
