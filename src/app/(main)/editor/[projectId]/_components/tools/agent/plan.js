import { ADJUSTMENT_RANGES } from "@/lib/edit-planner";
import { STYLE_LABELS } from "@/lib/style-profiles";
import { buildImageKitAiTransformUrl } from "../../../../../../../lib/imagekit-ai";

// Initial messages constant referenced through the file. Defined after
// INITIAL_WELCOME_MESSAGE below to avoid the TDZ; the variable that ends up
// here is hoisted via the export below.

export const ADJUSTMENT_LABELS = {
  brightness: "Brightness",
  contrast: "Contrast",
  gamma: "Gamma",
  temperature: "Temperature",
  saturation: "Saturation",
  vibrance: "Vibrance",
  hue: "Hue",
  sharpness: "Sharpness",
  blur: "Blur",
  noise: "Noise",
  pixelate: "Pixel",
};

export const ADJUSTMENT_DEFAULTS = {
  brightness: 0,
  contrast: 0,
  gamma: 100,
  temperature: 0,
  saturation: 0,
  vibrance: 0,
  hue: 0,
  sharpness: 0,
  blur: 0,
  noise: 0,
  pixelate: 1,
};

export const ADJUSTMENT_HELP = {
  brightness: "Moves the exposure without rebuilding the image.",
  contrast: "Separates shadows and highlights for punch.",
  gamma: "Changes midtone density while keeping endpoints stable.",
  temperature: "Pushes the color cast warmer or cooler.",
  saturation: "Changes total color intensity.",
  vibrance: "Boosts muted colors more gently.",
  hue: "Rotates the whole color wheel.",
  sharpness: "Adds edge definition after the URL transform.",
  blur: "Softens detail for depth or glow.",
  noise: "Adds controlled texture.",
  pixelate: "Adds block-size stylization.",
};

export const visibleAdjustmentEntries = (adjustments = {}) =>
  Object.entries(adjustments).filter(([key, value]) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return false;
    return numericValue !== (ADJUSTMENT_DEFAULTS[key] ?? 0);
  });

export const readableTransform = (token) =>
  String(token || "")
    .replace(/^e-/, "")
    .replace(/^q-/, "quality ")
    .replace(/^f-/, "format ")
    .replace(/[,_:=]+/g, " ")
    .replace(/-/g, " ")
    .trim();

export const formatAdjustmentValue = (key, value) => {
  const numericValue = Number(value);
  const signed = numericValue > 0 && key !== "gamma" && key !== "pixelate" ? `+${numericValue}` : `${numericValue}`;
  if (key === "gamma") return `${numericValue}%`;
  if (key === "pixelate") return `${numericValue}px`;
  if (key === "hue") return `${signed}deg`;
  return signed;
};

export const getChangeItems = (plan) => {
  const transforms = Array.isArray(plan?.imageKitTransforms) ? plan.imageKitTransforms : [];
  const transformItems = transforms.map((transform, index) => ({
    id: `transform:${index}:${transform}`,
    type: "imagekit",
    index,
    label: readableTransform(transform) || "URL transform",
    valueLabel: transform,
    detail: "ImageKit URL operation",
  }));

  // v2 plan: `entries` carry the slider metadata (min/max/why) — prefer them when present.
  const v2Entries = Array.isArray(plan?.entries) ? plan.entries : null;
  const adjustmentItems = v2Entries
    ? v2Entries.map((entry) => ({
        id: `adjust:${entry.key}`,
        type: "adjustment",
        key: entry.key,
        label: entry.label || ADJUSTMENT_LABELS[entry.key] || entry.key,
        valueLabel: formatAdjustmentValue(entry.key, entry.value),
        detail: entry.why || ADJUSTMENT_HELP[entry.key] || "Local canvas filter",
        min: entry.min,
        max: entry.max,
        neutral: entry.neutral,
        defaultValue: entry.value,
      }))
    : visibleAdjustmentEntries(plan?.fabricAdjustments).map(([key, value]) => ({
        id: `adjust:${key}`,
        type: "adjustment",
        key,
        label: ADJUSTMENT_LABELS[key] || key,
        valueLabel: formatAdjustmentValue(key, value),
        detail: ADJUSTMENT_HELP[key] || "Local canvas filter",
        min: ADJUSTMENT_RANGES[key]?.min ?? -100,
        max: ADJUSTMENT_RANGES[key]?.max ?? 100,
        neutral: ADJUSTMENT_RANGES[key]?.neutral ?? 0,
        defaultValue: value,
      }));

  return [...transformItems, ...adjustmentItems];
};

