"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bot,
  BrainCircuit,
  Check,
  Copy,
  History,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Plus,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
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
import {
  computeImageFingerprint,
  computeLayerThumbnail,
  computePerceptualHash,
} from "@/lib/image-fingerprint";
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

// ── Client-side ImageKit transform URL cache ──────────────────────────────
// Caches resolved AI transform URLs (the ones waitForImageKitUrl polls for)
// so toggling a transform off and on again is instant — no 10–30s re-poll.
// Key: full transform URL (e.g. "https://ik.imagekit.io/.../img.jpg?tr=e-upscale")
// Value: { resolvedUrl: string, timestamp: number }
const CLIENT_TRANSFORM_CACHE = new Map();
const CLIENT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const getCachedTransformUrl = (url) => {
  const entry = CLIENT_TRANSFORM_CACHE.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CLIENT_CACHE_TTL_MS) {
    CLIENT_TRANSFORM_CACHE.delete(url);
    return null;
  }
  return entry.resolvedUrl;
};

const setCachedTransformUrl = (url, resolvedUrl) => {
  CLIENT_TRANSFORM_CACHE.set(url, { resolvedUrl, timestamp: Date.now() });
  // Bound size — evict oldest if we exceed 100 entries
  if (CLIENT_TRANSFORM_CACHE.size > 100) {
    const oldest = CLIENT_TRANSFORM_CACHE.keys().next().value;
    CLIENT_TRANSFORM_CACHE.delete(oldest);
  }
};

