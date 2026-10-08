/**
 * The vision route's vocabulary for Auto Stretch, with no engine imports so the
 * server route can validate a model reply without pulling in the renderer.
 * `verify:stretch-core` pins AUTO_LOOKS to the engine's WARP_PRESETS.
 */

export const AUTO_LOOKS = ['rise', 'swoosh', 'arch', 'fan', 'wave', 'fold', 'twist']

export const AUTO_EDGES = {
  up: { axis: 'vertical', direction: -1 },
  down: { axis: 'vertical', direction: 1 },
  left: { axis: 'horizontal', direction: -1 },
  right: { axis: 'horizontal', direction: 1 },
}

// Gemini makes the decisions; the client measured the subject first (SlimSAM)
// and hands those facts over, so the model decides from what it sees AND from
// how much room there really is, then the client carries the decision out.
export const AUTO_HINT_PROMPT = `You are the art director of a "pixel stretch" edit made the Photoshop way: a 1-pixel line is sampled across the main subject, stretched into a band of crisp parallel stripes that runs off the edge of the frame, the band is warped, and the subject is masked back in front so the stripes come out from behind it. Reference edits: stripes rising off a car's tail and sweeping over it; a fan of light opening from the top of a monument; a minaret's colours stretched sideways in a ripple; a ribbon rising behind a person's shoulder.

You decide the edit. The client then builds exactly what you choose.

- subject: the main subject's bounding box, normalised 0-1 { x, y, w, h }. If measurements are given, keep to them unless they clearly missed part of the subject.
- points: 3 or 4 points (normalised 0-1) that lie ON the subject, spread over its main parts (for a motorbike: tank, seat, engine, front wheel; for a person: face, chest, shoulder). They prompt the segmentation, so each must be on the subject itself, never on background seen through it.
- edge: where the stripes run — "up", "down", "left" or "right". Pick open, quiet space (sky, plain wall, soft background) where the stripes will read clearly. Use the measured room: a side with almost no room cannot show stripes. Never run them across a face. "down" into the ground rarely works.
- look: how the band is warped.
  rise = straight stripes to the edge;
  swoosh = sweeps out and curls toward one side (vehicles, moving subjects, people);
  arch = rises, bends over and comes down beside the subject (buildings, monuments);
  fan = opens from narrow to wide (towers, domes, gates — a crown of light);
  wave = snakes toward the edge (tall subjects stretched sideways);
  fold = folds over to one side (graphic, editorial);
  twist = turns over once (playful, abstract).
- bend: which way a swoosh, arch, fold or wave bends — "left" or "right" when the stripes run up or down, "up" or "down" when they run sideways. Bend toward open space, usually back over or away from the subject so the shape reads.
- amount: how strong the warp is, 0.2 (gentle) to 1.5 (dramatic). For fan, how wide it opens.
- sample: the box (normalised) whose colours should make the stripes — the most striking, colourful band ACROSS the subject near the edge the stripes leave from (tail lights and paint, a lit crown, a striped shirt). It must overlap the subject.
- placement: "behind" (subject fully in front — usual) or "partial" (the stripes come out from behind and cross back IN FRONT of the subject — only when the look curls back over it).
- reasoning: one sentence a user would understand.`

const BOX = {
  type: "OBJECT",
  properties: { x: { type: "NUMBER" }, y: { type: "NUMBER" }, w: { type: "NUMBER" }, h: { type: "NUMBER" } },
  required: ["x", "y", "w", "h"],
}

export const AUTO_HINT_SCHEMA = {
  type: "OBJECT",
  properties: {
    subject: BOX,
    points: { type: "ARRAY", items: { type: "OBJECT", properties: { x: { type: "NUMBER" }, y: { type: "NUMBER" } }, required: ["x", "y"] } },
    edge: { type: "STRING", enum: ["up", "down", "left", "right"] },
    look: { type: "STRING", enum: AUTO_LOOKS },
    bend: { type: "STRING", enum: ["left", "right", "up", "down"] },
    amount: { type: "NUMBER" },
    sample: BOX,
    placement: { type: "STRING", enum: ["behind", "partial"] },
    reasoning: { type: "STRING" },
  },
  required: ["subject", "points", "edge", "look", "amount", "sample", "placement", "reasoning"],
}

/**
 * The client's measurements, as the text the model reads. `facts` is
 * { subject: {x,y,w,h}, area, room: {up,down,left,right}, aspect } or null.
 */
export function describeAutoFacts(facts, width, height) {
  const lines = [`Photo ${width || '?'}×${height || '?'}px.`]
  if (facts?.subject) {
    const b = facts.subject
    const r = facts.room || {}
    const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`
    lines.push(`Measured subject (on-device segmentation): x ${pct(b.x)}, y ${pct(b.y)}, w ${pct(b.w)}, h ${pct(b.h)} of the frame; it covers ${pct(facts.area)} of the image; width:height ${(Number(facts.aspect) || 1).toFixed(2)}.`)
    lines.push(`Open room from the subject to each frame edge: up ${pct(r.up)}, down ${pct(r.down)}, left ${pct(r.left)}, right ${pct(r.right)}.`)
  } else {
    lines.push('No subject was measured on device; find it yourself.')
  }
  lines.push('Make the creative decisions for its pixel stretch.')
  return lines.join('\n')
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

const box01 = (b) => {
  if (!b || !['x', 'y', 'w', 'h'].every((k) => Number.isFinite(Number(b[k])))) return null
  const out = { x: clamp(+b.x, 0, 0.98), y: clamp(+b.y, 0, 0.98), w: clamp(+b.w, 0.02, 1), h: clamp(+b.h, 0.02, 1) }
  out.w = Math.min(out.w, 1 - out.x)
  out.h = Math.min(out.h, 1 - out.y)
  return out
}

/** Clamp a hint to what the planner understands; null fields mean "decide yourself". */
export function sanitizeAutoHint(raw) {
  if (!raw || typeof raw !== 'object') return null
  const box = box01(raw.subject)
  return {
    look: AUTO_LOOKS.includes(raw.look) ? raw.look : null,
    edge: AUTO_EDGES[raw.edge] ? raw.edge : null,
    axis: raw.axis === 'horizontal' || raw.axis === 'vertical' ? raw.axis : null,
    placement: ['behind', 'partial', 'above'].includes(raw.placement) ? raw.placement : null,
    amount: Number.isFinite(Number(raw.amount)) && raw.amount !== null && raw.amount !== '' ? clamp(+raw.amount, -2, 2) : null,
    gain: Number.isFinite(Number(raw.gain)) && raw.gain !== null && raw.gain !== '' ? clamp(+raw.gain, 0.3, 2) : null,
    bend: ['left', 'right', 'up', 'down'].includes(raw.bend) ? raw.bend : null,
    sample: box01(raw.sample),
    points: Array.isArray(raw.points)
      ? raw.points.filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))).slice(0, 5).map((p) => ({ x: clamp(+p.x, 0, 1), y: clamp(+p.y, 0, 1) }))
      : [],
    subject: box,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning.slice(0, 300) : '',
  }
}
