"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  GripHorizontal,
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
  User,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useCanvas } from "../../../../../../../context/context";
import { useDatabaseMutation, useDatabaseQuery } from "../../../../../../../hooks/useDatabaseQuery";
import { api } from "@/lib/neon-api";
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
import { flattenLiveCanvasForAnalysis, renderFabricObjectElement } from "@/lib/canvas-snapshot";
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
  at: Date.now(),
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
// Mirror the server's MAX_LAYERS cap (in the edit-plan route) so the client
// never renders/encodes more layers than the server will accept — otherwise a
// canvas with many images would do N wasted renders + base64 encodes before the
// server truncates to 12.
const MAX_AGENT_LAYERS = 12;
// Mirror the server's MAX_RENDERED_BASE64_CHARS bound so we never POST a render
// the server would just discard.
const MAX_AGENT_RENDER_CHARS = 3 * 1024 * 1024;

const collectLayersForTargeting = (canvasEditor, project) => {
  const objects = canvasEditor?.getObjects?.() || [];
  const visibleImages = objects.filter(isVisibleImageOnCanvas).slice(0, MAX_AGENT_LAYERS);
  const isMultiLayer = visibleImages.length >= 2;
  return visibleImages.map((img, idx) => {
    // Render THIS layer WITH its current filters/masks applied so the agent's
    // context (hash / perceptual hash / features / thumbnail / grading bytes)
    // reflects manual edits rather than the immutable original bitmap. Only
    // worth doing in the multi-layer case — the single-image path flattens the
    // whole canvas itself. Falls back to the raw FabricImage if the per-object
    // render fails (e.g. a tainted or WebGL-filtered layer).
    const renderedEl = isMultiLayer ? renderFabricObjectElement(img, { maxEdge: 1024 }) : null;
    const analysisSource = renderedEl || img;
    let renderedBase64 = null;
    let renderedMime = null;
    if (renderedEl) {
      try {
        const durl = renderedEl.toDataURL("image/jpeg", 0.85);
        const commaIdx = durl.indexOf(",");
        if (commaIdx >= 0) {
          renderedBase64 = durl.slice(commaIdx + 1);
          renderedMime = "image/jpeg";
        }
      } catch {
        /* tainted layer — leave null; server falls back to the layer's sourceUrl */
      }
    }
    const fingerprint = computeImageFingerprint(analysisSource);
    const pHash = computePerceptualHash(analysisSource);
    const thumb = computeLayerThumbnail(analysisSource, 256);
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
      features: extractImageFeatures(analysisSource),
      thumbBase64: thumb?.base64 || null,
      thumbMime: thumb?.mime || null,
      // Flattened render of this layer (reflects manual edits) for grading.
      renderedBase64,
      renderedMime,
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

const compactPayload = (payload) =>
  Object.fromEntries(Object.entries(payload || {}).filter(([, value]) => value !== undefined));

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

const AgentChangeList = React.memo(({ plan, enabledMap = {}, onToggle, compact = false, interactive = true }) => {
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
        No changes needed for this prompt.
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
});
AgentChangeList.displayName = "AgentChangeList";

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

const formatMessageTime = (at) => {
  if (!at) return "";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return new Date(at).toLocaleDateString();
};

const MessageBubble = ({ message, canUndoPreview = false, onUndoPreview, isApplying = false }) => {
  const isUser = message.role === "user";
  const hasUndoablePreview = !isUser && Boolean(message.previewToken);

  const copyContent = () => {
    try {
      navigator.clipboard?.writeText(message.content || "");
      toast.success("Copied");
    } catch {
      toast.error("Couldn't copy");
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className={`agent-message-line ${isUser ? "agent-message-line--user" : ""}`}
    >
      <div className="agent-message-meta">
        <span
          className={`agent-message-avatar ${isUser ? "agent-message-avatar--user" : ""}`}
          title={isUser ? "You" : "Agent"}
        >
          {isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
        </span>
        {message.at && (
          <span className="agent-message-time">{formatMessageTime(message.at)}</span>
        )}
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
        {!isUser && (message.content || "").length > 0 && (
          <button
            type="button"
            className="agent-message-copy"
            onClick={copyContent}
            title="Copy message"
            aria-label="Copy message"
          >
            <Copy className="h-3 w-3" />
          </button>
        )}
        {hasUndoablePreview && (
          <div className="agent-message-actions">
            <button
              type="button"
              className="agent-message-action"
              onClick={() => onUndoPreview?.(message)}
              disabled={!canUndoPreview || isApplying}
              title={canUndoPreview ? "Undo this whole preview" : "This preview is no longer active"}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {canUndoPreview ? "Undo preview" : "Preview settled"}
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
};

const ImageKitAgent = ({ project, dominantColor, contrastingColor, lighterColor }) => {
  const { canvasEditor, setProcessingMessage } = useCanvas();
  const { mutate: updateProject } = useDatabaseMutation(api.projects.updateProject);
  const { mutate: createProjectRevision } = useDatabaseMutation(api.projects.createProjectRevision);
  const { mutate: restoreProjectRevision } = useDatabaseMutation(api.projects.restoreProjectRevision);
  const { mutate: createOrUpdateAgentEditSet } = useDatabaseMutation(api.agentEditSets.createOrUpdateDraft);
  const { mutate: markAgentEditSetApplied } = useDatabaseMutation(api.agentEditSets.markApplied);
  const { mutate: markAgentEditSetPending } = useDatabaseMutation(api.agentEditSets.markPending);
  const { mutate: markAgentEditSetRemoved } = useDatabaseMutation(api.agentEditSets.markRemoved);
  const { data: revisions = [] } = useDatabaseQuery(
    api.projects.getProjectRevisions,
    project?._id ? { projectId: project._id, limit: 12 } : "skip"
  );
  const { data: agentEditSets = [] } = useDatabaseQuery(
    api.agentEditSets.listForProject,
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
  const [activeEditSetId, setActiveEditSetId] = useState(null);
  const [, setImageRevision] = useState(0);
  // Canvas-history undo/redo state, mirrored into the agent header so its edits
  // (which all push onto the global history) can be stepped back and forth here.
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [upscaleComparison, setUpscaleComparison] = useState(null);
  const [isCompareOpen, setIsCompareOpen] = useState(false);
  const liveSnapshotRef = useRef(null);
  const livePreviewTokenRef = useRef(null);
  const previewTokenSerialRef = useRef(0);
  const [livePreviewToken, setLivePreviewToken] = useState(null);
  const chatEndRef = useRef(null);
  const previewPromiseRef = useRef(null);
  // Mounted guard + in-flight poll abort. The send/preview flow awaits a
  // 10–30s ImageKit poll; if the panel unmounts mid-poll (user switches tools)
  // the post-await setState calls would warn/leak. isMountedRef gates them and
  // pollAbortRef cancels the active waitForImageKitUrl. Mirrors erase.jsx.
  const isMountedRef = useRef(true);
  const pollAbortRef = useRef(null);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      pollAbortRef.current?.abort();
    };
  }, []);

  // Resizable Edits Section State
  const [editsHeight, setEditsHeight] = useState(null);
  const [isEditsMinimized, setIsEditsMinimized] = useState(false);
  const editsDragStartY = useRef(null);
  const editsDragStartHeight = useRef(null);
  const editsContainerRef = useRef(null);

  const handleEditsDragMove = useCallback((e) => {
    if (editsDragStartY.current === null || editsDragStartHeight.current === null) return;
    const dy = editsDragStartY.current - e.clientY;
    const newHeight = Math.max(64, editsDragStartHeight.current + dy);
    setEditsHeight(newHeight);
    setIsEditsMinimized(newHeight < 120);
  }, []);

  const handleEditsDragEnd = useCallback(() => {
    editsDragStartY.current = null;
    document.removeEventListener("mousemove", handleEditsDragMove);
    document.removeEventListener("mouseup", handleEditsDragEnd);
  }, [handleEditsDragMove]);

  const handleEditsDragStart = useCallback((e) => {
    e.preventDefault();
    editsDragStartY.current = e.clientY;
    if (editsContainerRef.current) {
      editsDragStartHeight.current = editsContainerRef.current.getBoundingClientRect().height;
    }
    document.addEventListener("mousemove", handleEditsDragMove);
    document.addEventListener("mouseup", handleEditsDragEnd);
  }, [handleEditsDragMove, handleEditsDragEnd]);

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

  // Mirror the canvas undo/redo availability into the agent header.
  useEffect(() => {
    if (!canvasEditor) {
      setCanUndo(false);
      setCanRedo(false);
      return undefined;
    }
    const sync = () => {
      const state = canvasEditor.__getHistoryState?.();
      if (state) {
        setCanUndo(Boolean(state.canUndo));
        setCanRedo(Boolean(state.canRedo));
      }
    };
    sync();
    canvasEditor.on("history:changed", sync);
    return () => canvasEditor.off("history:changed", sync);
  }, [canvasEditor]);

  const handleAgentUndo = useCallback(async () => {
    if (!canvasEditor?.__undoCanvasState) return;
    // Step out of any un-applied live preview first, then walk canvas history.
    if (livePreviewTokenRef.current && liveSnapshotRef.current) {
      await restoreLiveSnapshot();
      setActivePlan(null);
      setEffectValues({});
      setEnabledChanges({});
      setMultiLayerPlans([]);
      setImageRevision((value) => value + 1);
      return;
    }
    const didUndo = await canvasEditor.__undoCanvasState();
    if (didUndo) {
      await canvasEditor.__saveCanvasState?.();
      setImageRevision((value) => value + 1);
    } else {
      toast.message("Nothing to undo");
    }
    // restoreLiveSnapshot is declared below and is ref-driven (stable behaviour);
    // it can't go in the dep array without a TDZ, and isn't needed there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasEditor]);

  const handleAgentRedo = useCallback(async () => {
    if (!canvasEditor?.__redoCanvasState) return;
    const didRedo = await canvasEditor.__redoCanvasState();
    if (didRedo) {
      await canvasEditor.__saveCanvasState?.();
      setImageRevision((value) => value + 1);
    } else {
      toast.message("Nothing to redo");
    }
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

  const startLivePreviewSession = useCallback(() => {
    const token = `preview-${Date.now()}-${previewTokenSerialRef.current++}`;
    livePreviewTokenRef.current = token;
    setLivePreviewToken(token);
    return token;
  }, []);

  const clearLivePreviewSession = useCallback(() => {
    livePreviewTokenRef.current = null;
    setLivePreviewToken(null);
  }, []);

  const restoreLiveSnapshot = async ({ keepSnapshot = false, pushHistory = true } = {}) => {
    if (!canvasEditor || !liveSnapshotRef.current) return;
    const snapshot = liveSnapshotRef.current;
    await canvasEditor.loadFromJSON(snapshot.canvas || snapshot);
    canvasEditor.discardActiveObject?.();
    canvasEditor.requestRenderAll();
    liveSnapshotRef.current = keepSnapshot ? snapshot : null;
    if (!keepSnapshot) clearLivePreviewSession();
    if (pushHistory) canvasEditor.__pushHistoryState?.({ label: "Restore agent preview", domain: "imagekit" });
    setImageRevision((value) => value + 1);
  };

  const serializeMultiLayerEditSet = (entries = multiLayerPlans) => ({
    mode: "multi-layer",
    entries: entries.map(({ layerIndex, layerName, plan }) => ({
      layerIndex,
      layerName,
      plan,
    })),
  });

  const getMultiLayerChangeDetails = (entries = multiLayerPlans) =>
    entries.map((entry) => ({
      id: `layer:${entry.layerIndex}`,
      type: "layer",
      label: entry.layerName,
      value: entry.plan?.title || "Agent edit",
      enabled: true,
    }));

  const persistAgentEditSetDraft = async ({
    editSetId = activeEditSetId,
    plan = activePlan,
    multiPlans = multiLayerPlans,
    prompt,
    enabledMap = enabledChanges,
    valueMap = effectValues,
    beforeCanvasState = liveSnapshotRef.current || undefined,
    afterCanvasState = canvasEditor ? serializeCanvasState(canvasEditor) : undefined,
    currentImageUrlBefore,
    currentImageUrlAfter,
  } = {}) => {
    if (!project?._id) return null;

    const isMultiLayerSet = !plan && Array.isArray(multiPlans) && multiPlans.length > 0;
    const storedPlan = isMultiLayerSet ? serializeMultiLayerEditSet(multiPlans) : plan;
    if (!storedPlan) return null;

    const effectivePlan = plan
      ? buildEffectivePlan(plan, enabledMap, plan.sourceUrl || sourceUrl, valueMap)
      : { mode: "multi-layer" };
    const promptText =
      prompt ||
      plan?.userPrompt ||
      plan?.prompt ||
      multiPlans?.[0]?.plan?.userPrompt ||
      multiPlans?.[0]?.plan?.prompt ||
      "Agent edit";
    const changes = plan
      ? getEnabledChangeDetails(plan, enabledMap)
      : getMultiLayerChangeDetails(multiPlans);

    return await createOrUpdateAgentEditSet(compactPayload({
      editSetId: editSetId || undefined,
      projectId: project._id,
      prompt: promptText,
      title: plan?.title || (isMultiLayerSet ? "Layer edit set" : "Agent edit set"),
      summary: plan?.summary || (isMultiLayerSet ? `${multiPlans.length} layer${multiPlans.length === 1 ? "" : "s"} edited` : ""),
      plan: storedPlan,
      enabledChanges: enabledMap,
      effectValues: valueMap,
      effectivePlan,
      changes,
      beforeCanvasState,
      afterCanvasState,
      currentImageUrlBefore: currentImageUrlBefore || plan?.sourceUrl || sourceUrl || project.currentImageUrl || project.originalImageUrl,
      currentImageUrlAfter: currentImageUrlAfter || getSourceUrl(getCanvasActiveImage(canvasEditor), project) || effectivePlan?.url,
      activeTransformationsBefore: project.activeTransformations || "",
      activeTransformationsAfter: Array.isArray(effectivePlan?.imageKitTransforms)
        ? effectivePlan.imageKitTransforms.join(",")
        : project.activeTransformations || "",
    }));
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
    const previewToken = startLivePreviewSession();
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
            // 3. Cache miss — poll ImageKit (slow, 10–30s first time). The poll
            // is cancelled if the panel unmounts mid-flight (see cleanup effect).
            pollAbortRef.current?.abort();
            const controller = new AbortController();
            pollAbortRef.current = controller;
            try {
              readyUrl = await waitForImageKitUrl(effectivePlan.url, {
                maxAttempts: 10,
                retryDelayMs: 4000,
                signal: controller.signal,
                onStatus: (attempt, total) => {
                  setProcessingMessage?.(`ImageKit AI processing (${attempt}/${total})...`);
                },
              });
              // Write to both caches on success
              setCachedTransformUrl(effectivePlan.url, readyUrl);
              writeServerTransformCache(effectivePlan.url, readyUrl);
            } finally {
              setProcessingMessage?.(null);
              if (pollAbortRef.current === controller) pollAbortRef.current = null;
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
        if (beforeUrlForComparison && isMountedRef.current) {
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
    canvasEditor.__pushHistoryState?.({ label: isUpscalePlan ? "Upscale image" : "Apply AI transform", domain: "imagekit" });
    if (isMountedRef.current) setImageRevision((value) => value + 1);
    return previewToken;
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

  const applyPlanToCurrentImage = async (plan, changeMap = null, valueMap = null) => {
    if (!canvasEditor || !plan) throw new Error("No edit plan to apply");

    const image =
      getCanvasActiveImage(canvasEditor) ||
      (canvasEditor.getObjects?.() || []).find(isVisibleImageOnCanvas);
    const baseUrl = plan?.sourceUrl || getSourceUrl(image, project);
    if (!image || !baseUrl) throw new Error("No active image to apply this edit set to");

    const effectivePlan = buildEffectivePlan(
      plan,
      changeMap || createEnabledMap(plan),
      baseUrl,
      valueMap || createValueMap(plan)
    );
    let targetImage = image;

    if (effectivePlan?.url && effectivePlan.url !== getSourceUrl(image, project)) {
      let readyUrl = effectivePlan.url;

      if (hasImageKitAiTransform(effectivePlan.imageKitTransforms)) {
        const clientCached = getCachedTransformUrl(effectivePlan.url);
        if (clientCached) {
          readyUrl = clientCached;
        } else {
          const serverCached = await checkServerTransformCache(effectivePlan.url);
          if (serverCached) {
            readyUrl = serverCached;
            setCachedTransformUrl(effectivePlan.url, serverCached);
          } else {
            try {
              readyUrl = await waitForImageKitUrl(effectivePlan.url, {
                maxAttempts: 10,
                retryDelayMs: 4000,
                onStatus: (attempt, total) => {
                  setProcessingMessage?.(`ImageKit AI processing (${attempt}/${total})...`);
                },
              });
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
        placement: "fit",
      });
    }

    applyProfessionalFilters(targetImage, effectivePlan?.fabricAdjustments);
    canvasEditor.setActiveObject?.(targetImage);
    canvasEditor.requestRenderAll();

    return {
      effectivePlan,
      currentImageUrl: getSourceUrl(targetImage, project) || effectivePlan?.url || baseUrl,
      activeTransformations: effectivePlan?.imageKitTransforms?.join(",") || "",
    };
  };

  // Apply each layer's plan's Fabric adjustments to its own canvas image. Used
  // by the multi-target path — bypasses previewPlanOnCanvas (which assumes a
  // single active image).
  const applyMultiLayerPlansToCanvas = async (plans) => {
    if (!canvasEditor || !Array.isArray(plans) || plans.length === 0) return null;
    if (liveSnapshotRef.current) {
      await restoreLiveSnapshot({ keepSnapshot: false, pushHistory: false });
    }
    liveSnapshotRef.current = serializeCanvasState(canvasEditor);
    const previewToken = startLivePreviewSession();
    for (const entry of plans) {
      const target = entry?.canvasObject;
      const adjustments = entry?.plan?.fabricAdjustments || {};
      if (!target || Object.keys(adjustments).length === 0) continue;
      applyProfessionalFilters(target, adjustments);
    }
    canvasEditor.requestRenderAll();
    canvasEditor.__pushHistoryState?.({ label: "Apply multi-layer adjustments", domain: "imagekit" });
    setImageRevision((value) => value + 1);
    return previewToken;
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
          renderedBase64: l.renderedBase64,
          renderedMime: l.renderedMime,
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
        const previewToken = await applyMultiLayerPlansToCanvas(layerPlanEntries);
        let editSetId = null;
        try {
          editSetId = await persistAgentEditSetDraft({
            editSetId: null,
            plan: null,
            multiPlans: layerPlanEntries,
            prompt: cleanPrompt,
            beforeCanvasState: liveSnapshotRef.current || undefined,
            afterCanvasState: serializeCanvasState(canvasEditor),
            currentImageUrlBefore: latestUrl,
            currentImageUrlAfter: getSourceUrl(getCanvasActiveImage(canvasEditor), project) || latestUrl,
          });
          if (isMountedRef.current) setActiveEditSetId(editSetId);
        } catch (persistError) {
          console.warn("[agent] failed to persist edit set:", persistError?.message || persistError);
          toast.error("Preview ready, but I could not store this edit set.");
        }

        if (isMountedRef.current) {
          const names = layerPlanEntries.map((e) => e.layerName).join(", ");
          setMessages((current) => [
            ...current,
            newMessage(
              "assistant",
              `Applied to ${layerPlanEntries.length} layer${layerPlanEntries.length === 1 ? "" : "s"}: ${names}.`,
              { previewToken, editSetId }
            ),
          ]);
        }
        toast.success(`Edited ${layerPlanEntries.length} layer${layerPlanEntries.length === 1 ? "" : "s"}`, { id: toastId });
        return;
      } else {
        // v2 endpoint — single image, image-aware, deterministic, returns per-effect slider entries.
        // Flatten the LIVE canvas first so the agent analyses what the user
        // actually sees — original upload PLUS every manual edit (adjust, mask,
        // erase, draw, text, layer composition) — not the immutable upload. The
        // rendered element drives the fingerprint/pHash/features (so the server
        // cache self-invalidates whenever the pixels change) and the JPEG is sent
        // to the vision model for grading. Falls back to the raw FabricImage if
        // the render fails (e.g. a tainted canvas that can't be read).
        let analysisSource = image;
        let renderedImageBase64 = null;
        let renderedImageMime = null;
        try {
          const flat = await flattenLiveCanvasForAnalysis(canvasEditor, { project, maxEdge: 1024 });
          if (flat?.canvasElement) {
            analysisSource = flat.canvasElement;
            // Defense-in-depth: a 1024px JPEG is normally 150-400 KB. Only ship it
            // when within the server's accepted bound (~3 MB); if somehow larger,
            // still hash/feature from the element locally but let the server fall
            // back to the source URL rather than send an oversized payload.
            if (flat.base64 && flat.base64.length <= MAX_AGENT_RENDER_CHARS) {
              renderedImageBase64 = flat.base64;
              renderedImageMime = flat.mimeType;
            } else if (flat.base64) {
              console.warn("[agent] flattened render too large to send; server will use the source URL");
            }
          }
        } catch (flattenError) {
          console.warn("[agent] live-canvas flatten failed, using original image:", flattenError?.message || flattenError);
        }
        const fingerprint = computeImageFingerprint(analysisSource);
        const pHash = computePerceptualHash(analysisSource);
        const features = extractImageFeatures(analysisSource);
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
            renderedImageBase64,
            renderedImageMime,
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
        canvasEditor.__pushHistoryState?.({ label: "Generative image extend", domain: "imagekit" });

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

      let previewToken = null;
      if (autoPreview) {
        previewToken = await previewPlanOnCanvas(plan, nextEnabledChanges, nextValueMap);
      }
      // Panel unmounted during the preview poll — stop before touching state.
      if (!isMountedRef.current) return;
      let editSetId = null;
      try {
        editSetId = await persistAgentEditSetDraft({
          editSetId: null,
          plan,
          prompt: cleanPrompt,
          enabledMap: nextEnabledChanges,
          valueMap: nextValueMap,
          beforeCanvasState: liveSnapshotRef.current || serializeCanvasState(canvasEditor),
          afterCanvasState: autoPreview ? serializeCanvasState(canvasEditor) : undefined,
          currentImageUrlBefore: latestUrl,
          currentImageUrlAfter: autoPreview
            ? getSourceUrl(getCanvasActiveImage(canvasEditor), project) || latestUrl
            : latestUrl,
        });
        if (isMountedRef.current) setActiveEditSetId(editSetId);
      } catch (persistError) {
        console.warn("[agent] failed to persist edit set:", persistError?.message || persistError);
        toast.error("Preview ready, but I could not store this edit set.");
      }

      if (isMountedRef.current) {
        setMessages((current) => [
          ...current,
          newMessage(
            "assistant",
            autoPreview
              ? `${plan.title}: preview is live on the canvas.`
              : `${plan.title}: the edit plan is ready to preview.`,
            { plan, autoPreview, enabledChanges: nextEnabledChanges, previewToken, editSetId }
          ),
        ]);
      }
      toast.success(autoPreview ? "Preview ready" : "Plan ready", { id: toastId });
    } catch (error) {
      // Unmounted mid-poll (the in-flight waitForImageKitUrl was aborted on
      // cleanup): swallow silently — there's no panel left to surface this in.
      if (!isMountedRef.current || error?.name === "AbortError") {
        toast.dismiss(toastId);
      } else {
        toast.error(error?.message || "Agent edit failed", { id: toastId });
        setMessages((current) => [
          ...current,
          newMessage("assistant", error?.message || "I could not complete that edit. Try a simpler request."),
        ]);
      }
    } finally {
      if (isMountedRef.current) {
        setIsThinking(false);
        setPendingPrompt(null);
      }
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

      if (activeEditSetId) {
        await markAgentEditSetApplied(compactPayload({
          editSetId: activeEditSetId,
          beforeCanvasState: beforeSnapshot,
          afterCanvasState: canvasState,
          currentImageUrlBefore: activePlan.sourceUrl || sourceUrl,
          currentImageUrlAfter: effectivePlan?.url || activePlan.sourceUrl || sourceUrl,
          activeTransformationsBefore: project.activeTransformations || "",
          activeTransformationsAfter: effectivePlan?.imageKitTransforms?.join(",") || "",
          enabledChanges,
          effectValues,
          effectivePlan,
          changes: enabledChangeDetails,
        }));
      }

      liveSnapshotRef.current = null;
      clearLivePreviewSession();
      toast.success("Agent edit saved", { id: toastId });
      setMessages((current) => [...current, newMessage("assistant", "Saved. The live edit is now part of this project.")]);
      setActivePlan(null);
      setEffectValues({});
      setEnabledChanges({});
      setActiveEditSetId(null);
    } catch (error) {
      toast.error(error?.message || "Failed to save edit", { id: toastId });
    } finally {
      setIsApplying(false);
    }
  };

  const commitMultiLayerEdit = async () => {
    if (!canvasEditor || !project || multiLayerPlans.length === 0) return;
    const toastId = toast.loading("Applying edit set");
    setIsApplying(true);

    try {
      const canvasState = serializeCanvasState(canvasEditor);
      const currentImageUrl = getSourceUrl(getCanvasActiveImage(canvasEditor), project) || project.currentImageUrl || project.originalImageUrl;
      const beforeSnapshot = liveSnapshotRef.current;
      const changes = getMultiLayerChangeDetails(multiLayerPlans);

      if (beforeSnapshot) {
        await createProjectRevision({
          projectId: project._id,
          canvasState: beforeSnapshot,
          width: project.width,
          height: project.height,
          currentImageUrl: project.currentImageUrl || project.originalImageUrl,
          activeTransformations: project.activeTransformations || "",
          title: "Before layer edit set",
          summary: "Canvas state before the agent layer edit set was applied.",
          changes,
        });
      }

      await updateProject({
        projectId: project._id,
        canvasState,
        ...(currentImageUrl ? { currentImageUrl } : {}),
        activeTransformations: project.activeTransformations || "",
      });

      await createProjectRevision({
        projectId: project._id,
        canvasState,
        width: project.width,
        height: project.height,
        currentImageUrl,
        activeTransformations: project.activeTransformations || "",
        title: "Layer edit set",
        summary: `${multiLayerPlans.length} layer${multiLayerPlans.length === 1 ? "" : "s"} applied by the agent.`,
        changes,
      });

      if (activeEditSetId) {
        await markAgentEditSetApplied(compactPayload({
          editSetId: activeEditSetId,
          beforeCanvasState: beforeSnapshot,
          afterCanvasState: canvasState,
          currentImageUrlBefore: project.currentImageUrl || project.originalImageUrl,
          currentImageUrlAfter: currentImageUrl,
          activeTransformationsBefore: project.activeTransformations || "",
          activeTransformationsAfter: project.activeTransformations || "",
          effectivePlan: { mode: "multi-layer" },
          changes,
        }));
      }

      liveSnapshotRef.current = null;
      clearLivePreviewSession();
      setMultiLayerPlans([]);
      setActiveEditSetId(null);
      await canvasEditor.__saveCanvasState?.({ immediate: true });
      toast.success("Edit set applied", { id: toastId });
      setMessages((current) => [...current, newMessage("assistant", "Applied. This edit set is saved and can be removed later.")]);
    } catch (error) {
      toast.error(error?.message || "Failed to apply edit set", { id: toastId });
    } finally {
      setIsApplying(false);
    }
  };

  const revertLiveEdit = async (options = {}) => {
    if (!liveSnapshotRef.current) return false;
    const addMessage = options?.addMessage !== false;
    const editSetIdToKeep = activeEditSetId;
    if (editSetIdToKeep) {
      try {
        const draftId = await persistAgentEditSetDraft({
          editSetId: editSetIdToKeep,
          plan: activePlan,
          multiPlans: multiLayerPlans,
          beforeCanvasState: liveSnapshotRef.current,
          afterCanvasState: serializeCanvasState(canvasEditor),
        });
        await markAgentEditSetPending(compactPayload({
          editSetId: draftId || editSetIdToKeep,
          afterCanvasState: serializeCanvasState(canvasEditor),
          enabledChanges,
          effectValues,
          effectivePlan: activePlan
            ? buildEffectivePlan(activePlan, enabledChanges, activePlan.sourceUrl || sourceUrl, effectValues)
            : { mode: "multi-layer" },
          changes: activePlan
            ? getEnabledChangeDetails(activePlan, enabledChanges)
            : getMultiLayerChangeDetails(multiLayerPlans),
        }));
      } catch (persistError) {
        console.warn("[agent] failed to update pending edit set:", persistError?.message || persistError);
      }
    }
    await restoreLiveSnapshot();
    setActivePlan(null);
    setEffectValues({});
    setEnabledChanges({});
    setMultiLayerPlans([]);
    setUpscaleComparison(null);
    setIsCompareOpen(false);
    setActiveEditSetId(null);
    toast.message("Live preview reverted");
    if (addMessage) {
      setMessages((current) => [...current, newMessage("assistant", "Reverted the preview. The saved project was not changed.")]);
    }
    return true;
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
      clearLivePreviewSession();
      setActivePlan(null);
      setEnabledChanges({});
      setEffectValues({});
      setActiveEditSetId(null);

      await restoreCanvasFromHistory(canvasEditor, restored.canvasState, {
        imageUrl: restored.currentImageUrl || project.currentImageUrl || project.originalImageUrl,
        hydrateOptions: {
          forcePrimaryImageUrl: true,
          canvasSize: { width: restored.width, height: restored.height },
        },
      });
      canvasEditor.__fitCanvasToProject?.({ width: restored.width, height: restored.height });
      canvasEditor.__pushHistoryState?.({ label: "Restore saved version", domain: "imagekit" });
      setImageRevision((value) => value + 1);
      toast.success("Version restored", { id: toastId });
    } catch (error) {
      toast.error(error?.message || "Failed to restore version", { id: toastId });
    } finally {
      setRestoringRevisionId(null);
    }
  };

  const applyStoredEditSet = async (editSet) => {
    if (!editSet?._id || !canvasEditor || !project) return;
    const canRebuildFromPlan = editSet.plan && editSet.plan?.mode !== "multi-layer";
    if (!editSet.afterCanvasState && !canRebuildFromPlan) {
      toast.error("This edit set does not have an applied state yet.");
      return;
    }

    const toastId = toast.loading("Applying saved edit set");
    setIsApplying(true);

    try {
      if (liveSnapshotRef.current) {
        await restoreLiveSnapshot({ keepSnapshot: false, pushHistory: false });
      }

      const beforeState = serializeCanvasState(canvasEditor);
      const beforeImageUrl = getSourceUrl(getCanvasActiveImage(canvasEditor), project) || project.currentImageUrl || project.originalImageUrl;

      await createProjectRevision({
        projectId: project._id,
        canvasState: beforeState,
        width: project.width,
        height: project.height,
        currentImageUrl: beforeImageUrl,
        activeTransformations: project.activeTransformations || "",
        title: `Before ${editSet.title || "agent edit set"}`,
        summary: "Canvas state before applying a stored agent edit set.",
        prompt: editSet.prompt || "",
        changes: editSet.changes || [],
      });

      let currentImageUrl = editSet.currentImageUrlAfter;
      let activeTransformations = editSet.activeTransformationsAfter || "";
      let effectivePlan = editSet.effectivePlan;

      if (editSet.afterCanvasState) {
        await restoreCanvasFromHistory(canvasEditor, editSet.afterCanvasState, {
          imageUrl: editSet.currentImageUrlAfter || project.currentImageUrl || project.originalImageUrl,
          hydrateOptions: {
            forcePrimaryImageUrl: Boolean(editSet.currentImageUrlAfter),
            canvasSize: { width: project.width, height: project.height },
          },
        });
      } else {
        const storedPlan = {
          ...editSet.plan,
          sourceUrl: editSet.plan?.sourceUrl || editSet.currentImageUrlBefore || beforeImageUrl,
        };
        const result = await applyPlanToCurrentImage(
          storedPlan,
          editSet.enabledChanges || createEnabledMap(storedPlan),
          editSet.effectValues || createValueMap(storedPlan)
        );
        currentImageUrl = result.currentImageUrl;
        activeTransformations = result.activeTransformations;
        effectivePlan = result.effectivePlan;
      }

      canvasEditor.__pushHistoryState?.({ label: "Apply agent edit set", domain: "imagekit" });
      const canvasState = serializeCanvasState(canvasEditor);
      currentImageUrl = currentImageUrl || getSourceUrl(getCanvasActiveImage(canvasEditor), project) || project.currentImageUrl || project.originalImageUrl;

      await updateProject(compactPayload({
        projectId: project._id,
        canvasState,
        currentImageUrl,
        activeTransformations,
      }));

      await createProjectRevision({
        projectId: project._id,
        canvasState,
        width: project.width,
        height: project.height,
        currentImageUrl,
        activeTransformations,
        title: editSet.title || "Agent edit set",
        summary: editSet.summary || "Applied stored agent edit set.",
        prompt: editSet.prompt || "",
        changes: editSet.changes || [],
      });

      await markAgentEditSetApplied(compactPayload({
        editSetId: editSet._id,
        beforeCanvasState: beforeState,
        afterCanvasState: canvasState,
        currentImageUrlBefore: beforeImageUrl,
        currentImageUrlAfter: currentImageUrl,
        activeTransformationsBefore: project.activeTransformations || "",
        activeTransformationsAfter: activeTransformations,
        enabledChanges: editSet.enabledChanges,
        effectValues: editSet.effectValues,
        effectivePlan,
        changes: editSet.changes,
      }));

      liveSnapshotRef.current = null;
      clearLivePreviewSession();
      setActivePlan(null);
      setEnabledChanges({});
      setEffectValues({});
      setMultiLayerPlans([]);
      setActiveEditSetId(null);
      setImageRevision((value) => value + 1);
      await canvasEditor.__saveCanvasState?.({ immediate: true });
      toast.success("Edit set applied", { id: toastId });
    } catch (error) {
      toast.error(error?.message || "Failed to apply edit set", { id: toastId });
    } finally {
      setIsApplying(false);
    }
  };

  const removeStoredEditSet = async (editSet) => {
    if (!editSet?._id || !canvasEditor || !project) return;
    if (!editSet.beforeCanvasState) {
      toast.error("This edit set does not have a stored before state.");
      return;
    }

    const toastId = toast.loading("Removing saved edit set");
    setIsApplying(true);

    try {
      if (liveSnapshotRef.current) {
        await restoreLiveSnapshot({ keepSnapshot: false, pushHistory: false });
      }

      const currentState = serializeCanvasState(canvasEditor);
      const currentImageUrl = getSourceUrl(getCanvasActiveImage(canvasEditor), project) || project.currentImageUrl || project.originalImageUrl;

      await createProjectRevision({
        projectId: project._id,
        canvasState: currentState,
        width: project.width,
        height: project.height,
        currentImageUrl,
        activeTransformations: project.activeTransformations || "",
        title: `Before removing ${editSet.title || "agent edit set"}`,
        summary: "Canvas state before removing a stored agent edit set.",
        prompt: editSet.prompt || "",
        changes: editSet.changes || [],
      });

      await restoreCanvasFromHistory(canvasEditor, editSet.beforeCanvasState, {
        imageUrl: editSet.currentImageUrlBefore || project.currentImageUrl || project.originalImageUrl,
        hydrateOptions: {
          forcePrimaryImageUrl: Boolean(editSet.currentImageUrlBefore),
          canvasSize: { width: project.width, height: project.height },
        },
      });
      canvasEditor.__pushHistoryState?.({ label: "Remove agent edit set", domain: "imagekit" });
      const canvasState = serializeCanvasState(canvasEditor);
      const restoredImageUrl = editSet.currentImageUrlBefore || getSourceUrl(getCanvasActiveImage(canvasEditor), project) || project.originalImageUrl;
      const restoredTransformations = editSet.activeTransformationsBefore || "";

      await updateProject(compactPayload({
        projectId: project._id,
        canvasState,
        currentImageUrl: restoredImageUrl,
        activeTransformations: restoredTransformations,
      }));

      await createProjectRevision({
        projectId: project._id,
        canvasState,
        width: project.width,
        height: project.height,
        currentImageUrl: restoredImageUrl,
        activeTransformations: restoredTransformations,
        title: `Removed ${editSet.title || "agent edit set"}`,
        summary: "Removed a stored agent edit set from the canvas.",
        prompt: editSet.prompt || "",
        changes: editSet.changes || [],
      });

      await markAgentEditSetRemoved({ editSetId: editSet._id });

      setActivePlan(null);
      setEnabledChanges({});
      setEffectValues({});
      setMultiLayerPlans([]);
      setActiveEditSetId(null);
      setImageRevision((value) => value + 1);
      await canvasEditor.__saveCanvasState?.({ immediate: true });
      toast.success("Edit set removed", { id: toastId });
    } catch (error) {
      toast.error(error?.message || "Failed to remove edit set", { id: toastId });
    } finally {
      setIsApplying(false);
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
          {/* Undo / redo buttons removed — the agent's per-step history
              here only tracked a single most-recent change, which was
              confusing next to the editor's global undo/redo (⌘Z / ⌘⇧Z).
              Users can use the global shortcuts instead. */}
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
              <MessageBubble
                key={message.id}
                message={message}
                canUndoPreview={Boolean(message.previewToken && message.previewToken === livePreviewToken)}
                isApplying={isApplying}
                onUndoPreview={() => revertLiveEdit({ addMessage: true })}
              />
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

      {/* Resizable Edits Section */}
      {(pendingConfirmation || multiLayerPlans.length > 0 || activePlan || agentEditSets.length > 0 || revisions.length > 0) && (
        <div
          ref={editsContainerRef}
          className="agent-edits-wrapper"
          style={{
            height: isEditsMinimized ? '32px' : (editsHeight ? `${editsHeight}px` : 'auto'),
            maxHeight: '65vh',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            borderTop: '1px solid var(--agent-line)',
            marginTop: 'auto',
            background: 'color-mix(in srgb, var(--agent-panel) 98%, transparent)',
            position: 'relative',
            zIndex: 10,
          }}
        >
          {/* Drag Handle */}
          <div
            className="agent-edits-handle"
            onMouseDown={handleEditsDragStart}
            style={{
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'ns-resize',
              position: 'relative',
              flexShrink: 0,
              userSelect: 'none',
            }}
          >
            <GripHorizontal className="h-4 w-4 opacity-40 hover:opacity-80 transition-opacity" />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsEditsMinimized(!isEditsMinimized);
                if (isEditsMinimized && editsHeight && editsHeight < 150) {
                  setEditsHeight(400); // Expand to default if it was too small
                }
              }}
              className="agent-icon-action"
              style={{
                position: 'absolute',
                right: '8px',
                padding: '4px',
                background: 'transparent',
                border: 'none',
              }}
              title={isEditsMinimized ? "Maximize edits" : "Minimize edits"}
            >
              {isEditsMinimized ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>

          {!isEditsMinimized && (
            <div
              className="agent-edits-content panel-scroll"
              style={{
                overflowY: 'auto',
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem',
                padding: '0.25rem 0 1rem 0',
              }}
            >
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
                        onClick={() => revertLiveEdit({ addMessage: true })}
                        disabled={!liveSnapshotRef.current}
                        className="agent-action-button"
                        whileHover={{ y: -2 }}
                        whileTap={{ scale: 0.97 }}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Not now
                      </motion.button>
                      <motion.button
                        type="button"
                        onClick={commitMultiLayerEdit}
                        disabled={isApplying}
                        className="agent-action-button agent-action-button--primary"
                        whileHover={{ y: -2 }}
                        whileTap={{ scale: 0.97 }}
                      >
                        {isApplying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        Apply
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
                        Not now
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
                        Apply
                      </motion.button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {agentEditSets.length > 0 && (
                <motion.div
                  className="agent-version-dock agent-editset-dock"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="agent-version-head">
                    <span>
                      <WandSparkles className="h-3.5 w-3.5" />
                      Agent edit sets
                    </span>
                    <small>{agentEditSets.length}</small>
                  </div>
                  <div className="agent-editset-list">
                    {agentEditSets.slice(0, 8).map((editSet) => {
                      const isApplied = editSet.status === "applied";
                      const isRemoved = editSet.status === "removed";
                      const statusLabel = isApplied ? "Applied" : isRemoved ? "Removed" : "Saved";
                      const canApplyEditSet =
                        Boolean(editSet.afterCanvasState) ||
                        Boolean(editSet.plan && editSet.plan?.mode !== "multi-layer");
                      return (
                        <div key={editSet._id} className={`agent-editset-row is-${editSet.status}`}>
                          <div className="agent-editset-copy">
                            <strong>{truncate(editSet.title || "Agent edit set", 32)}</strong>
                            <span>{truncate(editSet.prompt || editSet.summary || "Stored change set", 54)}</span>
                            <small>{statusLabel} · {formatRevisionTime(editSet.updatedAt || editSet.createdAt)}</small>
                          </div>
                          <div className="agent-editset-actions">
                            {!isApplied && (
                              <button
                                type="button"
                                className="agent-editset-button agent-editset-button--apply"
                                onClick={() => applyStoredEditSet(editSet)}
                                disabled={isApplying || !canApplyEditSet}
                              >
                                <Check className="h-3.5 w-3.5" />
                                {isRemoved ? "Apply again" : "Apply"}
                              </button>
                            )}
                            {isApplied && (
                              <button
                                type="button"
                                className="agent-editset-button"
                                onClick={() => removeStoredEditSet(editSet)}
                                disabled={isApplying || !editSet.beforeCanvasState}
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                                Remove
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </motion.div>
              )}

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
            </div>
          )}
        </div>
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
