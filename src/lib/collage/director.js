// Composer art direction: a compact spec (structure + finish) that either the
// vision model or the on-device prompt parser writes, and the solvers realise.
// Structure comes from compose.js families; finish (backdrop, harmony, shadow)
// from finish.js. Everything here is pure and validated/clamped.

import { FAMILIES, DEFAULT_SPEC } from './compose'

export const BACKDROP_KINDS = ['field', 'aura', 'echo', 'paper', 'solid']
export const LOOKS = ['natural', 'warm', 'cool', 'moody', 'vintage', 'vivid', 'soft', 'mono']
export const SHAPES = ['subject', 'text', 'heart', 'circle', 'star']

export const DEFAULT_FINISH = {
    backdrop: 'field',
    colors: [],
    grain: 0.15,
    harmony: 0.55,
    look: 'natural',
    shadow: 0.45,
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const num = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : fallback)
const HEX = /^#[0-9a-f]{6}$/i

/** Clamp any (possibly hostile) spec into a safe one. */
export const validateDirection = (raw, { photoCount = 2 } = {}) => {
    const r = raw && typeof raw === 'object' ? raw : {}
    const familyIds = FAMILIES.map((f) => f.id)
    const fits = FAMILIES.filter((f) => photoCount >= f.min && photoCount <= f.max).map((f) => f.id)
    let family = familyIds.includes(r.family) ? r.family : 'auto'
    if (family !== 'auto' && !fits.includes(family)) family = 'auto'
    const order = Array.isArray(r.order)
        ? r.order.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < photoCount)
        : null
    const uniqueOrder = order && new Set(order).size === photoCount && order.length === photoCount ? order : null
    const hero = Number.isInteger(Number(r.hero)) && Number(r.hero) >= 0 && Number(r.hero) < photoCount ? Number(r.hero) : null
    return {
        family,
        seed: Number.isInteger(Number(r.seed)) ? Math.abs(Number(r.seed)) % 100000 : Math.floor(Math.random() * 100000),
        hero,
        order: uniqueOrder,
        gutter: num(r.gutter, 0, 0.08, DEFAULT_SPEC.gutter),
        margin: num(r.margin, 0, 0.2, DEFAULT_SPEC.margin),
        corner: num(r.corner, 0, 0.5, DEFAULT_SPEC.corner),
        angle: r.angle === null || r.angle === undefined || r.angle === '' ? null : num(r.angle, -35, 35, null),
        tilt: num(r.tilt, 0, 20, DEFAULT_SPEC.tilt),
        density: num(r.density, 0.4, 1, DEFAULT_SPEC.density),
        mat: num(r.mat, 0, 0.08, DEFAULT_SPEC.mat),
        blend: num(r.blend, 0.02, 0.14, 0.07),
        shape: SHAPES.includes(r.shape) ? r.shape : (family === 'silhouette' ? 'subject' : null),
        text: typeof r.text === 'string' ? r.text.toUpperCase().replace(/[^A-Z0-9& ]/g, '').trim().slice(0, 12) : '',
        finish: {
            backdrop: BACKDROP_KINDS.includes(r.finish?.backdrop) ? r.finish.backdrop : DEFAULT_FINISH.backdrop,
            colors: Array.isArray(r.finish?.colors) ? r.finish.colors.filter((c) => typeof c === 'string' && HEX.test(c)).slice(0, 4) : [],
            grain: num(r.finish?.grain, 0, 1, DEFAULT_FINISH.grain),
            harmony: num(r.finish?.harmony, 0, 1, DEFAULT_FINISH.harmony),
            look: LOOKS.includes(r.finish?.look) ? r.finish.look : DEFAULT_FINISH.look,
            shadow: num(r.finish?.shadow, 0, 1, DEFAULT_FINISH.shadow),
        },
        title: typeof r.title === 'string' ? r.title.slice(0, 60) : '',
        rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 280) : '',
    }
}

