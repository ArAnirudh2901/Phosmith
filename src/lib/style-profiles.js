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

export const STYLE_KEYS = [
    "neutral",
    "cinematic",
    "editorial",
    "vibrant",
    "vintage",
    "studio",
    "warm-portrait",
    "bw-classic",
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
export const STYLE_PROFILES = {
    neutral: {},
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
