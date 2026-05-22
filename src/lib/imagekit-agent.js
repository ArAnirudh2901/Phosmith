import { buildImageKitTransformUrl } from "@/lib/imagekit-ai";
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
    transforms.push("e-upscale");
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
    ? buildImageKitTransformUrl(sourceUrl, imageKitTransforms, {
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