/* ── On-device prompt → direction ─────────────────────────────────────────── */

const FAMILY_CUES = {
    drift: /\b(scatter\w*|polaroids?|prints?|scrapbook|messy|table ?top|pinboard|mood ?board|casual|loose|tossed|overlap\w*|layered prints|journal)\b/,
    shards: /\b(shatter\w*|shards?|broken|glass|stained|voronoi|organic|crystal\w*|fractur\w*|cells|puzzle|mosaic tiles|kaleido\w*|geometric)\b/,
    orbit: /\b(orbit\w*|planet\w*|around|circles?|circular|halo|solar|constellation|round|bubbles?|centered on|revolv\w*)\b/,
    strata: /\b(diagonal\w*|slant\w*|lean\w*|rain|speed|stripes?|bands?|dynamic|motion|energetic|sporty|slash\w*|angled|tilted strips)\b/,
    lens: /\b(windows?|insets?|within|inside|magazine cover|cover story|hero background|picture in picture|layered on|over the (?:main|hero)|poster)\b/,
    mosaic: /\b(grid|clean|gallery|minimal\w*|editorial|tidy|tiles?|mosaic|portfolio|catalog\w*|structured|symmetr\w*|orderly)\b/,
    silhouette: /\b(silhouette|outline|shape of|shaped like|heart[- ]shaped|in (?:a|the) shape|spell\w*|the word|letters|typography|monogram|heart|star[- ]shaped)\b/,
    tapestry: /\b(seamless\w*|blend\w*|dissolv\w*|no borders|borderless blend|melt\w*|tapestry|montage|merge\w*|flow into each other|dreamlike blend)\b/,
}

const LOOK_CUES = [
    ['mono', /\b(black ?(?:and|&) ?white|b\s?&\s?w|monochrome|grayscale|greyscale|noir)\b/],
    ['vintage', /\b(vintage|retro|film|analog\w*|nostalg\w*|faded|70s|80s|90s|kodak|polaroid)\b/],
    ['moody', /\b(moody|cinematic|dramatic|dark|night|brooding|atmospheric|mysterious|gothic)\b/],
    ['warm', /\b(warm|golden|sunset|cozy|cosy|autumn|fall|amber|summer|sunny|earthy)\b/],
    ['cool', /\b(cool|cold|icy|winter|blue hour|ocean|arctic|crisp)\b/],
    ['vivid', /\b(vivid|vibrant|bold|pop|neon|punchy|saturated|colou?rful|playful|fun|party)\b/],
    ['soft', /\b(soft|pastel|dreamy|airy|light|gentle|delicate|romantic|wedding|baby)\b/],
]

const BACKDROP_CUES = [
    ['echo', /\b(blur\w*|echo|depth|immersive|glow from|bokeh)\b/],
    ['paper', /\b(paper|scrapbook|journal|craft|kraft|textured|handmade|zine)\b/],
    ['aura', /\b(aura|gradient|mesh|glow|dreamy|ethereal|nebula|haze)\b/],
    ['solid', /\b(white|plain|solid|flat|gallery wall|museum)\b/],
]

const COLOR_WORDS = {
    black: '#0b0c10', white: '#f7f6f2', cream: '#f3ecdf', ivory: '#f6f1e4', beige: '#e8dcc6', sand: '#d9c7a7',
    red: '#b3261e', crimson: '#8c1c2b', pink: '#f2b8c6', rose: '#d98c9a', coral: '#f27a6b', orange: '#e8833a',
    peach: '#f6c5a4', gold: '#c9a227', golden: '#d4a64a', yellow: '#f2d15c', mustard: '#c9a13b', olive: '#6b7b3a',
    green: '#3f7d58', sage: '#a7b8a0', mint: '#bfe6d3', teal: '#1f7a7a', turquoise: '#3cb8b2', blue: '#2f5d9e',
    navy: '#14213d', sky: '#bcd9f2', indigo: '#3b3f8f', purple: '#6b4c9a', lavender: '#c8b7e6', lilac: '#d7c4ec',
    brown: '#6b4a32', chocolate: '#3d2a1f', grey: '#7a7d82', gray: '#7a7d82', charcoal: '#2b2d31', silver: '#c0c4c8',
}

