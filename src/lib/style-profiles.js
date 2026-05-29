// Curated target adjustment vectors per style. Each profile expresses, in the
// professional-image-filters.js value units, what an experienced editor would
// apply to a neutral image to reach that style. The deterministic planner
// scales these by `gain` and adds an optional correction layer.
//
// Adjustment key → value units (from src/lib/professional-image-filters.js):
//   brightness / contrast / saturation / vibrance: -100..+100
//   temperature: -100..+100 (positive = warmer)
//   sharpness:   0..+100
//   blur:        0..+100
//   noise:       0..+100 (used here for film grain feel)
//   gamma:       20..220 (default 100; <100 darkens midtones, >100 lifts them)
//   hue:         -180..+180
//
// Adding a new style? You MUST add an entry to STYLE_KEYS, STYLE_LABELS,
// STYLE_PROFILES, STYLE_DESCRIPTORS, and STYLE_VOCABULARY. route.js builds
// the Gemini prompt and keyword router from these tables, so a missing entry
// will silently fail to route correctly.

export const STYLE_KEYS = [
    // ── Generic looks (broad fallbacks) ──────────────────────────────────
    "neutral",
    "cinematic",
    "editorial",
    "vibrant",
    "vintage",
    "studio",
    "warm-portrait",
    "bw-classic",
    // ── Specific film stocks ─────────────────────────────────────────────
    "kodachrome",        // Rich slide film — Nat Geo look
    "kodak-portra",      // Warm, soft, wedding/portrait staple
    "fuji-pro400h",      // Cool dreamy pastels, magenta shadows
    "cinestill-800t",    // Halation, tungsten-balanced, urban night cinematic
    "polaroid",          // Instant film, low contrast, soft color cast
    "super8",            // 8mm home movie — heavy grain, very warm, faded
    "bw-tri-x",          // Pushed Tri-X 400 — gritty high-contrast B&W
    // ── Specific cameras ─────────────────────────────────────────────────
    "red-cinema",        // RED Dragon/Helium/Monstro — flat, clean, controlled
    "arri-alexa",        // Natural skin tones, organic, balanced
    "vhs-tape",          // Camcorder/VHS — low-fi, oversaturated, blurry, noisy
    // ── Time-of-day / mood looks ─────────────────────────────────────────
    "golden-hour",       // Sun-soaked warmth, lifted shadows, glow
    "faded-pastel",      // Washed-out, milky, ig-aesthetic
    // ── Creative color grades & moods (broad vague-prompt coverage) ───────
    "moody-dark",        // Low-key, dramatic, crushed shadows
    "bright-airy",       // High-key, light, lifted, lifestyle/wedding
    "matte-film",        // Flat matte, lifted blacks, low contrast
    "hdr-clarity",       // Punchy detail, clarity, dehazed
    "teal-orange",       // Blockbuster complementary grade
    "neo-noir",          // Dark color noir — cyan cast, crushed, dramatic
    "sepia",             // Warm brown antique tone
    "cyberpunk",         // Neon teal/magenta, saturated night
    "dreamy-glow",       // Soft hazy bloom, ethereal
    "autumn",            // Warm oranges & reds, fall tones
    "cold-winter",       // Cool blue, icy, desaturated
    "tropical",          // Vivid sunny greens & blues
    "cross-process",     // Cyan shadows, yellow highlights, punchy
    "bleach-bypass",     // Silvery desaturated high contrast
    "technicolor",       // Rich vivid old-Hollywood 3-strip
    "lomography",        // Oversaturated, contrasty, lo-fi toy camera
    "earthy-muted",      // Desaturated warm earth tones
]

