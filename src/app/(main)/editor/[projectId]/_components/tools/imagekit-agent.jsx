"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bot,
  BrainCircuit,
  Check,
  Copy,
  History,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useCanvas } from "../../../../../../../context/context";
import { useConvexMutation, useConvexQuery } from "../../../../../../../hooks/useConvexQuery";
import { api } from "../../../../../../../convex/_generated/api";
import {
  buildImageKitAiTransformUrl,
  getCanvasActiveImage,
  hasImageKitAiTransform,
  isImageKitUrl,
  replaceCanvasImageFromUrl,
  waitForImageKitUrl,
} from "../../../../../../lib/imagekit-ai";
import { restoreCanvasFromHistory } from "../../../../../../lib/canvas-history";
import { serializeCanvasState } from "../../../../../../lib/canvas-state";
import { applyProfessionalFilters } from "../../../../../../lib/professional-image-filters";
import { computeImageFingerprint } from "@/lib/image-fingerprint";
import { extractImageFeatures } from "@/lib/image-features";
import { ADJUSTMENT_RANGES } from "@/lib/edit-planner";
import { STYLE_LABELS } from "@/lib/style-profiles";
import { ProRulerSlider } from "@/components/editor/ProRulerSlider";
import BeforeAfterCompare from "@/components/neo/BeforeAfterCompare";
import { ArrowLeftRight } from "lucide-react";

const QUICK_PROMPTS = [
  { label: "Editorial", prompt: "Give it a premium editorial polish", hint: "Retouch, contrast, detail" },
  { label: "Cinematic", prompt: "Give it a cinematic color grade with crisp depth", hint: "Tone, drama, focus" },
  { label: "Studio", prompt: "Polish this for ecommerce with crisp studio detail", hint: "Clean product finish" },
  { label: "Extend", prompt: "Extend all sides by 20%", hint: "AI outpaint edges" },
];

const SAMPLE_SIZE = 48;
const INITIAL_MESSAGES = [
  {
    id: "assistant-initial",
    role: "assistant",
    content: "Select an image, describe the edit, and I will build a preview with the changes visible below.",
  },
];

