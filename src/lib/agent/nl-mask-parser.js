/**
 * NL Mask Parser (pure — no DOM, no network)
 * -------------------------------------------
 * Turns a natural-language region description ("the dog on the left",
 * "everything except the sky", "the shadows, but not the person") into a
 * structured, validated MaskPlan the executor (nl-mask.js) can run.
 *
 * Two producers share this module's vocabulary and the validator:
 *   - /api/ai/mask-plan asks Gemini for a MaskPlan (richer language
 *     understanding) and validates it here before returning it;
 *   - `parseMaskDescription` is the deterministic fallback used when the
 *     route is unreachable / unconfigured, and the baseline the verify
 *     script pins.
 *
 * MaskPlan v1:
 *   {
 *     version: 1,
 *     source: 'gemini' | 'heuristic',
 *     fillMode: 'fill' | 'adjust' | 'erase',
 *     feather: number 0..0.5 | null,
 *     grow: number -200..200 | null,    // boundary extension in px
 *     invert: boolean,                  // "everything except …"
 *     steps: [{ op: 'add'|'subtract'|'intersect', target: Target }]
 *   }
 *
 * Target (by `type`):
 *   subjects   { labels: string[], qualifiers?: { position?, ordinal?, size?, color? } }
 *   concept    { phrase: string }                       // open-vocab → /api/ai/ground
 *   depth      { region: 'foreground'|'background'|'midground' }
 *   luminance  { region: 'shadows'|'midtones'|'highlights' }
 *   colorRange { name?: string, hex?: string, tolerance?: number }
 *   region     { area: 'top'|'bottom'|'left'|'right'|'center'|'edges', fraction?: number }
 *
 * @module agent/nl-mask-parser
 */

export const MASK_PLAN_VERSION = 1

export const PLAN_OPS = ['add', 'subtract', 'intersect']
export const PLAN_FILL_MODES = ['fill', 'adjust', 'erase']
export const TARGET_TYPES = ['subjects', 'concept', 'depth', 'luminance', 'colorRange', 'region']
export const DEPTH_REGIONS = ['foreground', 'background', 'midground']
export const LUMINANCE_REGIONS = ['shadows', 'midtones', 'highlights']
export const REGION_AREAS = ['top', 'bottom', 'left', 'right', 'center', 'edges']
export const POSITIONS = ['left', 'right', 'top', 'bottom', 'center']
export const SIZES = ['largest', 'smallest']

/** Common-noun → YOLO/COCO label. Detection labels come straight from the
 *  model's `names` map, so values here must match those strings. */
export const SUBJECT_SYNONYMS = {
    person: 'person', people: 'person', man: 'person', men: 'person',
    woman: 'person', women: 'person', guy: 'person', guys: 'person',
    girl: 'person', girls: 'person', boy: 'person', boys: 'person',
    lady: 'person', kid: 'person', kids: 'person', child: 'person',
    children: 'person', human: 'person', humans: 'person', couple: 'person',
    everyone: 'person', everybody: 'person',
    dog: 'dog', dogs: 'dog', puppy: 'dog', puppies: 'dog',
    cat: 'cat', cats: 'cat', kitten: 'cat', kittens: 'cat',
    bird: 'bird', birds: 'bird',
    horse: 'horse', horses: 'horse', pony: 'horse',
    sheep: 'sheep', lamb: 'sheep',
    cow: 'cow', cows: 'cow', cattle: 'cow',
    elephant: 'elephant', elephants: 'elephant',
    bear: 'bear', bears: 'bear',
    zebra: 'zebra', zebras: 'zebra',
    giraffe: 'giraffe', giraffes: 'giraffe',
    // Non-animal COCO classes the salient pass can surface. If detection
    // doesn't return them, the executor falls back to concept grounding.
    car: 'car', cars: 'car', truck: 'truck', trucks: 'truck',
    bus: 'bus', buses: 'bus', bicycle: 'bicycle', bike: 'bicycle',
    motorcycle: 'motorcycle', motorbike: 'motorcycle', boat: 'boat',
}

