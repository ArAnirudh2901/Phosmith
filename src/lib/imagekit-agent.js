import { buildImageKitAiTransformUrl } from "@/lib/imagekit-ai";
import { retrieveImageKitDocs } from "@/lib/imagekit-docs";

const MAX_PROMPT = 900;

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), max);

const includesAny = (text, terms) => terms.some((term) => text.includes(term));

const cleanPrompt = (prompt) => String(prompt || "").trim().slice(0, MAX_PROMPT);

const dedupeTransforms = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
};

export const getImageKitAgentSourceUrl = (url) => String(url || "").trim();

export const buildLocalVisualPlan = async ({
  prompt,
  sourceUrl,
  imageAnalysis = {},
  project = {},
}) => {
  const normalizedPrompt = cleanPrompt(prompt);
  const lower = normalizedPrompt.toLowerCase();

  // ──── Extension / Outpaint detection ────
  const extensionPlan = parseExtensionIntent(lower, project);
  if (extensionPlan) {
    const docs = await retrieveImageKitDocs({ prompt: normalizedPrompt, imageAnalysis });
    return {
      title: extensionPlan.title,
      summary: extensionPlan.summary,
      mode: "local-extension",
      model: "deterministic-planner",
      prompt: normalizedPrompt,
      imageKitTransforms: [],
      fabricAdjustments: {},
      url: sourceUrl,
      docs,
      steps: extensionPlan.steps,
      confidence: 0.9,
      extensionRequest: extensionPlan.extensionRequest,
    };
  }

  const docs = await retrieveImageKitDocs({ prompt: normalizedPrompt, imageAnalysis });

  const transforms = [];
  const adjustments = {
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

  const wantsBetter = includesAny(lower, [
    "better",
    "professional",
    "enhance",
    "improve",
    "polish",
    "premium",
    "quality",
    "fix",
  ]);
  const wantsPortrait = includesAny(lower, ["portrait", "face", "skin", "headshot", "person"]);
  const wantsProduct = includesAny(lower, ["product", "ecommerce", "catalog", "shop", "packshot"]);
  const wantsCinematic = includesAny(lower, ["cinematic", "film", "moody", "editorial", "teal", "orange"]);
  const wantsVivid = includesAny(lower, ["vivid", "pop", "colorful", "vibrant", "instagram"]);
  const wantsNatural = includesAny(lower, ["natural", "clean", "subtle", "realistic"]);
  const wantsUpscale = includesAny(lower, ["upscale", "resolution", "print", "4k", "large"]);
  const wantsBackgroundRemove = includesAny(lower, [
    "remove background",
    "transparent",
    "cutout",
    "white background",
    "isolate",
  ]);
  const wantsShadow = includesAny(lower, ["shadow", "depth", "grounded"]);
  const wantsSoft = includesAny(lower, ["soft", "dreamy", "depth of field", "bokeh"]);

  if (wantsBackgroundRemove || wantsProduct) {
    transforms.push(wantsShadow || wantsProduct ? "e-bgremove:e-dropshadow" : "e-bgremove");
  }

  if (wantsPortrait || wantsBetter || wantsNatural) {
    transforms.push("e-retouch");
  }

  if (wantsUpscale || (wantsBetter && (project.width || 0) < 1400)) {
    // e-upscale has a 16MP input limit — skip for large images
    const pixelCount = (project.width || 0) * (project.height || 0)
    if (pixelCount < 14_000_000) {
      transforms.push("e-upscale");
    }
  }

  if (wantsBetter || imageAnalysis.isLowContrast || wantsCinematic) {
    transforms.push("e-contrast");
  }

  if (wantsBetter || imageAnalysis.isSoft || wantsProduct) {
    transforms.push("e-sharpen-10");
  }

  if (!wantsBackgroundRemove) {
    transforms.push("q-auto", "f-auto");
  }

  if (imageAnalysis.isDark) adjustments.brightness += wantsCinematic ? 4 : 8;
  if (imageAnalysis.isLowContrast) adjustments.contrast += 14;
  if (imageAnalysis.isLowSaturation) adjustments.vibrance += 18;
  if (imageAnalysis.isWarm && wantsCinematic) adjustments.temperature -= 8;
  if (imageAnalysis.isCool && !wantsCinematic) adjustments.temperature += 6;

  if (wantsCinematic) {
    adjustments.contrast += 18;
    adjustments.vibrance += 12;
    adjustments.saturation -= 4;
    adjustments.temperature -= lower.includes("orange") ? 4 : 10;
    adjustments.gamma = 94;
    adjustments.sharpness += 18;
  } else if (wantsVivid) {
    adjustments.contrast += 10;
    adjustments.saturation += 12;
    adjustments.vibrance += 24;
    adjustments.sharpness += 12;
  } else if (wantsProduct) {
    adjustments.brightness += 6;
    adjustments.contrast += 12;
    adjustments.vibrance += 8;
    adjustments.sharpness += 22;
  } else if (wantsPortrait || wantsNatural) {
    adjustments.contrast += wantsNatural ? 6 : 10;
    adjustments.vibrance += 8;
    adjustments.temperature += 3;
    adjustments.sharpness += 8;
  } else if (wantsBetter) {
    adjustments.contrast += 12;
    adjustments.vibrance += 12;
    adjustments.sharpness += 12;
  }

  if (wantsSoft) {
    adjustments.blur = 2;
    adjustments.sharpness = Math.max(0, adjustments.sharpness - 8);
  }

  adjustments.brightness = clamp(adjustments.brightness, -35, 35);
  adjustments.contrast = clamp(adjustments.contrast, -40, 55);
  adjustments.gamma = clamp(adjustments.gamma, 70, 130);
  adjustments.temperature = clamp(adjustments.temperature, -45, 45);
  adjustments.saturation = clamp(adjustments.saturation, -40, 45);
  adjustments.vibrance = clamp(adjustments.vibrance, -30, 55);
  adjustments.sharpness = clamp(adjustments.sharpness, 0, 60);
  adjustments.blur = clamp(adjustments.blur, 0, 12);

  const imageKitTransforms = dedupeTransforms(transforms);
  const nextUrl = imageKitTransforms.length
    ? buildImageKitAiTransformUrl(sourceUrl, imageKitTransforms, {
        preserveExistingTransforms: true,
        existingPosition: "before",
      })
    : sourceUrl;

  const title = wantsCinematic
    ? "Cinematic color grade"
    : wantsProduct
      ? "Studio product polish"
      : wantsPortrait
        ? "Portrait retouch"
        : "Professional enhancement";

  const steps = [
    ...(imageKitTransforms.length
      ? [
          {
            label: "ImageKit transform chain",
            value: imageKitTransforms.join(", "),
            reason: "Applies non-destructive server-side ImageKit operations to the source URL.",
          },
        ]
      : []),
    {
      label: "Local color grade",
      value: Object.entries(adjustments)
        .filter(([key, value]) => key === "gamma" ? value !== 100 : key === "pixelate" ? value !== 1 : value !== 0)
        .map(([key, value]) => `${key} ${value}`)
        .join(", ") || "No local filter changes",
      reason: "Uses the active image's measured brightness, contrast, and saturation to tune the final look.",
    },
  ];

  return {
    title,
    summary:
      "Built a free local ImageKit plan from retrieved docs, prompt intent, and visual analysis of the active canvas image.",
    mode: "local-visual-rag",
    model: "deterministic-planner",
    prompt: normalizedPrompt,
    imageKitTransforms,
    fabricAdjustments: adjustments,
    url: nextUrl,
    docs,
    steps,
    confidence: imageKitTransforms.length ? 0.82 : 0.68,
  };
};

const tryParseJson = (text) => {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
};

export const callOllamaVisionPlanner = async ({
  prompt,
  imageBase64,
  imageAnalysis,
  docs,
  fallbackPlan,
}) => {
  const baseUrl = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const model = process.env.OLLAMA_VISION_MODEL || "llava:latest";
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS || 18000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "You are a senior photo retoucher and ImageKit transformation agent. Return strict JSON only. Use only ImageKit transform tokens that are supported by the provided docs or already present in the fallback plan. Use local fabricAdjustments for color grading that ImageKit URL transforms do not cover.",
        },
        {
          role: "user",
          images: imageBase64 ? [imageBase64] : undefined,
          content: JSON.stringify({
            userPrompt: prompt,
            imageAnalysis,
            retrievedImageKitDocs: docs,
            fallbackPlan,
            requiredJsonShape: {
              title: "short title",
              summary: "one sentence",
              imageKitTransforms: ["e-retouch", "e-contrast"],
              fabricAdjustments: fallbackPlan.fabricAdjustments,
              steps: [{ label: "step", value: "token", reason: "why" }],
            },
          }),
        },
      ],
    }),
  }).finally(() => clearTimeout(timer));

  if (!response.ok) {
    throw new Error(`Ollama responded with ${response.status}`);
  }

  const data = await response.json();
  const parsed = tryParseJson(data?.message?.content);
  if (!parsed) throw new Error("Ollama returned non-JSON output");

  const transforms = Array.isArray(parsed.imageKitTransforms)
    ? parsed.imageKitTransforms.filter((item) => typeof item === "string" && /^[a-z0-9_.,:=-]+$/i.test(item))
    : fallbackPlan.imageKitTransforms;

  return {
    ...fallbackPlan,
    ...parsed,
    mode: "ollama-vision-rag",
    model,
    imageKitTransforms: dedupeTransforms(transforms),
    fabricAdjustments: {
      ...fallbackPlan.fabricAdjustments,
      ...(parsed.fabricAdjustments || {}),
    },
  };
};