export const STYLE_LABELS = {
    neutral: "Neutral",
    cinematic: "Cinematic",
    editorial: "Editorial",
    vibrant: "Vibrant",
    vintage: "Vintage",
    studio: "Studio",
    "warm-portrait": "Warm Portrait",
    "bw-classic": "Classic B&W",
    kodachrome: "Kodachrome",
    "kodak-portra": "Kodak Portra",
    "fuji-pro400h": "Fuji Pro 400H",
    "cinestill-800t": "CineStill 800T",
    polaroid: "Polaroid",
    super8: "Super 8",
    "bw-tri-x": "Tri-X B&W",
    "red-cinema": "RED Cinema",
    "arri-alexa": "ARRI Alexa",
    "vhs-tape": "VHS Tape",
    "golden-hour": "Golden Hour",
    "faded-pastel": "Faded Pastel",
    "moody-dark": "Moody Dark",
    "bright-airy": "Bright & Airy",
    "matte-film": "Matte Film",
    "hdr-clarity": "HDR Clarity",
    "teal-orange": "Teal & Orange",
    "neo-noir": "Neo Noir",
    sepia: "Sepia",
    cyberpunk: "Cyberpunk",
    "dreamy-glow": "Dreamy Glow",
    autumn: "Autumn",
    "cold-winter": "Cold Winter",
    tropical: "Tropical",
    "cross-process": "Cross Process",
    "bleach-bypass": "Bleach Bypass",
    technicolor: "Technicolor",
    lomography: "Lomography",
    "earthy-muted": "Earthy Muted",
}

// Adjustment ranges + sane min/max for the UI sliders.
// Keep these aligned with the buildEditPlan output entries so the agent UI can
// render sliders directly from the plan.
export const ADJUSTMENT_RANGES = {
    brightness: { min: -100, max: 100, neutral: 0, label: "Brightness" },
    contrast: { min: -100, max: 100, neutral: 0, label: "Contrast" },
    saturation: { min: -100, max: 100, neutral: 0, label: "Saturation" },
    vibrance: { min: -100, max: 100, neutral: 0, label: "Vibrance" },
    temperature: { min: -100, max: 100, neutral: 0, label: "Temperature" },
    gamma: { min: 20, max: 220, neutral: 100, label: "Gamma" },
    sharpness: { min: 0, max: 100, neutral: 0, label: "Sharpness" },
    blur: { min: 0, max: 100, neutral: 0, label: "Blur" },
    noise: { min: 0, max: 100, neutral: 0, label: "Grain" },
    hue: { min: -180, max: 180, neutral: 0, label: "Hue" },
}