/** Scene nouns CLIPSeg grounds better than instance detection. */
const CONCEPT_NOUNS = [
    'sky', 'clouds', 'cloud', 'sun', 'moon', 'water', 'sea', 'ocean', 'lake',
    'river', 'waterfall', 'grass', 'tree', 'trees', 'forest', 'mountain',
    'mountains', 'hill', 'hills', 'road', 'street', 'path', 'floor', 'ground',
    'wall', 'walls', 'ceiling', 'building', 'buildings', 'house', 'window',
    'windows', 'door', 'hair', 'face', 'skin', 'hand', 'hands', 'eyes',
    'beach', 'sand', 'snow', 'rocks', 'rock', 'flowers', 'flower', 'plant',
    'plants', 'table', 'chair',
]

const COLOR_WORDS = [
    'red', 'orange', 'yellow', 'green', 'teal', 'cyan', 'blue', 'purple',
    'violet', 'pink', 'magenta', 'brown', 'black', 'white', 'gray', 'grey',
]

export const COLOR_NAME_HEX = {
    red: '#e53935', orange: '#fb8c00', yellow: '#fdd835', green: '#43a047',
    teal: '#00897b', cyan: '#00acc1', blue: '#1e88e5', purple: '#8e24aa',
    violet: '#8e24aa', pink: '#d81b60', magenta: '#d500f9', brown: '#6d4c41',
    black: '#111111', white: '#f2f2f2', gray: '#9e9e9e', grey: '#9e9e9e',
}

const ORDINAL_WORDS = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
    seventh: 7, eighth: 8, ninth: 9, tenth: 10,
}

const clampNum = (v, lo, hi, fallback = null) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return fallback
    return Math.max(lo, Math.min(hi, n))
}

/* ─── Fragment → Target ──────────────────────────────────────────────────── */

const wordRe = (words) => new RegExp(`\\b(${words.join('|')})\\b`, 'i')

const SUBJECT_RE = wordRe(Object.keys(SUBJECT_SYNONYMS))
const CONCEPT_RE = wordRe(CONCEPT_NOUNS)
const COLOR_RE = wordRe(COLOR_WORDS)

const extractQualifiers = (text) => {
    const q = {}
    if (/\b(left[- ]?most|on the left|to the left|left side)\b/i.test(text)) q.position = 'left'
    else if (/\b(right[- ]?most|on the right|to the right|right side)\b/i.test(text)) q.position = 'right'
    else if (/\b(at the top|topmost|upper)\b/i.test(text)) q.position = 'top'
    else if (/\b(at the bottom|bottommost|lower)\b/i.test(text)) q.position = 'bottom'
    else if (/\b(in the (middle|center|centre))\b/i.test(text)) q.position = 'center'

    if (/\b(largest|biggest|main|primary|closest)\b/i.test(text)) q.size = 'largest'
    else if (/\b(smallest|tiniest|littlest)\b/i.test(text)) q.size = 'smallest'

    const ordWord = text.match(wordRe(Object.keys(ORDINAL_WORDS)))
    const ordNum = text.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/i)
    if (ordWord) q.ordinal = ORDINAL_WORDS[ordWord[1].toLowerCase()]
    else if (ordNum) q.ordinal = parseInt(ordNum[1], 10)
    if (q.ordinal && /\bfrom the right\b/i.test(text)) q.ordinalFrom = 'right'

    const color = text.match(COLOR_RE)
    if (color) q.color = color[1].toLowerCase()

    return q
}

const FRACTION_WORDS = { half: 0.5, third: 1 / 3, quarter: 0.25 }

