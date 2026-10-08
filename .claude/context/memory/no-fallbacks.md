---
name: no-fallbacks
description: User wants the chosen engine's result or a clear failure — no degraded stand-ins (said of the Erase fill, 2026-10-08)
metadata:
  type: feedback
---

"no need of any fallbacks" — said when told the object remover filled on-device (a PatchMatch fill) whenever the LaMa service was down. The on-device fill, the cut-out-instead path, the route's LaMa→Stable Diffusion fall-through and the data:-URL save were all removed: a fill is LaMa's (or the chosen Cloud engine's) or nothing changes and the toast says why.

**Why:** a stand-in result that looks worse than the real engine reads as the feature being broken; a clear "service not running — nothing was changed" does not.

**How to apply:** in new AI features, do not add silent quality fallbacks; fail with an honest message and leave the canvas untouched. If a fallback seems valuable, ask first rather than build it. Related: [[engineering-bar-next-level]], [[fluid-interaction-bar]].
