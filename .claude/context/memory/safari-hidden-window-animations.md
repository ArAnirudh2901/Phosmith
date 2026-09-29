---
name: safari-hidden-window-animations
description: Safari never starts a CSS animation while the window is occluded, so a reveal reads as opacity 0 in a harness
metadata:
  type: reference
---

Safari does not *start* a CSS animation on a page whose `document.visibilityState` is `hidden`, and a fullscreen terminal over the browser is enough to make it hidden. `getAnimations()` then reports `playState: "running"` with `startTime: null` and `currentTime: 0` forever, so `animation-fill-mode: both` never applies and the element stays at its base `opacity: 0` — indistinguishable from a broken keyframe. `tell application "Safari" to activate` does not clear it across Spaces.

**Why:** this made the landing page's scroll reveal look broken when it was correct. Measuring the wrong thing costs more than not measuring.

**How to apply:** when verifying an animation through an AppleScript/CDP harness, call `finish()` on every animation and read the computed style, e.g. `document.getAnimations().forEach(a => a.finish())` then check `opacity` / `transform`. Also read `document.visibilityState` first and say so in the result. Relates to [[verify-by-looking]].
