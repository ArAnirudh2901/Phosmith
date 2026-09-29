---
name: collage-generator-bar
description: "Phosmith's collage generator must produce genuinely good results via the agent and survive a specific list of edge cases the user wrote out (DSLR files, grid math, touch, export, device state)."
metadata: 
  node_type: memory
  type: project
  originSessionId: eebdaeeb-9d07-4851-8205-311aea0469da
  modified: 2026-09-24T13:05:54.947Z
---

Stated 2026-09-24. The collage generator is held to a higher bar than "it renders": it must actually produce results a user would keep, driven through the in-app agent (agent chat → collage intent → vision planner → layout), and it must hold up on real DSLR photos, not just web-sized test images. Every other editor feature is expected to reach the same level of polish, and to feel distinctive rather than the usual photo-app template output.

The user's own edge-case list (their words, their grouping; they noted some entries may be wrong or not apply):

**Image & asset**
- Ultra-high resolution: 50MP+ DSLR uploads exhausting browser/canvas memory.
- Ultra-low resolution: 200×200 thumbnails or screenshots stretched into a large frame, heavy pixelation.
- Extreme aspect ratios: 16:1 panoramas or 1:5 tall screenshots in square frames — extreme crop or huge letterboxing.
- EXIF orientation: JPEGs that render rotated 90/180° on canvas.
- Mixed transparency: transparent PNG/WebP/GIF over solid collage backgrounds.
- Color profile mismatch: CMYK or AdobeRGB photos looking washed out / shifted on an sRGB canvas.

**Grid geometry & math**
- Sub-pixel rounding: 1080px ÷ 3 = 360.33px leaving 1px gaps or overlaps between frames.
- Border thickness at 0 (layout collapses) or at maximum (images hidden).
- Extreme corner radius: adjacent rounded frames clipping into each other or becoming pills/circles.
- Inner vs outer borders: border eating the photo edge vs shrinking the visible frame.
- Asymmetric frame resize: dragging one frame in a custom grid collapsing a neighbor to zero width/height.

**User interaction & manipulation**
- Over-zoom / over-pan: image scaled so small it leaves blank space in its frame, or panned out of view.
- Rapid layout switching: cycling 10 templates in 2 seconds while images still load — race conditions, ghost renders.
- Multi-touch conflicts: two-finger pinch-zoom on an image while a third finger drags a border or swaps template.
- Accidental drag-and-drop swap: a pan gesture inside a frame misread as a swap with a neighboring frame.
- Empty slots: render / export / filter a 4-photo template with only 2 images uploaded.

**Export & performance**
- Canvas size limits: iOS Safari crashing on high-res 9:16 export past max dimension/area.
- Background tab throttling: user taps Export then switches app; throttled JS thread freezes or corrupts the file.
- CORS: cloud-storage photos (Google Photos, iCloud) tainting the canvas and blocking export.
- Re-compression loss: JPEG recompressed across edits, visible artifacts in the final export.

**Device & state**
- Mid-edit screen rotation breaking canvas scaling.
- Low device RAM: app silently killed or page reloaded mid-edit, wiping progress.
- System dark mode flipping at sunset, changing default UI background colors that bleed into transparent collage elements.

**Why:** The collage path is the feature the user most wants to be trustworthy end to end, and these are the failures they expect a real user's library to trigger.

**How to apply:** Treat the list as a test matrix, not a wish list — each item wants a real check (verify script, harness case, or reproduced manually) rather than a code-reading argument that it is fine. Verify DSLR-sized inputs explicitly. Flag any list item that does not apply to this architecture instead of silently skipping it.

Related: [[engineering-bar-next-level]], [[app-tool-call-efficiency]]
