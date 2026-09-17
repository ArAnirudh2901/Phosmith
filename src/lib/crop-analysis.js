// Contract for the vision pass that reads a photo BEFORE subject-aware cropping.
// Shared by /api/ai/crop-analyze (prompt + schema) and the client (validation),
// so whatever the model returns reaches the composer clamped and normalised.
// Boxes use Gemini's native detection format: box_2d = [ymin, xmin, ymax, xmax] on 0..1000.

export const CROP_SCENES = [
    'portrait', 'group', 'animal', 'product', 'food', 'vehicle', 'action',
    'architecture', 'interior', 'landscape', 'document', 'other',
]
export const CROP_FACINGS = ['left', 'right', 'camera', 'away', 'none']
export const CROP_EMPHASIS = ['sky', 'ground', 'balanced', 'none']
export const CROP_EDGES = ['left', 'right', 'top', 'bottom']
export const CROP_ASPECT_CHOICES = ['original', '1:1', '4:5', '3:2', '2:3', '16:9', '9:16']

const MAX_SUBJECTS = 6
const MAX_KEEP = 6

export const buildCropAnalysisSystemPrompt = () => `You are a senior photo editor preparing a crop. Study the photo and report what a professional needs to compose it. Do not crop; describe.

Rules:
- box_2d is [ymin, xmin, ymax, xmax] with integers 0-1000 relative to the full image.
- subjects: the things the photo is about, most important first. Box the WHOLE subject (entire person/animal/object), not a part. importance 0-1. Background people or incidental objects are not subjects.
- facing: the direction the subject looks or moves as seen in the image ("left" means toward the image's left edge). "camera" when looking at the viewer.
- eye_line: y (0-1000) of the main subject's eyes when a person or animal face is visible, else -1.
- must_keep: parts that would ruin the photo if cut: every face in a group, hands holding something, a ball in play, a product label, a sign the photo is about. Boxes may overlap subjects.
- has_distinct_subject: false for scenes (landscapes, cityscapes, patterns) where no single thing dominates.
- horizon: y (0-1000) of a clear horizon or water line, else -1. emphasis: which side of the horizon is more interesting.
- symmetric + symmetry_axis: true for deliberately symmetric shots (architecture, centred portraits), axis x 0-1000, else -1.
- clutter_edges: edges carrying distractions worth trimming (cut-off objects, stray people, bright junk).
- suggested_aspect: the ratio that best serves this photo's content.
- intent: one short sentence on how you would compose the crop. Do not guess gender; say "the subject" or "the person".
Be precise with boxes; they drive an automatic crop.`

export const buildCropAnalysisUserText = ({ width, height, aspect }) =>
    `Image is ${Math.round(width)}×${Math.round(height)} px.${aspect ? ` The user wants a ${Number(aspect).toFixed(3)}:1 crop.` : ''} Analyse it for cropping.`

const box2d = { type: 'ARRAY', items: { type: 'INTEGER' }, minItems: 4, maxItems: 4 }

export const buildCropAnalysisSchema = () => ({
    type: 'OBJECT',
    properties: {
        scene: { type: 'STRING', enum: CROP_SCENES },
        has_distinct_subject: { type: 'BOOLEAN' },
        subjects: {
            type: 'ARRAY',
            maxItems: MAX_SUBJECTS,
            items: {
                type: 'OBJECT',
                properties: {
                    label: { type: 'STRING' },
                    box_2d: box2d,
                    importance: { type: 'NUMBER' },
                    facing: { type: 'STRING', enum: CROP_FACINGS },
                },
                required: ['label', 'box_2d', 'importance', 'facing'],
            },
        },
        must_keep: {
            type: 'ARRAY',
            maxItems: MAX_KEEP,
            items: {
                type: 'OBJECT',
                properties: { label: { type: 'STRING' }, box_2d: box2d },
                required: ['label', 'box_2d'],
            },
        },
        eye_line: { type: 'INTEGER' },
        horizon: { type: 'INTEGER' },
        emphasis: { type: 'STRING', enum: CROP_EMPHASIS },
        symmetric: { type: 'BOOLEAN' },
        symmetry_axis: { type: 'INTEGER' },
        clutter_edges: { type: 'ARRAY', maxItems: 4, items: { type: 'STRING', enum: CROP_EDGES } },
        suggested_aspect: { type: 'STRING', enum: CROP_ASPECT_CHOICES },
        intent: { type: 'STRING' },
    },
    required: ['scene', 'has_distinct_subject', 'subjects', 'must_keep', 'eye_line', 'horizon', 'emphasis', 'symmetric', 'symmetry_axis', 'clutter_edges', 'suggested_aspect', 'intent'],
})

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
const unit = (v) => Math.max(0, Math.min(1, num(v, 0) / 1000))
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback)
const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
// -1 (or anything out of range) means "not present".
const optionalUnit = (v) => {
    const n = num(v, -1)
    return n >= 0 && n <= 1000 ? n / 1000 : null
}

/** box_2d → normalised {x0,y0,x1,y1}; null when degenerate. */
export const normalizeBox2d = (b) => {
    if (!Array.isArray(b) || b.length !== 4) return null
    let [y0, x0, y1, x1] = b.map(unit)
    if (x1 < x0) [x0, x1] = [x1, x0]
    if (y1 < y0) [y0, y1] = [y1, y0]
    if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return null
    return { x0, y0, x1, y1 }
}

/** Clamp a raw model reply into the analysis the composer consumes (normalised 0..1). */
export const validateCropAnalysis = (raw) => {
    const r = raw && typeof raw === 'object' ? raw : {}
    const subjects = (Array.isArray(r.subjects) ? r.subjects : [])
        .map((s) => ({
            label: text(s?.label, 40) || 'subject',
            box: normalizeBox2d(s?.box_2d),
            importance: Math.max(0, Math.min(1, num(s?.importance, 0.5))),
            facing: pick(s?.facing, CROP_FACINGS, 'none'),
        }))
        .filter((s) => s.box)
        .slice(0, MAX_SUBJECTS)
        .sort((a, b) => b.importance - a.importance)
    const mustKeep = (Array.isArray(r.must_keep) ? r.must_keep : [])
        .map((k) => ({ label: text(k?.label, 40) || 'detail', box: normalizeBox2d(k?.box_2d) }))
        .filter((k) => k.box)
        .slice(0, MAX_KEEP)
    const scene = pick(r.scene, CROP_SCENES, 'other')
    return {
        scene,
        hasDistinctSubject: typeof r.has_distinct_subject === 'boolean' ? r.has_distinct_subject && subjects.length > 0 : subjects.length > 0,
        subjects,
        mustKeep,
        eyeLine: optionalUnit(r.eye_line),
        horizon: optionalUnit(r.horizon),
        emphasis: pick(r.emphasis, CROP_EMPHASIS, 'none'),
        symmetric: r.symmetric === true,
        symmetryAxis: optionalUnit(r.symmetry_axis),
        clutterEdges: [...new Set((Array.isArray(r.clutter_edges) ? r.clutter_edges : []).filter((e) => CROP_EDGES.includes(e)))],
        suggestedAspect: pick(r.suggested_aspect, CROP_ASPECT_CHOICES, 'original'),
        intent: text(r.intent, 160),
    }
}

/** '4:5' → 0.8; 'original' → the image's own ratio. */
export const aspectFromChoice = (choice, width, height) => {
    if (choice === 'original' || !choice) return width / height
    const [a, b] = String(choice).split(':').map(Number)
    return a > 0 && b > 0 ? a / b : width / height
}