/** Resolve a single noun-phrase fragment to a Target, or null. */
export const fragmentToTarget = (fragmentRaw) => {
    const fragment = String(fragmentRaw || '').trim().toLowerCase()
    if (!fragment) return null

    // Depth planes.
    if (/\bbackground\b/.test(fragment)) return { type: 'depth', region: 'background' }
    if (/\bforeground\b/.test(fragment)) return { type: 'depth', region: 'foreground' }
    if (/\bmidground\b/.test(fragment)) return { type: 'depth', region: 'midground' }

    // Luminance ranges.
    if (/\b(shadows?|dark(?:er)? (?:areas?|parts?|regions?|tones?))\b/.test(fragment)) {
        return { type: 'luminance', region: 'shadows' }
    }
    if (/\b(highlights?|bright(?:er)? (?:areas?|parts?|regions?|tones?))\b/.test(fragment)) {
        return { type: 'luminance', region: 'highlights' }
    }
    if (/\bmid-?tones?\b/.test(fragment)) return { type: 'luminance', region: 'midtones' }

    // Geometric regions: "top half", "bottom third", "left side", "edges", …
    // ANCHORED to the whole fragment ("the left side") — inside a longer noun
    // phrase ("the person on the left side", "the dog in the middle") the
    // words are a POSITION QUALIFIER for the subject, not a region request.
    const geo = fragment.match(/^(?:the\s+)?(top|upper|bottom|lower|left|right)\s+(half|third|quarter|side|part|portion|edge)(?:\s+of\s+the\s+(?:image|photo|picture|frame))?$/)
    if (geo) {
        const area = { upper: 'top', lower: 'bottom' }[geo[1]] || geo[1]
        const fraction = FRACTION_WORDS[geo[2]] ?? 0.5
        return { type: 'region', area, fraction }
    }
    if (/^(?:the\s+)?(center|centre|middle)(?:\s+of\s+the\s+(?:image|photo|picture|frame))?$/.test(fragment)) {
        return { type: 'region', area: 'center', fraction: 0.5 }
    }
    if (/^(?:the\s+)?(edges?|borders?|corners|vignette)(?:\s+of\s+the\s+(?:image|photo|picture|frame))?$/.test(fragment)) {
        return { type: 'region', area: 'edges', fraction: 0.5 }
    }

    // Colour ranges: "the red areas", "all the green parts/tones".
    const colorRange = fragment.match(
        new RegExp(`\\b(${COLOR_WORDS.join('|')})\\s+(areas?|parts?|regions?|tones?|colou?rs?|pixels?)\\b`)
    )
    if (colorRange) {
        return { type: 'colorRange', name: colorRange[1], hex: COLOR_NAME_HEX[colorRange[1]] }
    }

    // Detectable subjects ("the dog", "the person on the left", "the red car").
    const subj = fragment.match(SUBJECT_RE)
    if (subj) {
        const label = SUBJECT_SYNONYMS[subj[1].toLowerCase()]
        const qualifiers = extractQualifiers(fragment)
        const target = { type: 'subjects', labels: [label] }
        if (Object.keys(qualifiers).length) target.qualifiers = qualifiers
        // Keep the raw phrase so the executor can fall back to grounding when
        // detection has no matching instance.
        target.phrase = fragment
        return target
    }

    // Known scene nouns → concept grounding.
    if (CONCEPT_RE.test(fragment)) return { type: 'concept', phrase: fragment }

    // Anything else: trust CLIPSeg with the raw phrase.
    return { type: 'concept', phrase: fragment }
}

/* ─── Description → MaskPlan ─────────────────────────────────────────────── */

const LEADING_VERBS = /^(please\s+)?(can you\s+|could you\s+)?(mask|select|highlight|isolate|grab|pick|target|cut\s*out|erase|remove|delete|keep)\b\s*(the\s+)?/i

const stripArticle = (s) => s.replace(/^\s*(the|a|an|all( of)?( the)?|my|our)\s+/i, '').trim()

const extractGrow = (text) => {
    const m = text.match(/\b(?:extend|expand|grow|pad|enlarge|widen)\w*\b[^.]*?\b(\d{1,3})\s*(?:px|pixels?)?\b/i)
        || text.match(/\bwith\s+(\d{1,3})\s*(?:px|pixels?)\s+(?:of\s+)?(?:padding|margin)\b/i)
    if (m) return clampNum(m[1], 1, 200)
    const s = text.match(/\b(?:shrink|contract|tighten)\w*\b[^.]*?\b(\d{1,3})\s*(?:px|pixels?)?\b/i)
    if (s) return -clampNum(s[1], 1, 200)
    if (/\b(?:extend|expand|grow|enlarge)\w*\b.*\b(slightly|a (?:little|bit|touch))\b/i.test(text)
        || /\b(slightly|a (?:little|bit|touch))\s+(?:bigger|larger|wider)\b/i.test(text)) return 8
    if (/\b(?:extend|expand|grow|enlarge)\w*\b/i.test(text) && /\b(a lot|significantly|much)\b/i.test(text)) return 24
    return null
}