const pickCue = (text, cues) => cues.find(([, re]) => re.test(text))?.[0] || null

// Vague briefs: an occasion or feeling implies structure and finish when the
// user doesn't name them ("something for mom's birthday", "make it pop").
const INTENTS = [
    { re: /\b(birthday|bday|celebrat\w*|party|fiesta|confetti)\b/, family: 'orbit', look: 'vivid', backdrop: 'aura' },
    { re: /\b(wedding|anniversary|valentine\w*|love|romance|romantic|engage\w*|proposal)\b/, family: 'silhouette', shape: 'heart', look: 'soft', backdrop: 'aura' },
    { re: /\b(trip|travel\w*|vacation|holiday|journey|road ?trip|adventure|backpack\w*)\b/, family: 'strata', look: 'warm', backdrop: 'field' },
    { re: /\b(food|recipe|menu|restaurant|cafe|brunch|dinner|dessert|bakery)\b/, family: 'mosaic', look: 'warm', backdrop: 'paper' },
    { re: /\b(memorial|remember\w*|tribute|in loving memory|rip|funeral)\b/, family: 'lens', look: 'soft', backdrop: 'echo' },
    { re: /\b(baby|newborn|toddler|kids?|children|family)\b/, family: 'orbit', look: 'soft', backdrop: 'aura' },
    { re: /\b(graduation|portfolio|resume|professional|corporate|business|brand|product)\b/, family: 'mosaic', look: 'natural', backdrop: 'solid' },
    { re: /\b(pets?|dogs?|puppy|puppies|cats?|kitten)\b/, family: 'drift', look: 'warm', backdrop: 'paper' },
    { re: /\b(nature|landscape|mountains?|ocean|beach|forest|outdoors?|hike|hiking)\b/, family: 'tapestry', look: 'natural', backdrop: 'echo' },
    { re: /\b(dump|recap|year in review|highlights?|best of|memories|throwback)\b/, family: 'drift', look: 'vintage', backdrop: 'paper' },
    { re: /\b(pop|cool|fun|lit|fire|sick|eye[- ]?catching|stand ?out|wow)\b/, look: 'vivid', backdrop: 'aura' },
    { re: /\b(classy|elegant|luxur\w*|premium|sophisticated|refined|timeless|chic)\b/, family: 'mosaic', look: 'moody', backdrop: 'solid', airy: true },
    { re: /\b(cute|adorable|sweet|lovely|pretty|nice|beautiful|aesthetic)\b/, look: 'soft', backdrop: 'aura' },
    { re: /\b(calm|peaceful|minimal\w*|simple|quiet|zen|clean)\b/, look: 'natural', backdrop: 'solid', airy: true },
    { re: /\b(artsy|creative|different|unique|experimental|weird|abstract|surprise me|something new)\b/, family: 'shards', look: 'vivid', backdrop: 'aura' },
]

/**
 * Deterministic prompt parser (no network). Handles compound briefs, negations
 * ("no shadows", "not dark"), spacing words, ordinal hero picks ("second photo
 * as the star") and colour words.
 */