// Adapts the v2 plan response from /api/ai/edit-plan into the shape the rest of the
// UI expects (sourceUrl, fabricAdjustments, imageKitTransforms, etc.).
//
// Only truly server-only AI operations route through ImageKit URL transforms.
// Contrast and sharpness are deliberately omitted — those are basic adjustments
// Fabric.js handles natively, instantly, and without a round-trip. Otherwise
// the plan would double-apply them (once via URL, once via Fabric filter) and
// also force an extra ImageKit fetch per slider drag.
export const IMAGEKIT_AI_TOKENS = {
  bgRemove: "e-bgremove",
  upscale: "e-upscale",
  retouch: "e-retouch",
};

export const adaptPlanV2 = (planV2, sourceUrl, userPrompt) => {
  const imagekitAi = planV2?.imagekitAi || {};
  const transforms = Object.entries(IMAGEKIT_AI_TOKENS)
    .filter(([key]) => imagekitAi[key])
    .map(([, token]) => token);

  const styleLabel = STYLE_LABELS[planV2?.targetStyle] || planV2?.targetStyle || "Custom";
  const title = planV2?.alreadyMatchesTarget
    ? "Already looking great"
    : `${styleLabel} look`;

  return {
    title,
    summary: planV2?.notes || "",
    sourceUrl,
    userPrompt,
    fabricAdjustments: planV2?.adjustments || {},
    imageKitTransforms: transforms,
    entries: Array.isArray(planV2?.entries) ? planV2.entries : [],
    targetStyle: planV2?.targetStyle,
    currentStyle: planV2?.currentStyle,
    gain: planV2?.gain,
    alreadyMatchesTarget: !!planV2?.alreadyMatchesTarget,
    plannerVersion: planV2?.plannerVersion,
  };
};

// Build the per-effect value map (slider state). Initialized from plan.entries on
// new plans; mutated as the user drags sliders.
export const createValueMap = (plan) => {
  const out = {};
  for (const item of getChangeItems(plan)) {
    if (item.type === "adjustment") out[item.key] = item.defaultValue;
  }
  return out;
};

export const createEnabledMap = (plan) =>
  getChangeItems(plan).reduce((acc, item) => {
    acc[item.id] = true;
    return acc;
  }, {});

export const getEnabledChangeDetails = (plan, enabledMap) =>
  getChangeItems(plan).map((item) => ({
    id: item.id,
    type: item.type,
    label: item.label,
    value: item.valueLabel,
    enabled: enabledMap?.[item.id] !== false,
  }));

export const buildEffectivePlan = (plan, enabledMap, fallbackSourceUrl, valueMap = null) => {
  if (!plan) return null;

  const baseUrl = plan.sourceUrl || fallbackSourceUrl || "";
  const transforms = Array.isArray(plan.imageKitTransforms)
    ? plan.imageKitTransforms.filter((transform, index) => enabledMap?.[`transform:${index}:${transform}`] !== false)
    : [];

  // Prefer the live slider value map when provided (the user has been dragging sliders).
  // Fall back to plan.fabricAdjustments / plan.entries for the initial computation.
  const allAdjustmentEntries = Array.isArray(plan.entries) && plan.entries.length
    ? plan.entries.map((entry) => [entry.key, valueMap?.[entry.key] ?? entry.value])
    : visibleAdjustmentEntries(plan.fabricAdjustments).map(([key, value]) => [key, valueMap?.[key] ?? value]);

  const fabricAdjustments = allAdjustmentEntries.reduce((acc, [key, value]) => {
    if (enabledMap?.[`adjust:${key}`] !== false && Number.isFinite(Number(value))) {
      acc[key] = Number(value);
    }
    return acc;
  }, {});

  return {
    ...plan,
    imageKitTransforms: transforms,
    fabricAdjustments,
    url: transforms.length
      ? buildImageKitAiTransformUrl(baseUrl, transforms, {
          preserveExistingTransforms: true,
          existingPosition: "before",
        })
      : baseUrl,
  };
};