// Target adjustments per style. Anything not listed is treated as the neutral default.
// Comments explain *why* each effect is included so the "Why" tooltip can quote them.
//
// Calibration notes:
// • Magnitudes are sized for gain=1.0; the planner scales by Gemini's reported gain.
// • Avoid stacking heavy contrast + heavy gamma on the same style — they fight.
// • Grain (noise) is the cheapest "film feel" knob; use generously on analog looks.
// • For B&W styles, saturation: -100 is non-negotiable (full desaturation).
export const STYLE_PROFILES = {
    neutral: {},

    // ── Generic looks ────────────────────────────────────────────────────
    cinematic: {
        contrast: 22,           // crushed-blacks contrast
        saturation: -8,         // desaturated film look
        temperature: 10,        // subtle warmth
        gamma: 90,              // slight midtone roll-off
        sharpness: 6,
    },
    editorial: {
        contrast: 12,
        saturation: 4,
        sharpness: 14,          // crisp magazine look
        vibrance: 6,
    },
    vibrant: {
        contrast: 8,
        saturation: 22,
        vibrance: 18,           // boost muted tones more than primary tones
        brightness: 4,
    },
    vintage: {
        contrast: -8,
        saturation: -16,
        temperature: 14,
        gamma: 112,             // lifted blacks
        noise: 8,               // light film grain
    },
    studio: {
        contrast: 8,
        brightness: 4,
        saturation: -4,
        sharpness: 10,
    },
    "warm-portrait": {
        contrast: 6,
        saturation: 4,
        vibrance: 8,
        temperature: 12,        // warm skin
        sharpness: 6,
    },
    "bw-classic": {
        contrast: 18,
        saturation: -100,       // full desaturate
        brightness: 2,
        sharpness: 6,
    },

    // ── Specific film stocks ─────────────────────────────────────────────
    kodachrome: {
        // Rich saturated slide film — National Geographic / 1970s magazine look.
        // Snappy contrast, pulled-up reds and blues, warm cast, very fine grain.
        contrast: 16,
        saturation: 14,         // rich but not vibrant — controlled punch
        vibrance: 10,           // brings out subdued tones
        temperature: 8,         // golden warmth
        sharpness: 8,
        noise: 4,               // fine slide-film grain
    },
    "kodak-portra": {
        // Soft, warm, dreamy. The portrait/wedding film par excellence.
        // Low contrast, gently lifted shadows, beautiful skin tones, fine grain.
        contrast: -4,
        saturation: 2,          // subtle — Portra is famously "natural"
        vibrance: 8,             // boost muted tones for skin without over-pop
        temperature: 12,         // warm cast
        gamma: 108,              // gently lifted shadows
        sharpness: 4,
        noise: 3,                // fine 400-speed grain
    },
    "fuji-pro400h": {
        // Cool, dreamy, pastel. Magenta shadows, faded highlights, soft greens.
        contrast: -6,
        saturation: -4,
        temperature: -8,         // cool overall
        gamma: 115,              // lifted shadows for dreamy feel
        hue: 6,                  // gentle nudge toward magenta/green palette
        vibrance: 6,
        sharpness: 4,
        noise: 4,
    },
    "cinestill-800t": {
        // Tungsten-balanced motion picture film. Halation around bright lights,
        // cool overall, magenta-pink shadows, visible grain, cinematic urban night.
        // We approximate halation with lifted blacks + slight bloom feel.
        contrast: -2,            // soft to suggest halation glow
        saturation: -8,
        temperature: -6,         // tungsten balance reads cool in daylight
        gamma: 110,              // lifted shadows for that magenta wash
        hue: 4,                  // pinkish shadow shift
        vibrance: 4,
        sharpness: 4,
        noise: 14,               // visible cinematic grain
    },
    polaroid: {
        // Heavy lifted blacks, very low contrast, color cast, soft, dreamy.
        contrast: -16,
        saturation: -22,         // faded
        temperature: 6,          // subtle warmth (SX-70 varies; this is the common look)
        gamma: 118,              // strongly lifted blacks — Polaroid signature
        blur: 3,                 // soft lens character
        sharpness: 0,
        noise: 6,
    },
    super8: {
        // 8mm home-movie look: very warm, soft, faded, heavy grain. 1970s nostalgia.
        contrast: -12,
        saturation: -18,
        temperature: 18,         // strong warm cast
        gamma: 122,              // very lifted shadows — faded
        blur: 4,                 // soft 8mm lens
        sharpness: 0,
        noise: 18,               // heavy projected grain
    },
    "bw-tri-x": {
        // Tri-X 400 pushed 1–2 stops: high-contrast street photography B&W with
        // signature gritty grain. Think Daido Moriyama / classic Magnum.
        contrast: 28,
        saturation: -100,        // full B&W
        brightness: 4,
        gamma: 92,                // mild S-curve, slight crushed shadows
        sharpness: 10,
        noise: 18,                // visible pushed-development grain
    },

    // ── Specific cameras ─────────────────────────────────────────────────
    "red-cinema": {
        // Modern digital cinema — RED Dragon/Helium/Monstro in IPP2.
        // Clean, sharp, controlled contrast, slight teal cast in shadows from
        // common grade. Not warm — modern digital looks slightly cool.
        contrast: 12,
        saturation: -6,           // controlled, not popping
        temperature: 2,           // very slight warmth
        gamma: 96,                // gentle toe roll
        hue: -4,                  // approximation of teal shadow shift
        sharpness: 10,            // high-res digital sharpness
        vibrance: 4,
    },
    "arri-alexa": {
        // ARRI's color science is famous for natural skin tones and organic
        // highlight roll-off. Subtle warm grade, balanced, never clinical.
        contrast: 8,
        saturation: 2,
        temperature: 6,           // gentle warmth
        gamma: 102,               // very gentle lift
        sharpness: 6,             // sharp but not over-processed
        vibrance: 4,
    },
    "vhs-tape": {
        // 80s/90s camcorder: heavy color bleed, blurry, low-fi, oversaturated
        // in the wrong way, visible noise/chroma.
        contrast: -10,
        saturation: 14,           // oversaturated bleed
        temperature: 4,
        gamma: 115,               // washed out
        hue: 6,                   // slight greenish/yellow bleed
        blur: 6,                  // low-res softness
        sharpness: 0,
        noise: 20,                // heavy chroma noise
    },

    // ── Time-of-day / mood looks ─────────────────────────────────────────
    "golden-hour": {
        // Sun-soaked warmth: warm overall, lifted shadows from rim light,
        // glowing highlights, soft contrast.
        contrast: 6,
        saturation: 8,
        temperature: 18,         // strong warmth
        gamma: 108,              // lifted shadows from indirect bounce light
        vibrance: 10,            // brings out warm yellows/oranges
        sharpness: 4,
    },
    "faded-pastel": {
        // Heavily desaturated, lifted, soft pastel tones, milky.
        // Common in modern wedding / ig-aesthetic post-processing.
        contrast: -14,
        saturation: -22,
        vibrance: -4,
        temperature: 4,
        gamma: 122,              // strongly lifted blacks for milky feel
        sharpness: 2,
        noise: 3,
    },

    // ── Creative color grades & moods ────────────────────────────────────
    "moody-dark": {
        // Low-key, brooding, dramatic. Crushed shadows, muted color, cool cast.
        contrast: 20,
        saturation: -12,
        brightness: -8,
        temperature: -4,
        gamma: 86,               // darkened midtones
        sharpness: 6,
    },
    "bright-airy": {
        // High-key lifestyle/wedding look — light, soft, lifted, gently warm.
        brightness: 12,
        contrast: -6,
        saturation: -4,
        vibrance: 6,
        temperature: 4,
        gamma: 112,              // lifted for airy feel
    },
    "matte-film": {
        // Flat matte finish — lifted blacks, low contrast, faint warm grain.
        contrast: -14,
        saturation: -10,
        temperature: 4,
        gamma: 120,
        noise: 4,
    },
    "hdr-clarity": {
        // Punchy local detail / clarity / dehaze — crisp and dimensional.
        contrast: 18,
        saturation: 6,
        vibrance: 16,
        sharpness: 18,
        gamma: 96,
    },
    "teal-orange": {
        // Blockbuster complementary grade: warm skin, teal shadows.
        contrast: 16,
        saturation: 6,
        vibrance: 8,
        temperature: 10,
        hue: -6,                 // nudges shadows toward teal
        gamma: 94,
        sharpness: 4,
    },
    "neo-noir": {
        // Dark COLOR noir — desaturated, cyan/teal cast, crushed, dramatic.
        contrast: 26,
        saturation: -20,
        brightness: -6,
        temperature: -8,
        hue: -6,
        gamma: 84,
        sharpness: 6,
    },
    sepia: {
        // Warm antique brown tone — near-monochrome with a strong warm cast.
        saturation: -70,
        temperature: 30,
        hue: 16,                 // bias remaining color toward warm brown
        contrast: 6,
        gamma: 104,
        noise: 4,
    },
    cyberpunk: {
        // Neon night — saturated, cool base with magenta/teal neon punch.
        contrast: 18,
        saturation: 26,
        vibrance: 14,
        temperature: -10,
        hue: 10,
        gamma: 92,
        sharpness: 6,
    },
    "dreamy-glow": {
        // Soft ethereal bloom — hazy highlights, lifted, gentle warmth.
        contrast: -10,
        saturation: 4,
        vibrance: 8,
        temperature: 6,
        gamma: 116,
        blur: 4,                 // soft glow
        sharpness: 0,
    },
    autumn: {
        // Warm fall palette — oranges and reds, gentle warmth, mild punch.
        saturation: 10,
        vibrance: 10,
        temperature: 22,
        hue: -8,                 // rotate greens toward warm gold
        contrast: 6,
    },
    "cold-winter": {
        // Cool icy palette — blue cast, slightly desaturated, crisp.
        saturation: -10,
        vibrance: 4,
        temperature: -22,
        hue: 6,
        contrast: 8,
        sharpness: 4,
    },
    tropical: {
        // Vivid sunny — lush greens/blues, bright, punchy.
        saturation: 22,
        vibrance: 18,
        temperature: 6,
        contrast: 10,
        brightness: 4,
        sharpness: 6,
    },
    "cross-process": {
        // Cross-processed film — high contrast, cyan shadows, yellow highlights.
        contrast: 22,
        saturation: 18,
        temperature: -6,
        hue: 10,
        gamma: 108,
        noise: 6,
    },
    "bleach-bypass": {
        // Silver-retention look — heavily desaturated, very high contrast, metallic.
        contrast: 30,
        saturation: -40,
        brightness: 2,
        gamma: 92,
        sharpness: 8,
    },
    technicolor: {
        // Rich 3-strip old-Hollywood color — deeply saturated, snappy, warm.
        contrast: 18,
        saturation: 30,
        vibrance: 10,
        temperature: 6,
        gamma: 98,
        sharpness: 6,
    },
    lomography: {
        // Toy-camera lo-fi — oversaturated, contrasty, grainy, slightly soft.
        contrast: 18,
        saturation: 22,
        vibrance: 8,
        gamma: 96,
        blur: 2,
        noise: 10,
    },
    "earthy-muted": {
        // Desaturated warm earth tones — terracotta, sage, organic and calm.
        saturation: -14,
        vibrance: -2,
        temperature: 10,
        contrast: -2,
        gamma: 104,
    },
}

