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

// The model is asked only for the creative calls; geometry is computed from
// the pixels on the client.
export const AUTO_HINT_PROMPT = `You direct a "pixel stretch" edit, made the Photoshop way: a 1-pixel line is sampled across the main subject, stretched into a band of crisp parallel stripes that runs off the edge of the frame, the band is warped, and the subject is masked back in front so the stripes come out from behind it.

Decide only these creative calls (the geometry is computed from the pixels):
- subject: the main subject's bounding box, normalised 0-1 { x, y, w, h }.
- edge: which frame edge the stripes run toward — "up", "down", "left" or "right". Pick the side with the most open, quiet space (sky, plain wall, soft background). Never run them across a face. Avoid "down" into the ground unless nothing else is open.
- look: how the band is warped.
  rise = straight stripes to the edge (portraits, heads, simple scenes);
  swoosh = sweeps out and curls toward the open side (cars, bikes, moving things);
  arch = bends over in an arc and comes down beside the subject (buildings, monuments, symmetric subjects with room above);
  fan = opens from narrow to wide (a narrow subject with a big open area ahead — towers, domes, a single figure);
  wave = snakes toward the edge (tall subjects stretched sideways, minarets, columns, standing people with room beside them);
  fold = folds over to one side (graphic, editorial looks);
  twist = turns over once (playful, abstract).
- placement: "behind" (subject fully in front — the usual choice) or "partial" (the stripes come out from behind and cross back in front of the subject; only when the look curls back over it).
- reasoning: one short sentence.`

export const AUTO_HINT_SCHEMA = {
  type: "OBJECT",
  properties: {
    subject: {
      type: "OBJECT",
      properties: { x: { type: "NUMBER" }, y: { type: "NUMBER" }, w: { type: "NUMBER" }, h: { type: "NUMBER" } },
      required: ["x", "y", "w", "h"],
    },
    edge: { type: "STRING", enum: ["up", "down", "left", "right"] },
    look: { type: "STRING", enum: AUTO_LOOKS },
    placement: { type: "STRING", enum: ["behind", "partial"] },
    reasoning: { type: "STRING" },
  },
  required: ["edge", "look", "placement", "reasoning"],
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** Clamp a hint to what the planner understands; null fields mean "decide yourself". */
export function sanitizeAutoHint(raw) {
  if (!raw || typeof raw !== 'object') return null
  const box = raw.subject && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(Number(raw.subject[k])))
    ? { x: clamp(+raw.subject.x, 0, 0.98), y: clamp(+raw.subject.y, 0, 0.98), w: clamp(+raw.subject.w, 0.02, 1), h: clamp(+raw.subject.h, 0.02, 1) }
    : null
  if (box) {
    box.w = Math.min(box.w, 1 - box.x)
    box.h = Math.min(box.h, 1 - box.y)
  }
  return {
    look: AUTO_LOOKS.includes(raw.look) ? raw.look : null,
    edge: AUTO_EDGES[raw.edge] ? raw.edge : null,
    axis: raw.axis === 'horizontal' || raw.axis === 'vertical' ? raw.axis : null,
    placement: ['behind', 'partial', 'above'].includes(raw.placement) ? raw.placement : null,
    amount: Number.isFinite(Number(raw.amount)) && raw.amount !== null && raw.amount !== '' ? clamp(+raw.amount, -2, 2) : null,
    gain: Number.isFinite(Number(raw.gain)) && raw.gain !== null && raw.gain !== '' ? clamp(+raw.gain, 0.3, 2) : null,
    subject: box,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning.slice(0, 300) : '',
  }
}