// Check server-side cache (fire-and-forget safe — returns null on any error)
const checkServerTransformCache = async (url) => {
  try {
    const response = await fetch(
      `/api/imagekit/transform-cache?url=${encodeURIComponent(url)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data?.cached ? data.resolvedUrl : null;
  } catch {
    return null;
  }
};

// Write to server-side cache (fire-and-forget — errors are silently ignored)
const writeServerTransformCache = (url, resolvedUrl) => {
  fetch("/api/imagekit/transform-cache", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, resolvedUrl }),
  }).catch(() => { /* ignore */ });
};
// Initial messages constant referenced through the file. Defined after
// INITIAL_WELCOME_MESSAGE below to avoid the TDZ; the variable that ends up
// here is hoisted via the export below.

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

// ── Chat history persistence ────────────────────────────────────────────────
// Multi-thread session model. Each project has its own bag of threads (think
// Cursor/Windsurf "past chats"). Active thread id is persisted too so the user
// returns to whichever conversation they were in.
//
// Storage shape (v2):
//   {
//     activeThreadId: string,
//     threads: [
//       { id, title, createdAt, updatedAt, messages: Message[] },
//       ...
//     ]
//   }
//
// Plan/preview blobs can be large, so per-thread we cap message count and
// strip heavy fields from older messages.
const CHAT_STORAGE_VERSION = 2;
const CHAT_STORAGE_PREFIX = `pixxel-agent-chat-v${CHAT_STORAGE_VERSION}`;
const CHAT_LEGACY_V1_PREFIX = "pixxel-agent-chat-v1";
const CHAT_MAX_PERSISTED_MESSAGES = 60;
const CHAT_KEEP_PLANS_ON_RECENT = 6;
const CHAT_MAX_THREADS = 24;

const chatStorageKey = (projectId) =>
  projectId ? `${CHAT_STORAGE_PREFIX}:${projectId}` : null;
const chatLegacyKey = (projectId) =>
  projectId ? `${CHAT_LEGACY_V1_PREFIX}:${projectId}` : null;

const newThreadId = () =>
  `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const INITIAL_WELCOME_MESSAGE = {
  id: "assistant-initial",
  role: "assistant",
  content:
    "Select an image, describe the edit, and I will build a preview with the changes visible below.",
};

const makeEmptyThread = () => {
  const now = Date.now();
  return {
    id: newThreadId(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    messages: [INITIAL_WELCOME_MESSAGE],
  };
};

// Auto-title a thread from its first user message (the way Cursor / Claude do
// it). Falls back to "New chat" until the user actually sends something.
const inferThreadTitle = (messages) => {
  const firstUser = messages?.find?.((m) => m?.role === "user" && m?.content?.trim?.());
  if (!firstUser) return "New chat";
  const raw = firstUser.content.trim().replace(/\s+/g, " ");
  return raw.length > 48 ? `${raw.slice(0, 46)}…` : raw;
};

const trimMessagesForStorage = (messages) => {
  if (!Array.isArray(messages)) return [];
  const capped = messages.slice(-CHAT_MAX_PERSISTED_MESSAGES);
  const keepFrom = Math.max(0, capped.length - CHAT_KEEP_PLANS_ON_RECENT);
  return capped.map((message, index) => {
    if (index >= keepFrom) return message;
    if (!message || (!message.plan && !message.multiLayerPlans && !message.upscaleComparison)) {
      return message;
    }
    const { plan: _plan, multiLayerPlans: _mlp, upscaleComparison: _uc, ...lite } = message;
    return lite;
  });
};

const trimThreadsForStorage = (threads) => {
  if (!Array.isArray(threads)) return [];
  return threads
    .slice(-CHAT_MAX_THREADS)
    .map((thread) => ({
      ...thread,
      messages: trimMessagesForStorage(thread.messages),
    }));
};

const migrateLegacyV1 = (projectId) => {
  if (typeof window === "undefined") return null;
  const legacyKey = chatLegacyKey(projectId);
  if (!legacyKey) return null;
  try {
    const raw = window.localStorage.getItem(legacyKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const now = Date.now();
    const thread = {
      id: newThreadId(),
      title: inferThreadTitle(parsed),
      createdAt: now - 1,
      updatedAt: now,
      messages: parsed,
    };
    // Best-effort cleanup; if it fails the next save will overwrite the v2 key
    // anyway and the legacy entry just sits unused.
    try { window.localStorage.removeItem(legacyKey); } catch { /* ignore */ }
    return { activeThreadId: thread.id, threads: [thread] };
  } catch (error) {
    console.warn("[agent] failed to migrate legacy chat:", error?.message || error);
    return null;
  }
};

const loadStoredState = (projectId) => {
  if (typeof window === "undefined") return null;
  const key = chatStorageKey(projectId);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.threads) && parsed.threads.length) {
        // Repair: make sure activeThreadId points at something real.
        const hasActive = parsed.threads.some((t) => t.id === parsed.activeThreadId);
        return {
          activeThreadId: hasActive ? parsed.activeThreadId : parsed.threads[parsed.threads.length - 1].id,
          threads: parsed.threads,
        };
      }
    }
  } catch (error) {
    console.warn("[agent] failed to read chat history:", error?.message || error);
  }
  // No v2 entry — try migrating a v1 flat array.
  return migrateLegacyV1(projectId);
};

const saveStoredState = (projectId, state) => {
  if (typeof window === "undefined") return;
  const key = chatStorageKey(projectId);
  if (!key) return;
  try {
    const trimmed = {
      activeThreadId: state.activeThreadId,
      threads: trimThreadsForStorage(state.threads),
    };
    window.localStorage.setItem(key, JSON.stringify(trimmed));
  } catch (error) {
    console.warn("[agent] failed to write chat history:", error?.message || error);
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
  }
};

const clearAllThreads = (projectId) => {
  if (typeof window === "undefined") return;
  const key = chatStorageKey(projectId);
  if (!key) return;
  try { window.localStorage.removeItem(key); } catch { /* ignore */ }
};

// Initial messages array (used as a default for new threads or when no stored
// state exists yet). Lives below the storage block so INITIAL_WELCOME_MESSAGE
// is already initialized.
const INITIAL_MESSAGES = [INITIAL_WELCOME_MESSAGE];

// Format a unix ms timestamp as a relative label ("now", "5m", "2h", "3d",
// "Jan 12"). Matches the compact style of the rest of the editor's UI.
const formatRelativeTime = (ms) => {
  if (!ms || !Number.isFinite(ms)) return "";
  const delta = Math.max(0, Date.now() - ms);
  const sec = Math.floor(delta / 1000);
  if (sec < 45) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const getSourceUrl = (image, project) =>
  image?.getSrc?.() ||
  image?._originalElement?.src ||
  image?._element?.src ||
  project?.currentImageUrl ||
  project?.originalImageUrl ||
  "";

const isVisibleImageOnCanvas = (obj) =>
  obj && obj.type?.toLowerCase?.() === "image" && obj.visible !== false;

// Collect every visible image on the canvas as a layer payload for the
// multi-image targeting endpoint. Each entry carries enough data for the
// server to: (a) ask Gemini which layers the user is talking about
// (thumbnail + name) and (b) compute a per-image plan (sourceUrl + hash).
const collectLayersForTargeting = (canvasEditor, project) => {
  const objects = canvasEditor?.getObjects?.() || [];
  const visibleImages = objects.filter(isVisibleImageOnCanvas);
  return visibleImages.map((img, idx) => {
    const fingerprint = computeImageFingerprint(img);
    const pHash = computePerceptualHash(img);
    const thumb = computeLayerThumbnail(img, 256);
    const layerName =
      (typeof img.pixxelLayerName === "string" && img.pixxelLayerName.trim()) ||
      (typeof img.name === "string" && img.name.trim()) ||
      `Image ${idx + 1}`;
    return {
      index: idx,
      name: layerName,
      sourceUrl: getSourceUrl(img, project),
      imageHash: fingerprint?.hash || `nohash-${idx}`,
      pHash: pHash || null,
      features: extractImageFeatures(img),
      thumbBase64: thumb?.base64 || null,
      thumbMime: thumb?.mime || null,
      // Reference to the canvas object so we can apply per-layer filters later.
      __canvasObject: img,
    };
  });
};

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
//
// Only truly server-only AI operations route through ImageKit URL transforms.
// Contrast and sharpness are deliberately omitted — those are basic adjustments
// Fabric.js handles natively, instantly, and without a round-trip. Otherwise
// the plan would double-apply them (once via URL, once via Fabric filter) and
// also force an extra ImageKit fetch per slider drag.
const IMAGEKIT_AI_TOKENS = {
  bgRemove: "e-bgremove",
  upscale: "e-upscale",
  retouch: "e-retouch",
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
  // Default prompt is shown as a placeholder (not a pre-filled value). When the
  // user presses Enter on an empty input, this text is sent to the agent — so
  // first-time users can just hit Enter to get a sensible default edit.
  const DEFAULT_PROMPT = "Give it a premium editorial polish";
  const [input, setInput] = useState("");
  const inputRef = useRef(null);
  // Multi-thread chat state. The component's existing code path treats messages
  // as a single flat list; we keep that contract by deriving `messages` from
  // the active thread and routing `setMessages` updates back into the threads
  // object. That way history features (new chat, switch thread, delete thread)
  // can live alongside the rest of the agent without rewriting message flow.
  const [chatState, setChatState] = useState(() => {
    const restored = loadStoredState(project?._id);
    if (restored) return restored;
    const fresh = makeEmptyThread();
    return { activeThreadId: fresh.id, threads: [fresh] };
  });
  const lastLoadedProjectIdRef = useRef(project?._id);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  const activeThread = useMemo(
    () =>
      chatState.threads.find((t) => t.id === chatState.activeThreadId) ||
      chatState.threads[chatState.threads.length - 1] ||
      null,
    [chatState]
  );
  const messages = activeThread?.messages || INITIAL_MESSAGES;

  // Drop-in replacement for the previous `setMessages`. Accepts either a new
  // array or an updater fn; routes the result into the active thread and
  // refreshes the thread's updatedAt + auto-title.
  const setMessages = useCallback(
    (updater) => {
      setChatState((current) => {
        const activeId = current.activeThreadId;
        const threads = current.threads.map((thread) => {
          if (thread.id !== activeId) return thread;
          const next =
            typeof updater === "function" ? updater(thread.messages) : updater;
          const isOnlyInitial =
            next.length === 1 && next[0]?.id === INITIAL_WELCOME_MESSAGE.id;
          return {
            ...thread,
            messages: next,
            updatedAt: Date.now(),
            title: isOnlyInitial ? "New chat" : inferThreadTitle(next),
          };
        });
        return { ...current, threads };
      });
    },
    []
  );

  const startNewThread = useCallback(() => {
    setChatState((current) => {
      const fresh = makeEmptyThread();
      return {
        activeThreadId: fresh.id,
        threads: [...current.threads, fresh],
      };
    });
    setIsHistoryOpen(false);
    // Focus the composer so the user can type immediately.
    requestAnimationFrame(() => inputRef.current?.focus?.());
  }, []);

  const switchToThread = useCallback((threadId) => {
    setChatState((current) =>
      current.threads.some((t) => t.id === threadId)
        ? { ...current, activeThreadId: threadId }
        : current
    );
    setIsHistoryOpen(false);
  }, []);

  const deleteThread = useCallback((threadId) => {
    setChatState((current) => {
      const remaining = current.threads.filter((t) => t.id !== threadId);
      if (remaining.length === 0) {
        const fresh = makeEmptyThread();
        return { activeThreadId: fresh.id, threads: [fresh] };
      }
      const stillActive = remaining.some((t) => t.id === current.activeThreadId);
      return {
        activeThreadId: stillActive
          ? current.activeThreadId
          : remaining[remaining.length - 1].id,
        threads: remaining,
      };
    });
  }, []);
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
  // Multi-layer state. When >1 image is on the canvas and the user's prompt is
  // ambiguous, the server returns a list of candidate layers we need the user
  // to confirm. When they pick, we re-request with confirmedTargetIndexes.
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [confirmedLayerIds, setConfirmedLayerIds] = useState([]);
  // Per-layer plans for multi-target edits. Each entry: { layerIndex, layerName, canvasObject, plan }.
  const [multiLayerPlans, setMultiLayerPlans] = useState([]);
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

  // Reload history when switching projects.
  useEffect(() => {
    const currentId = project?._id;
    if (!currentId || currentId === lastLoadedProjectIdRef.current) return;
    lastLoadedProjectIdRef.current = currentId;
    const restored = loadStoredState(currentId);
    if (restored) {
      setChatState(restored);
    } else {
      const fresh = makeEmptyThread();
      setChatState({ activeThreadId: fresh.id, threads: [fresh] });
    }
  }, [project?._id]);

  // Persist on every chat-state change. We skip the case where there's exactly
  // one thread whose only message is the welcome blurb — no point overwriting
  // an existing stored chat with an "empty" default.
  useEffect(() => {
    const projectId = project?._id;
    if (!projectId) return;
    const onlyEmptyThread =
      chatState.threads.length === 1 &&
      chatState.threads[0].messages.length === 1 &&
      chatState.threads[0].messages[0]?.id === INITIAL_WELCOME_MESSAGE.id;
    if (onlyEmptyThread) return;
    saveStoredState(projectId, chatState);
  }, [chatState, project?._id]);

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
        // 1. Check client-side cache first (instant)
        const clientCached = getCachedTransformUrl(effectivePlan.url);
        if (clientCached) {
          readyUrl = clientCached;
          console.log("[Agent] Transform cache hit (client)", { url: effectivePlan.url });
        } else {
          // 2. Check server-side cache (fast, one round-trip)
          const serverCached = await checkServerTransformCache(effectivePlan.url);
          if (serverCached) {
            readyUrl = serverCached;
            setCachedTransformUrl(effectivePlan.url, serverCached);
            console.log("[Agent] Transform cache hit (server)", { url: effectivePlan.url });
          } else {
            // 3. Cache miss — poll ImageKit (slow, 10–30s first time)
            try {
              readyUrl = await waitForImageKitUrl(effectivePlan.url, {
                maxAttempts: 10,
                retryDelayMs: 4000,
                onStatus: (attempt, total) => {
                  setProcessingMessage?.(`ImageKit AI processing (${attempt}/${total})...`);
                },
              });
              // Write to both caches on success
              setCachedTransformUrl(effectivePlan.url, readyUrl);
              writeServerTransformCache(effectivePlan.url, readyUrl);
            } finally {
              setProcessingMessage?.(null);
            }
          }
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

  // Apply each layer's plan's Fabric adjustments to its own canvas image. Used
  // by the multi-target path — bypasses previewPlanOnCanvas (which assumes a
  // single active image).
  const applyMultiLayerPlansToCanvas = (plans) => {
    if (!canvasEditor || !Array.isArray(plans) || plans.length === 0) return;
    if (!liveSnapshotRef.current) {
      liveSnapshotRef.current = serializeCanvasState(canvasEditor);
    }
    for (const entry of plans) {
      const target = entry?.canvasObject;
      const adjustments = entry?.plan?.fabricAdjustments || {};
      if (!target || Object.keys(adjustments).length === 0) continue;
      applyProfessionalFilters(target, adjustments);
    }
    canvasEditor.requestRenderAll();
    canvasEditor.__pushHistoryState?.();
    setImageRevision((value) => value + 1);
  };

  const requestPlan = async (prompt, options = {}) => {
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

    // Multi-layer detection: if the canvas has 2+ visible images, collect them
    // and let the server's targeting step pick which ones the prompt applies to.
    const allLayers = collectLayersForTargeting(canvasEditor, project);
    const isMultiLayer = !isExtensionIntent && allLayers.length >= 2;

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
      } else if (isMultiLayer) {
        // Multi-image flow: send all visible layers, let the server pick targets.
        const layersPayload = allLayers.map((l) => ({
          index: l.index,
          name: l.name,
          sourceUrl: l.sourceUrl,
          imageHash: l.imageHash,
          pHash: l.pHash,
          features: l.features,
          thumbBase64: l.thumbBase64,
          thumbMime: l.thumbMime,
        }));
        const response = await fetch("/api/ai/edit-plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: project?._id,
            prompt: cleanPrompt,
            layers: layersPayload,
            confirmedTargetIndexes: options.confirmedTargetIndexes || undefined,
          }),
        });
        const data = await response.json();
        if (!response.ok || !data?.success) throw new Error(data?.error || "Agent could not build an edit");

        // Confirmation needed — show the candidate layers and bail out of
        // the normal plan flow until the user picks.
        if (data.needsConfirmation) {
          setPendingConfirmation({
            prompt: cleanPrompt,
            candidates: data.candidates || allLayers.map((l) => l.index),
            allLayers: allLayers.map((l) => ({ index: l.index, name: l.name })),
            reason: data.reason || "Which layers should I edit?",
          });
          setConfirmedLayerIds(data.candidates || allLayers.map((l) => l.index));
          toast.message("Confirm which layers", { id: toastId, description: data.reason });
          setMessages((current) => [
            ...current,
            newMessage(
              "assistant",
              `${data.reason || "Which layers should I edit?"} Pick from the panel below.`
            ),
          ]);
          return;
        }

        // Apply per-layer plans
        const layerPlanEntries = (data.plans || [])
          .filter((p) => p?.plan)
          .map((entry) => {
            const layer = allLayers.find((l) => l.index === entry.layerIndex);
            return {
              layerIndex: entry.layerIndex,
              layerName: layer?.name || `Image ${entry.layerIndex + 1}`,
              canvasObject: layer?.__canvasObject,
              plan: adaptPlanV2(entry.plan, layer?.sourceUrl || "", cleanPrompt),
            };
          });

        if (layerPlanEntries.length === 0) {
          throw new Error("Agent did not return any plans");
        }

        setMultiLayerPlans(layerPlanEntries);
        applyMultiLayerPlansToCanvas(layerPlanEntries);

        const names = layerPlanEntries.map((e) => e.layerName).join(", ");
        setMessages((current) => [
          ...current,
          newMessage(
            "assistant",
            `Applied to ${layerPlanEntries.length} layer${layerPlanEntries.length === 1 ? "" : "s"}: ${names}.`,
          ),
        ]);
        toast.success(`Edited ${layerPlanEntries.length} layer${layerPlanEntries.length === 1 ? "" : "s"}`, { id: toastId });
        return;
      } else {
        // v2 endpoint — single image, image-aware, deterministic, returns per-effect slider entries.
        const fingerprint = computeImageFingerprint(image);
        const pHash = computePerceptualHash(image);
        const features = extractImageFeatures(image);
        const response = await fetch("/api/ai/edit-plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: project?._id,
            prompt: cleanPrompt,
            sourceUrl: latestUrl,
            imageHash: fingerprint?.hash || `nohash-${latestUrl}`,
            pHash,
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
    // Submit button + empty input → send the placeholder default. Same logic
    // as the Enter handler below; mirrored here so both paths agree.
    const promptToSend = input.trim() ? input : DEFAULT_PROMPT;
    requestPlan(promptToSend);
  };

  // Autofocus the input whenever the agent tool becomes mountable (it mounts
  // as soon as the user clicks the Agent tab in the sidebar). The user can
  // start typing immediately, or just hit Enter for the default prompt.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="agent-studio" style={{ "--agent-dominant": dominantColor, "--agent-soft": lighterColor }}>
      <motion.div
        className="agent-command-header"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="agent-command-mark" style={{ "--agent-mark": dominantColor, color: contrastingColor }}>
          <WandSparkles className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1 agent-command-info">
          <h3>{canChat ? "Ready" : "Waiting for image"}</h3>
          <p className={`agent-command-sub ${canChat ? "is-ready" : ""}`}>
            <span className="agent-command-dot" aria-hidden="true" />
            {canChat ? activeChangeSummary : "Select an image to begin"}
          </p>
        </div>
        <div className="agent-header-actions">
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
          <motion.button
            type="button"
            onClick={startNewThread}
            className="agent-icon-button"
            whileTap={{ scale: 0.94 }}
            title="Start a new chat"
            aria-label="Start a new chat"
          >
            <Plus className="h-3.5 w-3.5" />
          </motion.button>
          <motion.button
            type="button"
            onClick={() => setIsHistoryOpen((value) => !value)}
            className={`agent-icon-button ${isHistoryOpen ? "agent-icon-button--active" : ""}`}
            whileTap={{ scale: 0.94 }}
            title="Browse chat history"
            aria-label="Browse chat history"
            aria-expanded={isHistoryOpen}
          >
            <History className="h-3.5 w-3.5" />
          </motion.button>
        </div>
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

      <div className="agent-chat-area">
        <AnimatePresence>
          {isHistoryOpen && (
            <motion.div
              key="history-panel"
              className="agent-history-panel"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="agent-history-head">
                <div className="agent-history-title">
                  <History className="h-3.5 w-3.5" />
                  <span>Chat history</span>
                  <em>{chatState.threads.length} thread{chatState.threads.length === 1 ? "" : "s"}</em>
                </div>
                <button
                  type="button"
                  className="agent-icon-button"
                  onClick={() => setIsHistoryOpen(false)}
                  title="Close history"
                  aria-label="Close history"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <button
                type="button"
                className="agent-history-new"
                onClick={startNewThread}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Start a new chat</span>
              </button>
              <div className="agent-history-list panel-scroll">
                {[...chatState.threads]
                  .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                  .map((thread) => {
                    const isActive = thread.id === chatState.activeThreadId;
                    const userCount = thread.messages.filter((m) => m?.role === "user").length;
                    return (
                      <div
                        key={thread.id}
                        className={`agent-history-row ${isActive ? "is-active" : ""}`}
                      >
                        <button
                          type="button"
                          className="agent-history-row-main"
                          onClick={() => switchToThread(thread.id)}
                          title={thread.title}
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                          <span className="agent-history-row-title">{thread.title}</span>
                          <span className="agent-history-row-meta">
                            <em>{userCount} msg{userCount === 1 ? "" : "s"}</em>
                            <span className="agent-history-dot" aria-hidden="true">·</span>
                            <em>{formatRelativeTime(thread.updatedAt)}</em>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="agent-history-row-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteThread(thread.id);
                          }}
                          title="Delete this chat"
                          aria-label={`Delete ${thread.title}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                {chatState.threads.length > 1 && (
                  <button
                    type="button"
                    className="agent-history-clear-all"
                    onClick={() => {
                      clearAllThreads(project?._id);
                      const fresh = makeEmptyThread();
                      setChatState({ activeThreadId: fresh.id, threads: [fresh] });
                      setIsHistoryOpen(false);
                      toast.success("Cleared all chat history for this project");
                    }}
                  >
                    <RotateCcw className="h-3 w-3" />
                    Clear all threads
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
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
      </div>

      {/* Multi-layer confirmation panel: shown when the agent isn't sure which
          layers the prompt was referring to. User picks → re-request. */}
      <AnimatePresence>
        {pendingConfirmation && (
          <motion.div
            className="agent-review-dock"
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            key="confirm"
          >
            <div className="agent-review-head">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5" />
                  <h4>Confirm layers</h4>
                </div>
                <p>{pendingConfirmation.reason}</p>
              </div>
            </div>
            <div className="agent-layer-confirm-list">
              {pendingConfirmation.allLayers.map((layer) => {
                const checked = confirmedLayerIds.includes(layer.index);
                return (
                  <label key={layer.index} className="agent-layer-confirm-row">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        setConfirmedLayerIds((current) =>
                          e.target.checked
                            ? [...new Set([...current, layer.index])]
                            : current.filter((id) => id !== layer.index)
                        );
                      }}
                    />
                    <span>{layer.name}</span>
                  </label>
                );
              })}
            </div>
            <div className="agent-action-row">
              <motion.button
                type="button"
                onClick={() => {
                  const confirmed = [...confirmedLayerIds];
                  const promptToReuse = pendingConfirmation.prompt;
                  setPendingConfirmation(null);
                  requestPlan(promptToReuse, { confirmedTargetIndexes: confirmed });
                }}
                disabled={confirmedLayerIds.length === 0 || isThinking}
                className="agent-action-button agent-action-button--primary"
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
              >
                <Check className="h-3.5 w-3.5" />
                Apply to {confirmedLayerIds.length} layer{confirmedLayerIds.length === 1 ? "" : "s"}
              </motion.button>
              <motion.button
                type="button"
                onClick={() => {
                  setPendingConfirmation(null);
                  setConfirmedLayerIds([]);
                }}
                className="agent-action-button"
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
              >
                Cancel
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Multi-layer applied status: shown after a multi-target edit lands. */}
      <AnimatePresence>
        {!pendingConfirmation && multiLayerPlans.length > 0 && !activePlan && (
          <motion.div
            className="agent-review-dock"
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            key="multi"
          >
            <div className="agent-review-head">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5" />
                  <h4>Applied to {multiLayerPlans.length} layer{multiLayerPlans.length === 1 ? "" : "s"}</h4>
                </div>
                <p>{multiLayerPlans.map((p) => p.layerName).join(" · ")}</p>
              </div>
            </div>
            <div className="agent-action-row">
              <motion.button
                type="button"
                onClick={async () => {
                  await restoreLiveSnapshot();
                  setMultiLayerPlans([]);
                  toast.message("Reverted");
                }}
                disabled={!liveSnapshotRef.current}
                className="agent-action-button"
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Revert
              </motion.button>
              <motion.button
                type="button"
                onClick={() => {
                  // Multi-layer save: filters are already on the canvas; persist canvas state.
                  canvasEditor?.__saveCanvasState?.();
                  liveSnapshotRef.current = null;
                  setMultiLayerPlans([]);
                  toast.success("Saved");
                }}
                className="agent-action-button agent-action-button--primary"
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
              >
                <Check className="h-3.5 w-3.5" />
                Keep
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

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
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              // Empty input → send the placeholder text as the prompt so a
              // first-time user can hit Enter and get a sensible default edit.
              const promptToSend = input.trim() ? input : DEFAULT_PROMPT;
              requestPlan(promptToSend);
            }
          }}
          placeholder={DEFAULT_PROMPT}
        />
        <motion.button
          type="submit"
          disabled={!canChat || isThinking}
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