// Human-readable rationale, displayed in the UI as the "why" hint per effect.
export const ADJUSTMENT_REASONS = {
    brightness: "Lifts or darkens the overall exposure.",
    contrast: "Increases separation between shadows and highlights.",
    saturation: "Pulls color intensity up or down.",
    vibrance: "Boosts muted colors without over-saturating already-vivid ones.",
    temperature: "Shifts the white balance warmer or cooler.",
    gamma: "Reshapes midtones — lifts or compresses the middle range.",
    sharpness: "Adds local edge contrast to make details crisper.",
    blur: "Softens edges and detail.",
    noise: "Adds fine grain for a filmic texture.",
    hue: "Rotates the entire color wheel.",
}

// Concrete characteristics and trigger guidance for each style. Consumed by
// route.js to build the Gemini system prompt — keeping it data-driven means
// adding a new style automatically updates the model's vocabulary.
//
//   characteristics: what the look LOOKS LIKE (model uses this to classify)
//   whenToPick:      cues for when to choose this key over a more generic one
export const STYLE_DESCRIPTORS = {
    neutral: {
        characteristics: "Normal, well-balanced, no specific look",
        whenToPick: "Image looks natural; user did not request a creative style",
    },
    cinematic: {
        characteristics: "Crushed blacks, slight desaturation, teal/orange grade, subtle grain",
        whenToPick: 'Generic "cinematic", "filmic", "movie look", or "hollywood" with no specific camera/film named',
    },
    editorial: {
        characteristics: "Crisp detail, punchy controlled contrast, polished, magazine-ready",
        whenToPick: '"editorial", "magazine", "lookbook", "premium polish", "fashion shoot"',
    },
    vibrant: {
        characteristics: "High saturation, bright, punchy colors",
        whenToPick: '"vibrant", "vivid", "punchy", "pop", "make it pop"',
    },
    vintage: {
        characteristics: "Generic vintage/retro — lifted blacks, faded contrast, warm cast, light grain",
        whenToPick: 'Generic "vintage" or "retro" with NO specific film/era named — last-resort fallback',
    },
    studio: {
        characteristics: "Clean, balanced, slight sharpness, subtle desaturation — product photography",
        whenToPick: '"studio", "clean", "product", "commercial", "white background"',
    },
    "warm-portrait": {
        characteristics: "Warm skin tones, gentle contrast, slight vibrance boost",
        whenToPick: '"portrait", "headshot", "warm skin", "cozy"',
    },
    "bw-classic": {
        characteristics: "Full desaturation, strong contrast, clean modern B&W",
        whenToPick: 'Generic "black and white", "b&w", "monochrome", "greyscale" without "grainy" or "Tri-X"',
    },
    kodachrome: {
        characteristics: "Rich saturated reds and blues, golden warmth, fine grain, snappy contrast — 1970s Nat Geo look",
        whenToPick: '"Kodachrome", "National Geographic film", "rich slide film", "1960s/70s magazine"',
    },
    "kodak-portra": {
        characteristics: "Warm, soft contrast, low saturation, dreamy skin tones, fine grain",
        whenToPick: '"Portra", "Kodak Portra", "wedding film", "soft warm portrait film"',
    },
    "fuji-pro400h": {
        characteristics: "Cool dreamy greens, magenta shadows, faded highlights, gentle pastel",
        whenToPick: '"Fuji Pro 400H", "Pro 400H", "Fuji film look", "soft green pastel film"',
    },
    "cinestill-800t": {
        characteristics: "Halation/glow around bright lights, cool overall, magenta-pink shadows, visible grain — urban night cinematic",
        whenToPick: '"CineStill", "800T", "tungsten film", "halation", "neon film", "urban night film"',
    },
    polaroid: {
        characteristics: "Heavily lifted blacks, very low contrast, color cast, faded, dreamy, soft focus",
        whenToPick: '"Polaroid", "SX-70", "instant film", "instant camera", "Instax"',
    },
    super8: {
        characteristics: "Very warm cast, heavy projected grain, soft, faded shadows — old home-movie look",
        whenToPick: '"Super 8", "16mm", "8mm film", "old home movie", or generic "old camera" / "old photo" with no specific film',
    },
    "bw-tri-x": {
        characteristics: "High-contrast gritty B&W with heavy grain — pushed Tri-X 400 street look",
        whenToPick: '"Tri-X", "pushed B&W", "street photography B&W", "noir film", "grainy black and white"',
    },
    "red-cinema": {
        characteristics: "Flat clean contrast, controlled highlights, slight teal in shadows, sharp detail — modern digital cinema",
        whenToPick: '"shot on RED", "RED camera", "RED Dragon/Helium/Monstro/Komodo", "IPP2", "RED gamut" — DO NOT fall back to generic "cinematic" when user names RED',
    },
    "arri-alexa": {
        characteristics: "Natural skin tones, balanced gentle warm grade, organic highlight roll-off",
        whenToPick: '"ARRI", "Alexa", "Alexa Mini", "Log-C", "ARRI Log", "natural cinema"',
    },
    "vhs-tape": {
        characteristics: "Low contrast, oversaturated chroma bleed, soft/blurry, heavy noise — 80s/90s home video",
        whenToPick: '"VHS", "camcorder", "analog video", "video tape", "tracking lines", "lo-fi video"',
    },
    "golden-hour": {
        characteristics: "Warm overall, lifted shadows, glowing highlights, slight haze",
        whenToPick: '"golden hour", "magic hour", "sunset glow", "sun-soaked", "warm glow"',
    },
    "faded-pastel": {
        characteristics: "Heavily desaturated, lifted blacks, soft milky pastel tones",
        whenToPick: '"pastel", "washed out", "milky", "ig aesthetic", "Instagram aesthetic", "faded pastel"',
    },
    "moody-dark": {
        characteristics: "Low-key, dark, brooding, crushed shadows, muted desaturated color, cool cast",
        whenToPick: '"moody", "dark and moody", "low key", "brooding", "somber", "dramatic dark"',
    },
    "bright-airy": {
        characteristics: "High-key, light, lifted shadows, soft contrast, gentle warmth — clean lifestyle/wedding",
        whenToPick: '"bright and airy", "airy", "high key", "light and bright", "clean bright", "fresh"',
    },
    "matte-film": {
        characteristics: "Flat matte finish, lifted/faded blacks, low contrast, faint grain",
        whenToPick: '"matte", "flat", "faded matte", "lifted blacks", "VSCO matte"',
    },
    "hdr-clarity": {
        characteristics: "Punchy local detail, clarity, dehazed, crisp and dimensional",
        whenToPick: '"HDR", "clarity", "crisp detail", "ultra detailed", "dehaze", "punchy detail", "sharpen up the detail"',
    },
    "teal-orange": {
        characteristics: "Complementary blockbuster grade — warm skin/highlights, teal shadows",
        whenToPick: '"teal and orange", "orange and teal", "blockbuster grade", "complementary grade", "action movie color"',
    },
    "neo-noir": {
        characteristics: "Dark desaturated COLOR noir, cyan/teal cast, crushed shadows, dramatic — Blade-Runner-ish but not neon",
        whenToPick: '"neo noir", "color noir", "noir grade" (keep B&W noir on bw styles), "dark cinematic teal"',
    },
    sepia: {
        characteristics: "Warm brown antique near-monochrome tone",
        whenToPick: '"sepia", "brown tone", "antique", "old brown photo", "aged brown"',
    },
    cyberpunk: {
        characteristics: "Saturated neon night, magenta/teal punch, cool base, contrasty",
        whenToPick: '"cyberpunk", "neon", "neon night", "neon noir", "synthwave", "vaporwave", "Blade Runner neon"',
    },
    "dreamy-glow": {
        characteristics: "Soft ethereal bloom, hazy lifted highlights, gentle warmth, slightly soft focus",
        whenToPick: '"dreamy", "ethereal", "soft glow", "hazy", "misty", "Orton effect", "soft dreamy"',
    },
    autumn: {
        characteristics: "Warm fall palette, oranges and reds, golden greens, mild punch",
        whenToPick: '"autumn", "fall colors", "warm autumn", "orange and red tones", "cozy fall"',
    },
    "cold-winter": {
        characteristics: "Cool icy blue cast, slightly desaturated, crisp",
        whenToPick: '"winter", "cold tones", "icy", "frosty", "cool blue", "wintry"',
    },
    tropical: {
        characteristics: "Vivid sunny greens and blues, bright, punchy — beach/summer",
        whenToPick: '"tropical", "beach vibe", "summer vibe", "vivid sunny", "caribbean", "vacation"',
    },
    "cross-process": {
        characteristics: "High contrast, cyan-shifted shadows, yellow-green highlights — cross-processed film",
        whenToPick: '"cross process", "xpro", "cross-processed", "C-41 in E-6"',
    },
    "bleach-bypass": {
        characteristics: "Heavily desaturated, very high contrast, silvery metallic — silver retention",
        whenToPick: '"bleach bypass", "silver retention", "desaturated gritty high contrast", "Saving-Private-Ryan look"',
    },
    technicolor: {
        characteristics: "Rich deeply saturated old-Hollywood 3-strip color, snappy, warm",
        whenToPick: '"technicolor", "three strip", "old Hollywood color", "vivid classic film color"',
    },
    lomography: {
        characteristics: "Oversaturated, contrasty, grainy, slightly soft — toy-camera lo-fi",
        whenToPick: '"lomo", "lomography", "toy camera", "Holga", "Diana camera", "lo-fi color"',
    },
    "earthy-muted": {
        characteristics: "Desaturated warm earth tones — terracotta, sage, organic and calm",
        whenToPick: '"earthy", "muted earth", "desaturated warm", "terracotta", "sage tones", "organic muted"',
    },
}