const extractFeather = (text) => {
    if (/\b(soft(er|est)?\s+(edges?|transition)|feather(ed)?)\b/i.test(text)) return 0.12
    if (/\bhard\s+edges?\b/i.test(text)) return 0
    return null
}

/** Strip grow/feather/edge phrasing so it isn't parsed as a target noun. */
const stripModifierClauses = (text) => text
    .replace(/[,;]?\s*(?:and\s+)?(?:extend|expand|grow|pad|enlarge|widen|shrink|contract|tighten)\w*[^,;.]*/gi, ' ')
    .replace(/[,;]?\s*(?:and\s+)?with\s+\d{1,3}\s*(?:px|pixels?)\s+(?:of\s+)?(?:padding|margin)\b[^,;.]*/gi, ' ')
    .replace(/[,;]?\s*(?:and\s+)?(?:with\s+)?(?:soft(?:er|est)?|hard|feathered?)\s+edges?\b[^,;.]*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const splitConjunction = (text) => text
    .split(/\s*,\s*and\s+|\s*,\s*|\s+and\s+(?:also\s+)?(?:the\s+)?|\s+plus\s+(?:the\s+)?/i)
    .map((s) => s.trim())
    .filter(Boolean)

/**
 * Deterministic parse of a region description → MaskPlan (source 'heuristic').
 * Always returns a plan with >= 1 step; unrecognised text becomes a `concept`
 * step so the grounding model gets a chance before anything gives up.
 */
export const parseMaskDescription = (descriptionRaw) => {
    const original = String(descriptionRaw || '').trim()
    let text = original.toLowerCase().replace(/\s+/g, ' ')

    let fillMode = 'fill'
    const verb = text.match(LEADING_VERBS)
    if (verb && /\b(erase|remove|delete|cut\s*out)\b/i.test(verb[0])) fillMode = 'erase'
    text = text.replace(LEADING_VERBS, '')

    const grow = extractGrow(text)
    const feather = extractFeather(text)
    text = stripModifierClauses(text)

    // "everything except X" / "all but X" → plan for X, inverted.
    let invert = false
    const inv = text.match(/^(?:everything|all|the rest)\s+(?:except|but|other than|apart from)\s+(.+)$/)
    if (inv) {
        invert = true
        text = inv[1]
    }

    // Subtractions: "X except Y", "X but not Y", "X without the Y".
    const parts = text.split(/\s+(?:except|but not|excluding|without)\s+/)
    const addText = stripArticle(parts[0] || '')
    const subtractTexts = parts.slice(1).map(stripArticle).filter(Boolean)

    const steps = []
    // Conjunction split, kept ONLY when every piece resolves confidently —
    // to a concrete target type, or to a concept whose noun is in the known
    // scene vocabulary. "the dog and the cat" and "the sky and the trees"
    // split; "black and white dog" stays one phrase ("black" alone is just
    // an unconfident concept fallback).
    const isConfident = (t, fragment) =>
        Boolean(t) && (t.type !== 'concept' || CONCEPT_RE.test(fragment))
    const addPieces = splitConjunction(addText).map(stripArticle)
    const pieceTargets = addPieces.map((p) => fragmentToTarget(p))
    const splitIsSafe = addPieces.length > 1
        && pieceTargets.every((t, i) => isConfident(t, addPieces[i]))
    if (splitIsSafe) {
        for (const t of pieceTargets) steps.push({ op: 'add', target: t })
    } else {
        const t = fragmentToTarget(addText)
        if (t) steps.push({ op: 'add', target: t })
    }
    for (const sub of subtractTexts) {
        const t = fragmentToTarget(sub)
        if (t) steps.push({ op: 'subtract', target: t })
    }

    if (!steps.length) {
        steps.push({ op: 'add', target: { type: 'concept', phrase: original.slice(0, 100) } })
    }

    return validateMaskPlan({
        version: MASK_PLAN_VERSION,
        source: 'heuristic',
        fillMode,
        feather,
        grow,
        invert,
        steps,
    }).plan
}

/* ─── Validation ─────────────────────────────────────────────────────────── */

const sanitizeTarget = (t, errors, i) => {
    if (!t || typeof t !== 'object' || !TARGET_TYPES.includes(t.type)) {
        errors.push(`step ${i}: unknown target type ${t?.type}`)
        return null
    }
    switch (t.type) {
        case 'subjects': {
            const labels = (Array.isArray(t.labels) ? t.labels : [])
                .map((l) => String(l).toLowerCase().trim().slice(0, 40))
                .filter(Boolean)
            if (!labels.length) {
                errors.push(`step ${i}: subjects target needs labels`)
                return null
            }
            const out = { type: 'subjects', labels }
            if (typeof t.phrase === 'string' && t.phrase.trim()) out.phrase = t.phrase.trim().slice(0, 100)
            const q = t.qualifiers
            if (q && typeof q === 'object') {
                const qq = {}
                if (POSITIONS.includes(q.position)) qq.position = q.position
                if (SIZES.includes(q.size)) qq.size = q.size
                const ord = clampNum(q.ordinal, 1, 50)
                if (ord) qq.ordinal = Math.round(ord)
                if (q.ordinalFrom === 'right') qq.ordinalFrom = 'right'
                if (typeof q.color === 'string' && COLOR_WORDS.includes(q.color.toLowerCase())) {
                    qq.color = q.color.toLowerCase()
                }
                if (Object.keys(qq).length) out.qualifiers = qq
            }
            return out
        }
        case 'concept': {
            const phrase = String(t.phrase || '').trim().slice(0, 100)
            if (!phrase) {
                errors.push(`step ${i}: concept target needs a phrase`)
                return null
            }
            return { type: 'concept', phrase }
        }
        case 'depth':
            if (!DEPTH_REGIONS.includes(t.region)) {
                errors.push(`step ${i}: depth region must be one of ${DEPTH_REGIONS.join('/')}`)
                return null
            }
            return { type: 'depth', region: t.region }
        case 'luminance':
            if (!LUMINANCE_REGIONS.includes(t.region)) {
                errors.push(`step ${i}: luminance region must be one of ${LUMINANCE_REGIONS.join('/')}`)
                return null
            }
            return { type: 'luminance', region: t.region }
        case 'colorRange': {
            const name = typeof t.name === 'string' ? t.name.toLowerCase().trim() : ''
            const hex = /^#[0-9a-f]{6}$/i.test(t.hex || '') ? t.hex.toLowerCase() : COLOR_NAME_HEX[name]
            if (!hex) {
                errors.push(`step ${i}: colorRange needs a known name or #rrggbb hex`)
                return null
            }
            const out = { type: 'colorRange', hex }
            if (name) out.name = name
            const tol = clampNum(t.tolerance, 0.02, 1)
            if (tol) out.tolerance = tol
            return out
        }
        case 'region': {
            if (!REGION_AREAS.includes(t.area)) {
                errors.push(`step ${i}: region area must be one of ${REGION_AREAS.join('/')}`)
                return null
            }
            const out = { type: 'region', area: t.area }
            const frac = clampNum(t.fraction, 0.05, 0.95)
            if (frac) out.fraction = frac
            return out
        }
        default:
            return null
    }
}

/* ─── Subject-instance selection (pure — shared with the executor) ───────── */

const bboxArea = (b) => (Array.isArray(b) && b.length === 4 ? Math.max(0, b[2]) * Math.max(0, b[3]) : 0)

/** Classify an {r,g,b} mean into the parser's colour vocabulary. */
export const classifyColor = ({ r, g, b }) => {
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const l = (max + min) / 2
    const d = max - min
    if (d < 28) {
        if (l < 60) return 'black'
        if (l > 200) return 'white'
        return 'gray'
    }
    let h = 0
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = (h * 60 + 360) % 360
    if (h < 15 || h >= 345) return l < 90 && d < 90 ? 'brown' : 'red'
    if (h < 45) return l < 110 ? 'brown' : 'orange'
    if (h < 70) return 'yellow'
    if (h < 165) return 'green'
    if (h < 200) return 'cyan'
    if (h < 255) return 'blue'
    if (h < 290) return 'purple'
    return 'pink'
}

/**
 * Pick detected instances matching a subjects target's labels + qualifiers
 * (position / ordinal / size / color / plural-vs-singular). Pure given the
 * candidate list — the executor injects `colorOf` for colour qualifiers.
 *
 * @returns {{ picked: Array, note: string|null }}
 */
export const pickSubjectInstances = (instances, target, { imageWidth = 0, colorOf = null } = {}) => {
    const labels = (target.labels || []).map((l) => l.toLowerCase())
    let candidates = instances.filter((inst) => {
        const il = String(inst.label || '').toLowerCase()
        return labels.some((l) => il === l || il.includes(l) || l.includes(il))
    })
    if (!candidates.length) return { picked: [], note: null }

    const q = target.qualifiers || {}
    let note = null

    if (q.color && typeof colorOf === 'function') {
        const matched = candidates.filter((inst) => colorOf(inst) === q.color)
        if (matched.length) candidates = matched
        else note = `none of the ${labels.join('/')} looked ${q.color}; used all matches instead`
    }

    const cx = (inst) => inst.centroidImage?.[0] ?? inst.centroid?.[0] ?? 0
    const cy = (inst) => inst.centroidImage?.[1] ?? inst.centroid?.[1] ?? 0
    const area = (inst) => bboxArea(inst.bboxImage || inst.bbox)

    if (q.ordinal) {
        const sorted = [...candidates].sort((a, b) =>
            q.ordinalFrom === 'right' ? cx(b) - cx(a) : cx(a) - cx(b))
        const idx = Math.min(q.ordinal - 1, sorted.length - 1)
        if (q.ordinal > sorted.length) {
            note = `asked for #${q.ordinal} but only ${sorted.length} detected; picked the last one`
        }
        return { picked: [sorted[idx]], note }
    }

    if (q.position) {
        const keys = {
            left: (i) => cx(i),
            right: (i) => -cx(i),
            top: (i) => cy(i),
            bottom: (i) => -cy(i),
            center: (i) => Math.abs(cx(i) - imageWidth / 2),
        }
        const sorted = [...candidates].sort((a, b) => keys[q.position](a) - keys[q.position](b))
        return { picked: [sorted[0]], note }
    }

    if (q.size) {
        const sorted = [...candidates].sort((a, b) =>
            q.size === 'largest' ? area(b) - area(a) : area(a) - area(b))
        return { picked: [sorted[0]], note }
    }

    // No qualifiers. Plural phrase ("the dogs") → every match; a singular
    // phrase with several candidates → the largest, with a note so the agent
    // can offer disambiguation.
    const phrase = String(target.phrase || '')
    const plural = /\b(people|men|women|children|kids|everyone|everybody|dogs|cats|birds|horses|cows|cars|all\b)/i.test(phrase)
        || labels.length > 1
    if (candidates.length > 1 && !plural) {
        const sorted = [...candidates].sort((a, b) => area(b) - area(a))
        note = `${candidates.length} ${labels.join('/')}(s) detected; picked the largest — qualify with position ("on the left") or ordinal ("the second from the left") to target another`
        return { picked: [sorted[0]], note }
    }
    return { picked: candidates, note }
}

/**
 * Validate + sanitise a MaskPlan (from Gemini or the heuristic parser).
 * Returns `{ valid, errors, plan }`; `plan` is always usable when valid.
 */
export const validateMaskPlan = (raw) => {
    const errors = []
    if (!raw || typeof raw !== 'object') {
        return { valid: false, errors: ['plan must be an object'], plan: null }
    }

    const stepsIn = Array.isArray(raw.steps) ? raw.steps.slice(0, 6) : []
    const steps = []
    stepsIn.forEach((s, i) => {
        const target = sanitizeTarget(s?.target, errors, i)
        if (!target) return
        const op = i === 0 ? 'add' : (PLAN_OPS.includes(s?.op) ? s.op : 'add')
        steps.push({ op, target })
    })
    if (!steps.length) errors.push('plan has no usable steps')

    const plan = {
        version: MASK_PLAN_VERSION,
        source: raw.source === 'gemini' ? 'gemini' : 'heuristic',
        fillMode: PLAN_FILL_MODES.includes(raw.fillMode) ? raw.fillMode : 'fill',
        feather: raw.feather == null ? null : clampNum(raw.feather, 0, 0.5, null),
        grow: raw.grow == null ? null : Math.round(clampNum(raw.grow, -200, 200, 0)),
        invert: raw.invert === true,
        steps,
    }
    return { valid: errors.length === 0, errors, plan: errors.length === 0 ? plan : null }
}