// ──────────────────────────────────────────────────────────────────────
// Extension / outpaint intent parser
// ──────────────────────────────────────────────────────────────────────

const EXTEND_TRIGGERS = [
  "extend", "outpaint", "expand", "widen", "stretch canvas",
  "make wider", "make taller", "add space", "add margin",
  "increase canvas", "enlarge canvas",
];

const DIRECTION_PATTERNS = [
  { regex: /(?:to\s+the\s+)?(?:right|east)\b/i, side: "right" },
  { regex: /(?:to\s+the\s+)?(?:left|west)\b/i, side: "left" },
  { regex: /(?:to\s+the\s+)?(?:top|up(?:ward)?|north)\b/i, side: "top" },
  { regex: /(?:to\s+the\s+)?(?:bottom|down(?:ward)?|south)\b/i, side: "bottom" },
  { regex: /horizontal(?:ly)?/i, sides: ["left", "right"] },
  { regex: /vertical(?:ly)?/i, sides: ["top", "bottom"] },
  { regex: /all\s+(?:four\s+)?sides?|every\s+side|all\s+around/i, sides: ["top", "bottom", "left", "right"] },
];

const PIXEL_PATTERN = /(\d{1,5})\s*(?:px|pixels?)/i;
const PERCENT_PATTERN = /(\d{1,3})\s*%/;
const RESOLUTION_PATTERN = /(\d{3,5})\s*[x×]\s*(\d{3,5})/i;