// Ordered keyword routing table — the FIRST regex that matches wins, so order
// matters: specific film/camera names come BEFORE generic descriptors that
// would also match (e.g. "Portra" must beat "vintage"; "RED camera" must beat
// "cinematic"). Used by route.js as the deterministic keyword fallback when
// Gemini is unavailable AND as a hint to bias Gemini's choice.
export const KEYWORD_STYLE_ROUTES = [
    // ── Specific film stocks (most specific first) ──
    [/\bcine\s*still\b|\b800t\b|tungsten\s*film|halation|neon\s*film/i, "cinestill-800t"],
    [/\bportra\b|kodak\s*portra|wedding\s*film/i, "kodak-portra"],
    [/\bpro\s*400h\b|fuji\s*(pro|400h)|\b400h\b/i, "fuji-pro400h"],
    [/kodachrome|nat\s*geo|national\s*geographic\s*film/i, "kodachrome"],
    [/\btri[-\s]?x\b|pushed\s*film|street\s*(photography\s*)?b&?w|noir\s*film|grain(y)?\s*black\s*and\s*white|grain(y)?\s*b&?w/i, "bw-tri-x"],
    [/super[-\s]?8|super\s*eight|\b16\s*mm\b|\b8\s*mm\s*film\b|home\s*movie|old\s*home\s*video/i, "super8"],
    [/polaroid|sx-?70|instax|instant\s*(camera|film)/i, "polaroid"],

    // ── Specific cameras ──
    [/\bred\s*(camera|cinema|dragon|helium|monstro|epic|komodo|raptor|gemini)\b|shot\s+on\s+(a\s+)?red|\bipp2\b|red\s*gamut/i, "red-cinema"],
    [/\barri\b|\balexa\b|alexa\s*mini|\blog-?c\b|arri\s*log/i, "arri-alexa"],
    [/\bvhs\b|camcorder|video\s*tape|analog\s*video|lo-?fi\s*video|tracking\s*lines/i, "vhs-tape"],

    // ── Time-of-day / mood (specific before generic) ──
    [/golden\s*hour|magic\s*hour|sunset\s*glow|sun-?soaked|warm\s*glow|sunlit\s*warm/i, "golden-hour"],
    [/faded\s*pastel|washed\s*out|\bpastel\b|milky\s*tones?|soft\s*pastel|ig[\s-]?aesthetic|instagram\s*aesthetic/i, "faded-pastel"],

    // ── Creative color grades & moods (beat the generic catch-alls below) ──
    [/cross[\s-]?process\w*|\bxpro\b|c-?41\s*in\s*e-?6/i, "cross-process"],
    [/bleach\s*bypass|silver\s*retention/i, "bleach-bypass"],
    [/technicolor|three[\s-]?strip|old\s*hollywood\s*colou?r/i, "technicolor"],
    [/\blomo\w*|toy\s*camera|\bholga\b|\bdiana\s*camera\b/i, "lomography"],
    [/teal\s*(and|&|\/)?\s*orange|orange\s*(and|&|\/)?\s*teal|blockbuster\s*grade|complementary\s*grade|action\s*movie\s*colou?r/i, "teal-orange"],
    [/neo[\s-]?noir|colou?r\s*noir|noir\s*grade/i, "neo-noir"],
    [/cyberpunk|\bneon\b|synthwave|vaporwave|blade\s*runner|neon\s*night/i, "cyberpunk"],
    [/\bsepia\b|brown\s*tone|antique\s*tone|aged\s*brown/i, "sepia"],
    [/bleach|gritty\s*desaturat\w*/i, "bleach-bypass"],
    [/\bhdr\b|clarity|dehaze|crisp\s*detail|ultra[\s-]?detail\w*|punchy\s*detail|more\s*detail/i, "hdr-clarity"],
    [/dreamy|ethereal|orton|soft\s*glow|glowy|hazy\s*glow/i, "dreamy-glow"],
    [/matte|flat\s*film|faded\s*matte|lifted\s*blacks?|vsco\s*matte/i, "matte-film"],
    [/bright\s*(and|&)?\s*airy|\bairy\b|high[\s-]?key|light\s*(and|&)?\s*bright|clean\s*(and\s*)?bright|fresh\s*(and\s*)?light/i, "bright-airy"],
    [/moo?dy|low[\s-]?key|dark\s*(and|&)?\s*moody|brooding|somber|sombre/i, "moody-dark"],
    [/autumn|\bfall\s*(colou?rs?|tones?|vibe)|cozy\s*fall|warm\s*autumn/i, "autumn"],
    [/\bwinter\b|icy|frosty|wintr?y|cold\s*tones?|cool\s*blue\s*tones?/i, "cold-winter"],
    [/tropical|beach\s*vibe|summer\s*vibe|caribbean|vacation\s*vibe|sunny\s*vivid/i, "tropical"],
    [/earthy|muted\s*earth|terracotta|sage\s*tones?|organic\s*muted|desaturated\s*warm/i, "earthy-muted"],

    // ── Broad generic looks ──
    [/black\s*and\s*white|monochrome|\bb&?w\b|greyscale|grayscale|\bnoir\b/i, "bw-classic"],
    [/cinemat|filmic|blockbust|hollywo|anamorphic|widescreen/i, "cinematic"],
    [/editorial|magazine|lookbook|vogue|high[-\s]?fashion/i, "editorial"],
    [/vibrant|punchy|bold|vivid|colorful|colourful|neon|saturated|make\s+it\s+pop/i, "vibrant"],

    // ── Generic vintage/retro catch-all (broad; comes near the bottom) ──
    [/vintag|retro|old[-\s]?school|nostalgi|faded|aged|grain|worn|sepia|70s|80s|90s|disposable|kodak|fuji|vsco|hipster|old\s*(camera|photo|fashion)/i, "vintage"],

    // ── Studio / portrait / mood ──
    [/studio|clean\s*product|minimalist\s*commercial|white\s*background/i, "studio"],
    [/portrait|skin\s*tones?|headshot|cozy|cosy/i, "warm-portrait"],
    [/moo?dy|dark|dramatic|gritty|desaturat/i, "cinematic"],
    [/dream|ethereal|soft\s*glow|hazy|misty/i, "faded-pastel"],
    [/instagram|influenc|aesthetic|vibe|premium|polished|professional/i, "editorial"],
]