const ADJUSTMENT_LABELS = {
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

const ADJUSTMENT_DEFAULTS = {
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

const ADJUSTMENT_HELP = {
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

let messageId = 0;

const newMessage = (role, content, extra = {}) => ({
  id: `${role}-${Date.now()}-${messageId++}`,
  role,
  content,
  ...extra,
});

const getSourceUrl = (image, project) =>
  image?.getSrc?.() ||
  image?._originalElement?.src ||
  image?._element?.src ||
  project?.currentImageUrl ||
  project?.originalImageUrl ||
  "";

const getImageElement = (image) =>
  image?._element || image?._originalElement || image?.getElement?.() || null;

const visibleAdjustmentEntries = (adjustments = {}) =>
  Object.entries(adjustments).filter(([key, value]) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return false;
    return numericValue !== (ADJUSTMENT_DEFAULTS[key] ?? 0);
  });

const readableTransform = (token) =>
  String(token || "")
    .replace(/^e-/, "")
    .replace(/^q-/, "quality ")
    .replace(/^f-/, "format ")
    .replace(/[,_:=]+/g, " ")
    .replace(/-/g, " ")
    .trim();

const formatAdjustmentValue = (key, value) => {
  const numericValue = Number(value);
  const signed = numericValue > 0 && key !== "gamma" && key !== "pixelate" ? `+${numericValue}` : `${numericValue}`;
  if (key === "gamma") return `${numericValue}%`;
  if (key === "pixelate") return `${numericValue}px`;
  if (key === "hue") return `${signed}deg`;
  return signed;
};

const getChangeItems = (plan) => {
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
// New fields: entries (per-effect slider metadata), targetStyle, gain, alreadyMatchesTarget.
const IMAGEKIT_AI_TOKENS = {
  bgRemove: "e-bgremove",
  upscale: "e-upscale",
  retouch: "e-retouch",
  sharpen: "e-sharpen-10",
  contrast: "e-contrast",
};

const adaptPlanV2 = (planV2, sourceUrl, userPrompt) => {
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
const createValueMap = (plan) => {
  const out = {};
  for (const item of getChangeItems(plan)) {
    if (item.type === "adjustment") out[item.key] = item.defaultValue;
  }
  return out;
};

const createEnabledMap = (plan) =>
  getChangeItems(plan).reduce((acc, item) => {
    acc[item.id] = true;
    return acc;
  }, {});

const getEnabledChangeDetails = (plan, enabledMap) =>
  getChangeItems(plan).map((item) => ({
    id: item.id,
    type: item.type,
    label: item.label,
    value: item.valueLabel,
    enabled: enabledMap?.[item.id] !== false,
  }));

const buildEffectivePlan = (plan, enabledMap, fallbackSourceUrl, valueMap = null) => {
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

const formatRevisionTime = (timestamp) => {
  if (!timestamp) return "Saved";
  try {
    return new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return "Saved";
  }
};

const truncate = (value, length = 70) => {
  const text = String(value || "").trim();
  return text.length > length ? `${text.slice(0, length - 1)}...` : text;
};

const analyzeActiveImage = (image, project) => {
  const element = getImageElement(image);
  const width = image?.width || element?.naturalWidth || project?.width || 0;
  const height = image?.height || element?.naturalHeight || project?.height || 0;
  const fallback = {
    width,
    height,
    aspectRatio: height ? width / height : 1,
    averageLuminance: 0.5,
    contrast: 0.35,
    saturation: 0.35,
    warmth: 0,
    isDark: false,
    isLowContrast: false,
    isLowSaturation: false,
    isSoft: false,
  };

  if (!element) return fallback;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(element, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

    let luminance = 0;
    let saturation = 0;
    let warmth = 0;
    const lumas = [];

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumas.push(luma);
      luminance += luma;
      saturation += max === 0 ? 0 : (max - min) / max;
      warmth += r - b;
    }

    const pixels = data.length / 4;
    const averageLuminance = luminance / pixels;
    const averageSaturation = saturation / pixels;
    const averageWarmth = warmth / pixels;
    const variance = lumas.reduce((sum, luma) => sum + (luma - averageLuminance) ** 2, 0) / lumas.length;
    const contrast = Math.sqrt(variance);

    return {
      ...fallback,
      averageLuminance: Number(averageLuminance.toFixed(3)),
      contrast: Number(contrast.toFixed(3)),
      saturation: Number(averageSaturation.toFixed(3)),
      warmth: Number(averageWarmth.toFixed(3)),
      isDark: averageLuminance < 0.38,
      isLowContrast: contrast < 0.19,
      isLowSaturation: averageSaturation < 0.24,
      isWarm: averageWarmth > 0.08,
      isCool: averageWarmth < -0.08,
      isSoft: contrast < 0.22,
    };
  } catch (error) {
    console.warn("[ImageKit Agent] visual analysis failed:", error);
    return fallback;
  }
};

// New: slider-equipped row for "adjustment" entries; toggle-only row for ImageKit AI tokens.
const AgentEffectControls = ({
  plan,
  enabledMap = {},
  valueMap = {},
  onToggle,
  onValueChange,
  interactive = true,
  dominantColor = "#5eb8ff",
}) => {
  const changes = getChangeItems(plan);
  if (!changes.length) {
    return (
      <div className="agent-change-empty">
        <SlidersHorizontal className="h-3.5 w-3.5" />
        No adjustable changes in this prompt.
      </div>
    );
  }

  return (
    <div className="agent-change-list">
      {changes.map((change) => {
        const enabled = enabledMap?.[change.id] !== false;
        if (change.type === "imagekit") {
          return (
            <button
              key={change.id}
              type="button"
              className={`agent-change-row ${enabled ? "agent-change-row--enabled" : "agent-change-row--muted"}`}
              onClick={() => interactive && onToggle?.(change.id)}
              disabled={!interactive}
              aria-pressed={enabled}
              title={change.detail}
            >
              <span className="agent-change-switch" aria-hidden="true">
                <span />
              </span>
              <span className="agent-change-copy">
                <span className="agent-change-name">{change.label}</span>
                <span className="agent-change-detail">{change.detail}</span>
              </span>
              <span className="agent-change-value">{change.valueLabel}</span>
            </button>
          );
        }
        // Adjustment row: toggle + slider + value chip
        const liveValue = Number(valueMap?.[change.key] ?? change.defaultValue ?? change.neutral ?? 0);
        return (
          <div
            key={change.id}
            className={`agent-effect-row ${enabled ? "is-on" : "is-off"}`}
            style={{ "--agent-effect-accent": dominantColor }}
          >
            <button
              type="button"
              className="agent-effect-toggle"
              onClick={() => interactive && onToggle?.(change.id)}
              disabled={!interactive}
              aria-pressed={enabled}
              title={enabled ? "Disable" : "Enable"}
            >
              <span className="agent-change-switch" aria-hidden="true">
                <span />
              </span>
            </button>
            <div className="agent-effect-body">
              <div className="agent-effect-header">
                <span className="agent-effect-name">{change.label}</span>
                <span className="agent-effect-value">{formatAdjustmentValue(change.key, liveValue)}</span>
              </div>
              <div className={`agent-effect-slider ${enabled ? "" : "agent-effect-slider--muted"}`}>
                <ProRulerSlider
                  variant="instrument"
                  value={liveValue}
                  min={change.min}
                  max={change.max}
                  step={1}
                  label={change.label}
                  onPreview={(v) => interactive && enabled && onValueChange?.(change.key, v, { commit: false })}
                  onCommit={(v) => interactive && enabled && onValueChange?.(change.key, v, { commit: true })}
                  visual={{
                    fill: "rgba(94, 184, 255, 0.35)",
                    accent: dominantColor,
                    trackBg: "rgba(14, 18, 26, 0.96)",
                  }}
                />
              </div>
              {change.detail && (
                <p className="agent-effect-detail">{change.detail}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const AgentChangeList = ({ plan, enabledMap = {}, onToggle, compact = false, interactive = true }) => {
  const changes = getChangeItems(plan);

  if (!changes.length) {
    return (
      <motion.div
        layout
        className="agent-change-empty"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        No adjustable changes in this prompt.
      </motion.div>
    );
  }

  return (
    <motion.div
      layout
      className={`agent-change-list ${compact ? "agent-change-list--compact" : ""}`}
      initial={{ opacity: 0, y: 10, filter: "blur(8px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, y: -8, filter: "blur(8px)" }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
    >
      {changes.map((change, index) => {
        const enabled = enabledMap?.[change.id] !== false;
        return (
          <motion.button
            key={change.id}
            type="button"
            className={`agent-change-row ${enabled ? "agent-change-row--enabled" : "agent-change-row--muted"}`}
            onClick={() => interactive && onToggle?.(change.id)}
            disabled={!interactive}
            aria-pressed={enabled}
            title={interactive ? "Toggle this change" : change.detail}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: compact ? 0 : index * 0.035, duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            whileHover={interactive ? { x: 3 } : {}}
            whileTap={interactive ? { scale: 0.985 } : {}}
          >
            <span className="agent-change-switch" aria-hidden="true">
              <span />
            </span>
            <span className="agent-change-copy">
              <span className="agent-change-name">{change.label}</span>
              {!compact && <span className="agent-change-detail">{change.detail}</span>}
            </span>
            <span className="agent-change-value">{change.valueLabel}</span>
          </motion.button>
        );
      })}
    </motion.div>
  );
};

const AgentThinkingRow = ({ prompt, autoPreview = true }) => (
  <motion.div
    layout
    className="agent-thinking-row"
    initial={{ opacity: 0, y: 10, filter: "blur(8px)" }}
    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
    exit={{ opacity: 0, y: -8, filter: "blur(8px)" }}
    transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
  >
    <div>
      <Sparkles className="h-3.5 w-3.5" />
      Reading prompt
    </div>
    <strong>{truncate(prompt || "Latest edit", 56)}</strong>
    <span>{autoPreview ? "Preview will update automatically" : "Manual preview ready after planning"}</span>
  </motion.div>
);

const MessageBubble = ({ message }) => {
  const isUser = message.role === "user";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className={`agent-message-line ${isUser ? "agent-message-line--user" : ""}`}
    >
      <div className="agent-message-meta">
        <span>{isUser ? "YOU" : "AGENT"}</span>
      </div>
      <div className={`agent-message-card ${isUser ? "agent-message-card--user" : ""}`}>
        <p>{message.content}</p>
        {message.plan && (
          <AgentChangeList
            plan={message.plan}
            enabledMap={message.enabledChanges || createEnabledMap(message.plan)}
            compact
            interactive={false}
          />
        )}
      </div>
    </motion.div>
  );
};

const ImageKitAgent = ({ project, dominantColor, contrastingColor, lighterColor }) => {
  const { canvasEditor, setProcessingMessage } = useCanvas();
  const { mutate: updateProject } = useConvexMutation(api.projects.updateProject);
  const { mutate: createProjectRevision } = useConvexMutation(api.projects.createProjectRevision);
  const { mutate: restoreProjectRevision } = useConvexMutation(api.projects.restoreProjectRevision);
  const { data: revisions = [] } = useConvexQuery(
    api.projects.getProjectRevisions,
    project?._id ? { projectId: project._id, limit: 12 } : "skip"
  );
  const [input, setInput] = useState("Give it a premium editorial polish");
  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [activePlan, setActivePlan] = useState(null);
  const [enabledChanges, setEnabledChanges] = useState({});
  // Per-effect slider value map. Initialized from plan.entries on new plans; mutated as
  // the user drags. Lets the user tweak each adjustment without disabling it.
  const [effectValues, setEffectValues] = useState({});
  const [pendingPrompt, setPendingPrompt] = useState(null);
  const [isThinking, setIsThinking] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [restoringRevisionId, setRestoringRevisionId] = useState(null);
  const [autoPreview, setAutoPreview] = useState(true);
  const [, setImageRevision] = useState(0);
  const [upscaleComparison, setUpscaleComparison] = useState(null);
  const [isCompareOpen, setIsCompareOpen] = useState(false);
  const liveSnapshotRef = useRef(null);
  const chatEndRef = useRef(null);
  const previewPromiseRef = useRef(null);

  useEffect(() => {
    if (!canvasEditor) return undefined;
    const bump = () => setImageRevision((value) => value + 1);
    canvasEditor.on("selection:created", bump);
    canvasEditor.on("selection:updated", bump);
    canvasEditor.on("selection:cleared", bump);
    canvasEditor.on("object:modified", bump);
    return () => {
      canvasEditor.off("selection:created", bump);
      canvasEditor.off("selection:updated", bump);
      canvasEditor.off("selection:cleared", bump);
      canvasEditor.off("object:modified", bump);
    };
  }, [canvasEditor]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isThinking]);

  const activeImage = getCanvasActiveImage(canvasEditor);
  const sourceUrl = getSourceUrl(activeImage, project);
  const canChat = Boolean(activeImage && sourceUrl && isImageKitUrl(sourceUrl));

  const activeChangeSummary = useMemo(() => {
    if (!activePlan) return "No preview yet";
    const enabledCount = getChangeItems(activePlan).filter((item) => enabledChanges?.[item.id] !== false).length;
    const totalCount = getChangeItems(activePlan).length;
    return `${enabledCount}/${totalCount} changes enabled`;
  }, [activePlan, enabledChanges]);

  const restoreLiveSnapshot = async ({ keepSnapshot = false, pushHistory = true } = {}) => {
    if (!canvasEditor || !liveSnapshotRef.current) return;
    const snapshot = liveSnapshotRef.current;
    await canvasEditor.loadFromJSON(snapshot.canvas || snapshot);
    canvasEditor.discardActiveObject?.();
    canvasEditor.requestRenderAll();
    liveSnapshotRef.current = keepSnapshot ? snapshot : null;
    if (pushHistory) canvasEditor.__pushHistoryState?.();
    setImageRevision((value) => value + 1);
  };

  const previewPlanOnCanvas = async (plan, changeMap = enabledChanges, valueMap = effectValues) => {
    if (previewPromiseRef.current) return previewPromiseRef.current;

    const previewPromise = (async () => {
    if (!canvasEditor) return;
    if (liveSnapshotRef.current) {
      await restoreLiveSnapshot({ keepSnapshot: false, pushHistory: false });
    }

    const image = getCanvasActiveImage(canvasEditor);
    const baseUrl = plan?.sourceUrl || getSourceUrl(image, project);
    if (!image || !baseUrl) throw new Error("No active image to preview");

    liveSnapshotRef.current = serializeCanvasState(canvasEditor);
    const effectivePlan = buildEffectivePlan(plan, changeMap, baseUrl, valueMap);
    let targetImage = image;

    const isUpscalePlan = Array.isArray(effectivePlan?.imageKitTransforms)
      && effectivePlan.imageKitTransforms.some((t) => typeof t === 'string' && t.includes('e-upscale'));
    const beforeUrlForComparison = isUpscalePlan ? getSourceUrl(image, project) : null;

    if (effectivePlan?.url && effectivePlan.url !== getSourceUrl(image, project)) {
      let readyUrl = effectivePlan.url;

      if (hasImageKitAiTransform(effectivePlan.imageKitTransforms)) {
        try {
          readyUrl = await waitForImageKitUrl(effectivePlan.url, {
            maxAttempts: 10,
            retryDelayMs: 4000,
            onStatus: (attempt, total) => {
              setProcessingMessage?.(`ImageKit AI processing (${attempt}/${total})...`);
            },
          });
        } finally {
          setProcessingMessage?.(null);
        }
      }

      targetImage = await replaceCanvasImageFromUrl(canvasEditor, image, readyUrl, {
        preserveDisplayedBounds: true,
        placement: 'fit',
      });

      if (isUpscalePlan && targetImage) {
        const upscaledWidth = Math.max(1, Math.round(targetImage.width || project?.width || 1));
        const upscaledHeight = Math.max(1, Math.round(targetImage.height || project?.height || 1));
        if (beforeUrlForComparison) {
          setUpscaleComparison({ beforeUrl: beforeUrlForComparison, afterUrl: readyUrl, width: upscaledWidth, height: upscaledHeight });
        }
        toast.success(`Upscaled to ${upscaledWidth} × ${upscaledHeight}`, {
          description: 'Same visual size, higher resolution. Click Compare to view before/after.',
        });
      }
    }

    applyProfessionalFilters(targetImage, effectivePlan?.fabricAdjustments);
    canvasEditor.setActiveObject?.(targetImage);
    canvasEditor.requestRenderAll();
    canvasEditor.__pushHistoryState?.();
    setImageRevision((value) => value + 1);
    })();

    previewPromiseRef.current = previewPromise;
    try {
      return await previewPromise;
    } finally {
      if (previewPromiseRef.current === previewPromise) {
        previewPromiseRef.current = null;
      }
    }
  };

  const requestPlan = async (prompt) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    if (!canChat) {
      toast.error("Select an ImageKit-hosted image first");
      return;
    }

    const image = getCanvasActiveImage(canvasEditor);
    const latestUrl = getSourceUrl(image, project);
    const visibleMessages = [...messages, newMessage("user", cleanPrompt)]
      .slice(-8)
      .map(({ role, content }) => ({ role, content }));
    const toastId = toast.loading("Building edit plan", {
      description: truncate(cleanPrompt, 70),
    });

    setMessages((current) => [...current, newMessage("user", cleanPrompt)]);
    setInput("");
    setPendingPrompt(cleanPrompt);
    setIsThinking(true);

    // Extension intents ("extend by 20%", "outpaint left/right") still route through the
    // legacy endpoint — that path returns a special `extensionRequest` shape handled below.
    const isExtensionIntent = /\b(extend|outpaint|expand|widen|stretch)\b/i.test(cleanPrompt);

    try {
      let plan;
      let source = "fallback";

      if (isExtensionIntent) {
        // Legacy planner — returns extensionRequest for the AI extender flow.
        const response = await fetch("/api/imagekit/agent/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: cleanPrompt,
            messages: visibleMessages,
            sourceUrl: latestUrl,
            projectId: project?._id,
            project: {
              width: project?.width,
              height: project?.height,
              title: project?.title,
            },
            imageAnalysis: analyzeActiveImage(image, project),
          }),
        });
        const data = await response.json();
        if (!response.ok || !data?.success) throw new Error(data?.error || "Agent could not build an edit");
        plan = { ...data.plan, userPrompt: cleanPrompt };
        source = data.plan?.mode || "legacy";
      } else {
        // v2 endpoint — image-aware, deterministic, returns per-effect slider entries.
        const fingerprint = computeImageFingerprint(image);
        const features = extractImageFeatures(image);
        const response = await fetch("/api/ai/edit-plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: project?._id,
            prompt: cleanPrompt,
            sourceUrl: latestUrl,
            imageHash: fingerprint?.hash || `nohash-${latestUrl}`,
            features,
          }),
        });
        const data = await response.json();
        if (!response.ok || !data?.success) throw new Error(data?.error || "Agent could not build an edit");
        plan = adaptPlanV2(data.plan, latestUrl, cleanPrompt);
        source = data.source;
      }
      plan.source = source;

      // ──── Extension request: route to AI Extend instead of transforms ────
      if (plan.extensionRequest) {
        const ext = plan.extensionRequest;
        toast.loading("Extending image with AI...", { id: toastId });

        const extendRes = await fetch("/api/ai/extend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceUrl: latestUrl,
            expansion: {
              sourceWidth: ext.sourceWidth,
              sourceHeight: ext.sourceHeight,
              targetWidth: ext.targetWidth,
              targetHeight: ext.targetHeight,
              offsetX: ext.insets.left,
              offsetY: ext.insets.top,
              insets: ext.insets,
            },
            prompt: ext.prompt || "seamless natural continuation",
            targetWidth: ext.targetWidth,
            targetHeight: ext.targetHeight,
          }),
        });

        const extendData = await extendRes.json().catch(() => ({}));
        if (!extendRes.ok || !extendData?.url) {
          throw new Error(extendData?.error || "AI extension failed");
        }

        // Load the extended image onto the canvas
        const extendedImage = await replaceCanvasImageFromUrl(
          canvasEditor,
          image,
          extendData.url,
          { preserveDisplayedBounds: false, maxRetries: 2 }
        );

        canvasEditor.__fitCanvasToProject?.({
          width: ext.targetWidth,
          height: ext.targetHeight,
        });
        canvasEditor.setActiveObject?.(extendedImage);
        canvasEditor.requestRenderAll();
        canvasEditor.__pushHistoryState?.();

        setMessages((current) => [
          ...current,
          newMessage("assistant", `${plan.summary} — extended image loaded.`),
        ]);
        toast.success("Image extended", { id: toastId });
        return;
      }

      const nextEnabledChanges = createEnabledMap(plan);
      const nextValueMap = createValueMap(plan);
      setActivePlan(plan);
      setEnabledChanges(nextEnabledChanges);
      setEffectValues(nextValueMap);

      if (autoPreview) {
        await previewPlanOnCanvas(plan, nextEnabledChanges, nextValueMap);
      }

      setMessages((current) => [
        ...current,
        newMessage(
          "assistant",
          autoPreview
            ? `${plan.title}: preview is live on the canvas.`
            : `${plan.title}: the edit plan is ready to preview.`,
          { plan, autoPreview, enabledChanges: nextEnabledChanges }
        ),
      ]);
      toast.success(autoPreview ? "Preview ready" : "Plan ready", { id: toastId });
    } catch (error) {
      toast.error(error?.message || "Agent edit failed", { id: toastId });
      setMessages((current) => [
        ...current,
        newMessage("assistant", error?.message || "I could not complete that edit. Try a simpler request."),
      ]);
    } finally {
      setIsThinking(false);
      setPendingPrompt(null);
    }
  };

  const commitLiveEdit = async () => {
    if (!activePlan || !canvasEditor || !project) return;
    const toastId = toast.loading("Saving agent edit");
    setIsApplying(true);

    try {
      if (!liveSnapshotRef.current) {
        await previewPlanOnCanvas(activePlan, enabledChanges);
      }

      const effectivePlan = buildEffectivePlan(activePlan, enabledChanges, activePlan.sourceUrl || sourceUrl, effectValues);
      const enabledChangeDetails = getEnabledChangeDetails(activePlan, enabledChanges);
      const beforeSnapshot = liveSnapshotRef.current;

      if (beforeSnapshot) {
        await createProjectRevision({
          projectId: project._id,
          canvasState: beforeSnapshot,
          width: project.width,
          height: project.height,
          currentImageUrl: activePlan.sourceUrl || sourceUrl,
          activeTransformations: project.activeTransformations || "",
          title: `Before ${activePlan.title || "agent edit"}`,
          summary: "Canvas state before the agent edit was applied.",
          prompt: activePlan.userPrompt || activePlan.prompt || "",
          changes: enabledChangeDetails,
        });
      }

      const canvasState = serializeCanvasState(canvasEditor);
      await updateProject({
        projectId: project._id,
        currentImageUrl: effectivePlan?.url || activePlan.sourceUrl || sourceUrl,
        activeTransformations: effectivePlan?.imageKitTransforms?.join(",") || "",
        canvasState,
      });

      await createProjectRevision({
        projectId: project._id,
        canvasState,
        width: project.width,
        height: project.height,
        currentImageUrl: effectivePlan?.url || activePlan.sourceUrl || sourceUrl,
        activeTransformations: effectivePlan?.imageKitTransforms?.join(",") || "",
        title: activePlan.title || "Agent edit",
        summary: activePlan.summary || "Saved agent edit state.",
        prompt: activePlan.userPrompt || activePlan.prompt || "",
        changes: enabledChangeDetails,
      });

      liveSnapshotRef.current = null;
      toast.success("Agent edit saved", { id: toastId });
      setMessages((current) => [...current, newMessage("assistant", "Saved. The live edit is now part of this project.")]);
      setActivePlan(null);
      setEffectValues({});
      setEnabledChanges({});
    } catch (error) {
      toast.error(error?.message || "Failed to save edit", { id: toastId });
    } finally {
      setIsApplying(false);
    }
  };

  const revertLiveEdit = async () => {
    if (!liveSnapshotRef.current) return;
    await restoreLiveSnapshot();
    toast.message("Live preview reverted");
    setMessages((current) => [...current, newMessage("assistant", "Reverted the preview. The saved project was not changed.")]);
  };

  const copyUrl = async () => {
    const effectivePlan = buildEffectivePlan(activePlan, enabledChanges, activePlan?.sourceUrl || sourceUrl, effectValues);
    if (!effectivePlan?.url) return;
    await navigator.clipboard.writeText(effectivePlan.url);
    toast.success("Transformation URL copied");
  };

  const handleChangeToggle = async (changeId) => {
    if (!activePlan) return;
    const nextChanges = {
      ...enabledChanges,
      [changeId]: enabledChanges?.[changeId] === false,
    };
    setEnabledChanges(nextChanges);

    if (autoPreview || liveSnapshotRef.current) {
      try {
        await previewPlanOnCanvas(activePlan, nextChanges, effectValues);
      } catch (error) {
        toast.error(error?.message || "Could not update preview");
      }
    }
  };

  const handleEffectValueChange = async (key, nextValue, { commit = false } = {}) => {
    if (!activePlan) return;
    const numeric = Number(nextValue);
    if (!Number.isFinite(numeric)) return;
    const nextValues = { ...effectValues, [key]: numeric };
    setEffectValues(nextValues);
    // Live re-apply on every preview tick; commit triggers a history snapshot.
    if (autoPreview || liveSnapshotRef.current) {
      try {
        await previewPlanOnCanvas(activePlan, enabledChanges, nextValues);
      } catch (error) {
        if (commit) toast.error(error?.message || "Could not update preview");
      }
    }
  };

  const restoreRevision = async (revision) => {
    if (!revision?._id || !canvasEditor || !project) return;
    const toastId = toast.loading("Restoring saved version");
    setRestoringRevisionId(revision._id);

    try {
      const restored = await restoreProjectRevision({ revisionId: revision._id });
      liveSnapshotRef.current = null;
      setActivePlan(null);
      setEnabledChanges({});
      setEffectValues({});

      await restoreCanvasFromHistory(canvasEditor, restored.canvasState, {
        imageUrl: restored.currentImageUrl || project.currentImageUrl || project.originalImageUrl,
        hydrateOptions: {
          forcePrimaryImageUrl: true,
          canvasSize: { width: restored.width, height: restored.height },
        },
      });
      canvasEditor.__fitCanvasToProject?.({ width: restored.width, height: restored.height });
      canvasEditor.__pushHistoryState?.();
      setImageRevision((value) => value + 1);
      toast.success("Version restored", { id: toastId });
    } catch (error) {
      toast.error(error?.message || "Failed to restore version", { id: toastId });
    } finally {
      setRestoringRevisionId(null);
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    requestPlan(input);
  };

  return (
    <div className="agent-studio" style={{ "--agent-dominant": dominantColor, "--agent-soft": lighterColor }}>
      <motion.div
        className="agent-command-header"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="agent-command-mark" style={{ "--agent-mark": dominantColor, color: contrastingColor }}>
          <WandSparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="agent-kicker">ImageKit Studio</div>
          <h3>{canChat ? "Ready on selected image" : "Waiting for image"}</h3>
          <div className="agent-status-row">
            <span className={canChat ? "is-ready" : ""}>{canChat ? "Bound" : "Idle"}</span>
            <span>{activeChangeSummary}</span>
          </div>
        </div>
        <motion.button
          type="button"
          onClick={() => setAutoPreview((value) => !value)}
          className={`agent-toggle ${autoPreview ? "agent-toggle--on" : ""}`}
          aria-pressed={autoPreview}
          whileTap={{ scale: 0.96 }}
          title="Toggle preview mode"
        >
          <Zap className="h-3.5 w-3.5" />
          {autoPreview ? "Live" : "Manual"}
        </motion.button>
      </motion.div>

      <div className="agent-quick-rail">
        {QUICK_PROMPTS.map((item) => (
          <motion.button
            key={item.label}
            type="button"
            onClick={() => requestPlan(item.prompt)}
            disabled={!canChat || isThinking}
            className="agent-quick-card"
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.97 }}
          >
            <span>{item.label}</span>
            <small>{item.hint}</small>
          </motion.button>
        ))}
      </div>

      <div className="agent-chat-log panel-scroll">
        <div className="agent-chat-stack">
          <AnimatePresence initial={false}>
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {isThinking && (
              <AgentThinkingRow
                key="thinking-row"
                prompt={pendingPrompt}
                autoPreview={autoPreview}
              />
            )}
          </AnimatePresence>
          {isThinking && (
            <div className="agent-thinking-pill">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Building a preview you can inspect.
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
      </div>

      <AnimatePresence>
        {activePlan && (
          <motion.div
            className="agent-review-dock"
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="agent-review-head">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5" />
                  <h4>{activePlan.title}</h4>
                </div>
                <p>{activePlan.summary}</p>
              </div>
              <button type="button" onClick={copyUrl} className="agent-icon-action" title="Copy URL">
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="agent-review-subhead">
              <span>
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Changes
              </span>
              <strong>{getChangeItems(activePlan).filter((item) => enabledChanges?.[item.id] !== false).length}/{getChangeItems(activePlan).length} on</strong>
            </div>

            {activePlan.alreadyMatchesTarget && (Number(activePlan.gain) || 0) < 0.1 ? (
              <div className="agent-already-great">
                <Check className="h-3.5 w-3.5" />
                <div>
                  <strong>Already looks great</strong>
                  <p>
                    The image already matches the {STYLE_LABELS[activePlan.targetStyle] || activePlan.targetStyle || "requested"} look.
                    Drag a slider below if you want to push it further.
                  </p>
                </div>
              </div>
            ) : null}

            <AgentEffectControls
              plan={activePlan}
              enabledMap={enabledChanges}
              valueMap={effectValues}
              onToggle={handleChangeToggle}
              onValueChange={handleEffectValueChange}
              dominantColor={dominantColor}
            />

            <div className="agent-action-row">
              <motion.button
                type="button"
                onClick={() => previewPlanOnCanvas(activePlan, enabledChanges)}
                disabled={isThinking || isApplying}
                className="agent-action-button"
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
              >
                <BrainCircuit className="h-3.5 w-3.5" />
                Preview
              </motion.button>
              <motion.button
                type="button"
                onClick={revertLiveEdit}
                disabled={!liveSnapshotRef.current || isApplying}
                className="agent-action-button"
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Revert
              </motion.button>
              <motion.button
                type="button"
                onClick={commitLiveEdit}
                disabled={isApplying}
                className="agent-action-button agent-action-button--primary"
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
              >
                {isApplying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Save
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {revisions.length > 0 && (
        <motion.div
          className="agent-version-dock"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="agent-version-head">
            <span>
              <History className="h-3.5 w-3.5" />
              Saved versions
            </span>
            <small>{revisions.length}</small>
          </div>
          <div className="agent-version-row">
            {revisions.slice(0, 6).map((revision) => (
              <motion.button
                key={revision._id}
                type="button"
                className="agent-version-chip"
                onClick={() => restoreRevision(revision)}
                disabled={Boolean(restoringRevisionId)}
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
                title={revision.summary || revision.title || "Restore version"}
              >
                <span>{truncate(revision.title || "Saved edit", 24)}</span>
                <small>
                  {restoringRevisionId === revision._id ? "Restoring..." : formatRevisionTime(revision.createdAt)}
                </small>
              </motion.button>
            ))}
          </div>
        </motion.div>
      )}

      {!canChat && (
        <div className="agent-empty-note">
          <ImageIcon className="h-3.5 w-3.5" />
          Select an ImageKit-hosted canvas image.
        </div>
      )}

      <form onSubmit={handleSubmit} className="agent-composer">
        <div className="agent-command-prefix" aria-hidden="true">
          <Bot className="h-3.5 w-3.5" />
        </div>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              requestPlan(input);
            }
          }}
          placeholder="Ask for an edit..."
        />
        <motion.button
          type="submit"
          disabled={!canChat || isThinking || !input.trim()}
          className="agent-send-button"
          whileHover={{ scale: 1.04, rotate: 1 }}
          whileTap={{ scale: 0.95 }}
          title="Send"
        >
          {isThinking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </motion.button>
      </form>

      {upscaleComparison && (
        <button
          type='button'
          onClick={() => setIsCompareOpen(true)}
          className='mt-2 flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-semibold'
          style={{
            background: '#0E1118',
            border: '2px solid #F4F4F5',
            color: '#F4F4F5',
            boxShadow: '3px 3px 0 0 #06B8D4',
            fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
          }}
        >
          <ArrowLeftRight className='h-3.5 w-3.5' style={{ color: '#06B8D4' }} strokeWidth={2.5} />
          Compare Before / After
          <span style={{ color: '#06B8D4', marginLeft: 4 }}>
            {upscaleComparison.width} × {upscaleComparison.height}
          </span>
        </button>
      )}

      <BeforeAfterCompare
        open={isCompareOpen}
        beforeUrl={upscaleComparison?.beforeUrl}
        afterUrl={upscaleComparison?.afterUrl}
        beforeLabel='Original'
        afterLabel='Upscaled'
        onClose={() => setIsCompareOpen(false)}
      />
    </div>
  );
};

export default ImageKitAgent;