export const directionFromPrompt = (prompt, { photoCount = 2, seed } = {}) => {
    const text = String(prompt || '').toLowerCase()
    const negated = (re) => new RegExp(`\\b(?:no|not|without|avoid|never|less)\\s+(?:any\\s+|too\\s+)?(?:${re.source.replace(/^\\b\(|\)\\b$/g, '')})\\b`).test(text)

    const scores = Object.fromEntries(Object.keys(FAMILY_CUES).map((k) => [k, (text.match(new RegExp(FAMILY_CUES[k].source, 'g')) || []).length]))
    for (const k of Object.keys(scores)) if (negated(FAMILY_CUES[k])) scores[k] = -1
    const fits = FAMILIES.filter((f) => photoCount >= f.min && photoCount <= f.max).map((f) => f.id)
    const ranked = Object.entries(scores).filter(([k, v]) => v > 0 && fits.includes(k)).sort((a, b) => b[1] - a[1])
    const intent = INTENTS.find((it) => it.re.test(text) && !negated(it.re))
    const intentFamily = intent?.family && fits.includes(intent.family) ? intent.family : null
    const family = ranked[0]?.[0] || intentFamily || 'auto'

    // Strongest look wins (most cue words); ties go to the earliest mention.
    let look = null, lookScore = 0, lookPos = Infinity
    for (const [id, re] of LOOK_CUES) {
        if (negated(re)) continue
        const hits = [...text.matchAll(new RegExp(re.source, 'g'))]
        if (!hits.length) continue
        const pos = hits[0].index
        if (hits.length > lookScore || (hits.length === lookScore && pos < lookPos)) { look = id; lookScore = hits.length; lookPos = pos }
    }
    if (!look && intent?.look) look = intent.look
    let backdrop = pickCue(text, BACKDROP_CUES)
    if (backdrop && negated(BACKDROP_CUES.find(([id]) => id === backdrop)[1])) backdrop = null
    if (!backdrop && intent?.backdrop) backdrop = intent.backdrop

    const colorText = text.replace(/\bblack ?(?:and|&) ?white\b/g, ' ')
    const colors = Object.keys(COLOR_WORDS)
        .filter((w) => new RegExp(`\\b${w}\\b`).test(colorText) && !new RegExp(`\\b(?:no|not|without)\\s+${w}\\b`).test(colorText))
        .map((w) => COLOR_WORDS[w])

    // Silhouette container: word > symbol > subject outline.
    const raw = String(prompt || '')
    const quoted = raw.match(/(?:spell(?:s|ing)?|word|letters|say(?:s|ing)?|reads?)\s+["“'‘]([A-Za-z0-9& ]{1,12})["”'’]/i)
        || raw.match(/(?:spell(?:s|ing)?|word|letters|say(?:s|ing)?|reads?)\s+([A-Za-z0-9&]{1,12})\b/i)
    let shape = null, word = ''
    if (quoted && /spell|word|letters|say|read/i.test(text)) { shape = 'text'; word = quoted[1] }
    else if (/\bheart\b/.test(text)) shape = 'heart'
    else if (/\bstar[- ]shaped|shape of a star\b/.test(text)) shape = 'star'
    else if (/\b(circle|round) shape|circular shape\b/.test(text)) shape = 'circle'
    else if (/\b(silhouette|outline|shape of (?:the|my|our)|shaped like (?:the|my|our))\b/.test(text)) shape = 'subject'
    if (!shape && !ranked.length && intent?.shape && family === 'silhouette') shape = intent.shape

    const spacing = /\b(tight|seamless|no gaps?|edge to edge|full bleed|borderless|packed)\b/.test(text) ? 'tight'
        : /\b(airy|spacious|breathing room|lots of space|generous|roomy|whitespace)\b/.test(text) || intent?.airy ? 'airy' : null
    const noShadow = /\b(?:no|without|flat)\s+(?:drop\s+)?shadows?\b|\bflat\b/.test(text)
    const round = /\b(rounded|soft corners|pill|curvy)\b/.test(text)
    const sharp = /\b(sharp corners|square corners|crisp edges|hard edges)\b/.test(text)
    const messy = /\b(messy|chaotic|wild|dramatic tilt|very tilted)\b/.test(text)
    const neat = /\b(neat|straight|aligned|no tilt|level)\b/.test(text)

    const ordinals = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5, last: photoCount - 1 }
    let hero = null
    const heroM = text.match(/\b(first|second|third|fourth|fifth|sixth|last)\s+(?:photo|image|picture|shot|one)\b[^.]*\b(?:star|hero|focus|main|biggest|largest|centre|center|highlight)/)
        || text.match(/\b(?:star|hero|focus|main|biggest|largest|highlight)\b[^.]*\b(first|second|third|fourth|fifth|sixth|last)\s+(?:photo|image|picture|shot|one)\b/)
    if (heroM) hero = ordinals[heroM[1]]
    const photoN = text.match(/\bphoto\s*#?\s*(\d{1,2})\b[^.]*\b(?:star|hero|focus|main|biggest)\b/)
    if (hero === null && photoN) hero = Number(photoN[1]) - 1

    const lookHarmony = { mono: 1, vintage: 0.8, moody: 0.75, warm: 0.7, cool: 0.7, vivid: 0.5, soft: 0.65, natural: 0.5 }
    const dark = look === 'moody' || look === 'mono' || /\b(dark|black|night)\b/.test(text)
    const finish = {
        look: look || 'natural',
        backdrop: backdrop || (look === 'vintage' ? 'paper' : look === 'moody' ? 'echo' : look === 'soft' ? 'aura' : 'field'),
        colors: colors.length ? colors : (dark && !/\bnot dark\b/.test(text) ? ['#0d0e12'] : []),
        grain: look === 'vintage' ? 0.6 : look === 'moody' ? 0.35 : /\b(grain|grainy|texture)\b/.test(text) ? 0.5 : 0.12,
        harmony: /\b(match|cohesive|consistent|unified|same look|harmon\w*)\b/.test(text) ? 0.85 : lookHarmony[look || 'natural'],
        shadow: noShadow ? 0 : family === 'drift' ? 0.7 : 0.45,
    }
    return validateDirection({
        family: shape && fits.includes('silhouette') ? 'silhouette' : family,
        shape,
        text: word,
        seed: Number.isInteger(seed) ? seed : undefined,
        hero,
        gutter: spacing === 'tight' ? 0 : spacing === 'airy' ? 0.04 : undefined,
        margin: spacing === 'tight' ? 0 : spacing === 'airy' ? 0.09 : undefined,
        corner: round ? 0.16 : sharp ? 0 : undefined,
        tilt: messy ? 15 : neat ? 1.5 : undefined,
        density: spacing === 'airy' ? 0.55 : spacing === 'tight' ? 0.9 : undefined,
        finish,
        title: '',
        rationale: text ? `Parsed on-device from “${String(prompt).slice(0, 80)}”` : '',
    }, { photoCount })
}

/* ── Vision model (Gemini) contract ─────────────────────────────────────────── */

export const buildDirectorSystemPrompt = () => [
    'You are a world-class photo editor and art director designing ONE-OF-A-KIND photo collages.',
    'You never use stock templates. You compose from what is IN the photos: subjects, gaze, lines, colour, story.',
    'You design with a composition engine that solves geometry for you. You choose structure and finish:',
    '- family: mosaic (subject-safe tiling), shards (organic weighted cells), strata (slanted bands; angle leans with the photos), orbit (hero disc with photos in orbit), drift (overlapping real prints, subjects never covered), lens (hero full-bleed with other photos set into its empty space), silhouette (every photo packed INSIDE a shape: the hero subject\'s own outline, a word, or a heart/circle/star), tapestry (no borders; photos dissolve into each other along low-contrast seams).',
    '- silhouette only: shape = subject | text | heart | circle | star; text = the word to spell (max 12 letters) when shape is text. blend (0.02–0.14) = tapestry seam softness.',
    '- hero: index of the emotional anchor photo (faces, eye contact, peak moment). order: storytelling sequence of ALL photo indices.',
    '- gutter/margin (0–0.08 / 0–0.2 of the short side), corner (0–0.5), angle (-35..35, strata only; null = derive), tilt (0–20, drift), density (0.4–1), mat (0–0.08, print border).',
    '- finish: backdrop (field = palette gradient, aura = soft colour glow, echo = blurred hero, paper = textured stock, solid), colors (hex drawn from the photos or the brief), grain 0–1, harmony 0–1 (how strongly to unify the photos’ colour), look (natural, warm, cool, moody, vintage, vivid, soft, mono), shadow 0–1.',
    'Honour every constraint in the brief, including negations and numbers. When the brief conflicts with the photos, keep subjects safe and explain the trade-off in rationale.',
    'Briefs are often vague ("make it nice", "for mom", "something cool", typos, slang, emojis). Infer the occasion and emotion from the words AND the photos, then commit to bold, specific choices. Never answer vagueness with a plain grid.',
    'When photoCount is 0 or photos are missing, design an empty template for the given slot count from the brief alone.',
    'Each direction must be genuinely different in concept, not a parameter tweak. Give each a short evocative title (no generic names like "Grid" or "Collage").',
    'Be concise: title ≤ 5 words, rationale ≤ 30 words, story ≤ 25 words, at most 4 colors, order lists each photo index exactly once. Output nothing but the JSON object.',
].join('\n')

export const buildDirectorUserText = ({ prompt, photoCount, canvasAspect, analyses = [], count = 3 }) => {
    const photos = analyses.slice(0, 12).map((a, i) => (
        `Photo ${i + 1} (index ${i}): aspect ${a.aspect.toFixed(2)}, subject box x ${a.box.x0.toFixed(2)}–${a.box.x1.toFixed(2)} y ${a.box.y0.toFixed(2)}–${a.box.y1.toFixed(2)}, `
        + `calm space ${Math.round(a.calm.area * 100)}% (open ${a.openSide}), lines ${Math.round(a.lineAngle)}° strength ${a.lineStrength.toFixed(2)}, `
        + `luminance ${a.luminance.toFixed(2)}, palette ${a.palette.slice(0, 3).map((c) => c.hex).join(' ')}, quality ${a.quality.toFixed(2)}`
    )).join('\n')
    return [
        `Brief: ${prompt ? `"${String(prompt).slice(0, 400)}"` : '(none — surprise me with your best art direction)'}`,
        `Photo count: ${photoCount}. Canvas aspect (w/h): ${Number(canvasAspect || 1).toFixed(2)}.`,
        'On-device analysis:',
        photos,
        `Return exactly ${count} directions.`,
    ].join('\n')
}

export const buildDirectorSchema = () => ({
    type: 'object',
    properties: {
        story: { type: 'string' },
        directions: {
            type: 'array',
            maxItems: 4,
            items: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    rationale: { type: 'string' },
                    family: { type: 'string', enum: FAMILIES.map((f) => f.id) },
                    hero: { type: 'integer' },
                    order: { type: 'array', items: { type: 'integer' }, maxItems: 16 },
                    gutter: { type: 'number' },
                    margin: { type: 'number' },
                    corner: { type: 'number' },
                    angle: { type: 'number', nullable: true },
                    tilt: { type: 'number' },
                    density: { type: 'number' },
                    mat: { type: 'number' },
                    blend: { type: 'number' },
                    shape: { type: 'string', enum: SHAPES, nullable: true },
                    text: { type: 'string' },
                    finish: {
                        type: 'object',
                        properties: {
                            backdrop: { type: 'string', enum: BACKDROP_KINDS },
                            colors: { type: 'array', items: { type: 'string' }, maxItems: 4 },
                            grain: { type: 'number' },
                            harmony: { type: 'number' },
                            look: { type: 'string', enum: LOOKS },
                            shadow: { type: 'number' },
                        },
                        required: ['backdrop', 'harmony', 'look'],
                    },
                },
                required: ['title', 'family', 'hero', 'finish', 'rationale'],
            },
        },
    },
    required: ['directions'],
})