function parseExtensionIntent(lower, project) {
  const isExtendIntent = EXTEND_TRIGGERS.some((t) => lower.includes(t));
  if (!isExtendIntent) return null;

  const sourceWidth = project?.width || 0;
  const sourceHeight = project?.height || 0;
  if (!sourceWidth || !sourceHeight) return null;

  const MAX_DIM = 4096;

  // Try to parse target resolution: "extend to 1920x1080"
  const resMatch = lower.match(RESOLUTION_PATTERN);
  if (resMatch) {
    const targetW = clamp(Number(resMatch[1]), sourceWidth, MAX_DIM);
    const targetH = clamp(Number(resMatch[2]), sourceHeight, MAX_DIM);
    const extraW = targetW - sourceWidth;
    const extraH = targetH - sourceHeight;

    if (extraW < 1 && extraH < 1) return null;

    // Distribute extra pixels equally on opposing sides
    const insets = {
      left: Math.floor(extraW / 2),
      right: Math.ceil(extraW / 2),
      top: Math.floor(extraH / 2),
      bottom: Math.ceil(extraH / 2),
    };

    return buildExtensionPlanResult({
      insets,
      sourceWidth, sourceHeight,
      targetWidth: targetW, targetHeight: targetH,
      description: `Extend to ${targetW}×${targetH}`,
    });
  }

  // Parse pixel or percent amount
  const pxMatch = lower.match(PIXEL_PATTERN);
  const pctMatch = lower.match(PERCENT_PATTERN);

  let amount = 0;
  let isPercent = false;
  if (pxMatch) {
    amount = Number(pxMatch[1]);
  } else if (pctMatch) {
    amount = Number(pctMatch[1]);
    isPercent = true;
  } else {
    // Default to 20% extension
    amount = 20;
    isPercent = true;
  }

  // Parse directions
  const matchedSides = new Set();
  for (const pattern of DIRECTION_PATTERNS) {
    if (pattern.regex.test(lower)) {
      if (pattern.sides) {
        pattern.sides.forEach((s) => matchedSides.add(s));
      } else {
        matchedSides.add(pattern.side);
      }
    }
  }

  // Default: if no direction specified, extend all sides
  if (matchedSides.size === 0) {
    matchedSides.add("top");
    matchedSides.add("bottom");
    matchedSides.add("left");
    matchedSides.add("right");
  }

  const insets = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const side of matchedSides) {
    const ref = (side === "left" || side === "right") ? sourceWidth : sourceHeight;
    const px = isPercent ? Math.round(ref * (amount / 100)) : amount;
    insets[side] = Math.max(1, px);
  }

  let targetWidth = sourceWidth + insets.left + insets.right;
  let targetHeight = sourceHeight + insets.top + insets.bottom;

  // Cap to MAX_DIM
  if (targetWidth > MAX_DIM) {
    const over = targetWidth - MAX_DIM;
    if (insets.right >= insets.left) insets.right = Math.max(0, insets.right - over);
    else insets.left = Math.max(0, insets.left - over);
    targetWidth = sourceWidth + insets.left + insets.right;
  }
  if (targetHeight > MAX_DIM) {
    const over = targetHeight - MAX_DIM;
    if (insets.bottom >= insets.top) insets.bottom = Math.max(0, insets.bottom - over);
    else insets.top = Math.max(0, insets.top - over);
    targetHeight = sourceHeight + insets.top + insets.bottom;
  }

  const hasExtension = insets.left + insets.right + insets.top + insets.bottom > 0;
  if (!hasExtension) return null;

  const dirs = [...matchedSides].join(", ");
  const amtLabel = isPercent ? `${amount}%` : `${amount}px`;

  return buildExtensionPlanResult({
    insets,
    sourceWidth, sourceHeight,
    targetWidth, targetHeight,
    description: `Extend ${dirs} by ${amtLabel}`,
  });
}

function buildExtensionPlanResult({ insets, sourceWidth, sourceHeight, targetWidth, targetHeight, description }) {
  const activeSides = Object.entries(insets).filter(([, v]) => v > 0).map(([s]) => s);

  return {
    title: "AI Image Extension",
    summary: `${description} → ${targetWidth}×${targetHeight} (from ${sourceWidth}×${sourceHeight})`,
    steps: [
      {
        label: "Extension",
        value: `${activeSides.join(", ")} | ${targetWidth}×${targetHeight}`,
        reason: `Outpaint ${activeSides.length} side(s) using AI generative fill.`,
      },
    ],
    extensionRequest: {
      insets,
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
      prompt: "seamless natural continuation",
    },
  };
}
