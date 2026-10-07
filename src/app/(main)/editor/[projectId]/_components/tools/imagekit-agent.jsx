"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeftRight, Bot, Image as ImageIcon, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import BeforeAfterCompare from "@/components/neo/BeforeAfterCompare";
import { ensureDomains } from "@/lib/agent/domain-host";
import { parseFocusPrompt } from "@/lib/agent/focus-commands";
import { parseStretchPrompt } from "@/lib/agent/stretch-commands";
import { isPhosmithMaskOverlay } from "@/lib/canvas-mask";
import { flattenLiveCanvasForAnalysis } from "@/lib/canvas-snapshot";
import { extractImageFeatures } from "@/lib/image-features";
import { computeImageFingerprint, computePerceptualHash } from "@/lib/image-fingerprint";
import { api } from "@/lib/neon-api";
import { toUserMessage } from "@/lib/user-error";
import { useCanvas } from "../../../../../../../context/context";
import { useDatabaseMutation, useDatabaseQuery } from "../../../../../../../hooks/useDatabaseQuery";
import { restoreCanvasFromHistory } from "../../../../../../lib/canvas-history";
import { serializeCanvasState } from "../../../../../../lib/canvas-state";
import { getCanvasActiveImage, hasImageKitAiTransform, isImageKitUrl, replaceCanvasImageFromUrl, waitForImageKitUrl } from "../../../../../../lib/imagekit-ai";
import { applyProfessionalFilters } from "../../../../../../lib/professional-image-filters";
import { MAX_AGENT_RENDER_CHARS, analyzeActiveImage, collectLayersForTargeting, getSourceUrl, isVisibleImageOnCanvas } from "./agent/canvas-targets";
import { INITIAL_MESSAGES, INITIAL_WELCOME_MESSAGE, inferThreadTitle, loadStoredState, makeEmptyThread, newMessage, saveStoredState } from "./agent/chat-storage";
import { compactPayload, truncate } from "./agent/format";
import { QUICK_PROMPTS, isCollageIntent, summarizeCollageResult, summarizeFocusResult, summarizeStretchResult } from "./agent/intents";
import { adaptPlanV2, buildEffectivePlan, createEnabledMap, createValueMap, getChangeItems, getEnabledChangeDetails } from "./agent/plan";
import { checkServerTransformCache, getCachedTransformUrl, setCachedTransformUrl, writeServerTransformCache } from "./agent/transform-cache";
import AgentHeader from "./agent/agent-header";
import AgentChatArea from "./agent/agent-chat-area";
import AgentEditsPanel from "./agent/agent-edits-panel";

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
  // Opening this panel is the signal that the canvas command domains will be
  // needed, so warm them here rather than making the first prompt wait.
  useEffect(() => {
    ensureDomains();
  }, []);

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
  // Collage works on the canvas photos directly (≥2 visible images), so it can
  // run even when there's no single ImageKit-hosted active image to "chat" about.
  const collageImageCount = (canvasEditor?.getObjects?.() || []).filter(
    (obj) => obj?.type?.toLowerCase?.() === "image" && obj.visible !== false && !isPhosmithMaskOverlay(obj)
  ).length;
  const canCollage = collageImageCount >= 2;
  const canSend = canChat || canCollage;

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

  // Build a collage from a natural-language prompt via the `collage.*` agent
  // commands (parse → create template → insert the canvas photos → optionally
  // generate a fit-to-photos background). Lives outside the edit-plan flow.
  // Focus / blur / colour-pop / shadow requests go to the `focus.*` commands.
  // The parser is deterministic, so this costs no model call — and when it
  // recognises nothing the request falls through to the edit planner below.
  const runFocusPrompt = async (cleanPrompt) => {
    if (!canvasEditor) return false;
    const toastId = toast.loading("Applying", { description: truncate(cleanPrompt, 70) });
    setMessages((current) => [...current, newMessage("user", cleanPrompt)]);
    setInput("");
    setPendingPrompt(cleanPrompt);
    setIsThinking(true);
    try {
      const [{ runCommand }] = await Promise.all([
        import("@/lib/agent/command-registry"),
        ensureDomains(),
      ]);
      const result = await runCommand("focus.fromDescription", { prompt: cleanPrompt });
      if (isMountedRef.current) {
        setMessages((current) => [...current, newMessage("assistant", summarizeFocusResult(result))]);
      }
      toast.success("Applied", { id: toastId });
    } catch (error) {
      const msg = String(error?.message || "Could not apply that").replace(/^\[agent\.focus\]\s*/, "");
      if (isMountedRef.current) {
        setMessages((current) => [...current, newMessage("assistant", msg)]);
      }
      toast.error(msg, { id: toastId });
    } finally {
      if (isMountedRef.current) {
        setIsThinking(false);
        setPendingPrompt(null);
        setImageRevision((value) => value + 1);
      }
    }
    return true;
  };

  const runStretchPrompt = async (cleanPrompt) => {
    if (!canvasEditor) return false;
    const toastId = toast.loading("Stretching", { description: truncate(cleanPrompt, 70) });
    setMessages((current) => [...current, newMessage("user", cleanPrompt)]);
    setInput("");
    setPendingPrompt(cleanPrompt);
    setIsThinking(true);
    try {
      const [{ runCommand }] = await Promise.all([
        import("@/lib/agent/command-registry"),
        ensureDomains(),
      ]);
      const result = await runCommand("stretch.fromDescription", { prompt: cleanPrompt });
      if (isMountedRef.current) {
        setMessages((current) => [...current, newMessage("assistant", summarizeStretchResult(result))]);
      }
      toast.success("Applied", { id: toastId });
    } catch (error) {
      const msg = String(error?.message || "Could not apply that").replace(/^\[agent\.stretch\]\s*/, "");
      if (isMountedRef.current) {
        setMessages((current) => [...current, newMessage("assistant", msg)]);
      }
      toast.error(msg, { id: toastId });
    } finally {
      if (isMountedRef.current) {
        setIsThinking(false);
        setPendingPrompt(null);
        setImageRevision((value) => value + 1);
      }
    }
    return true;
  };

  const runCollagePrompt = async (cleanPrompt) => {
    if (!canvasEditor) return;
    if (collageImageCount < 2) {
      setMessages((current) => [
        ...current,
        newMessage("user", cleanPrompt),
        newMessage(
          "assistant",
          `Add at least 2 photos to the canvas first — I found ${collageImageCount}. Then ask me to build the collage.`
        ),
      ]);
      setInput("");
      return;
    }

    const toastId = toast.loading("Building collage", { description: truncate(cleanPrompt, 70) });
    setMessages((current) => [...current, newMessage("user", cleanPrompt)]);
    setInput("");
    setPendingPrompt(cleanPrompt);
    setIsThinking(true);
    try {
      const [{ runCommand }] = await Promise.all([
        import("@/lib/agent/command-registry"),
        ensureDomains(),
      ]);
      const result = await runCommand("collage.fromDescription", { prompt: cleanPrompt });
      if (isMountedRef.current) {
        setMessages((current) => [...current, newMessage("assistant", summarizeCollageResult(result))]);
      }
      toast.success("Collage built", { id: toastId });
    } catch (error) {
      const msg = String(error?.message || "Could not build the collage").replace(/^\[agent\.collage\]\s*/, "");
      if (isMountedRef.current) {
        setMessages((current) => [...current, newMessage("assistant", msg)]);
      }
      toast.error(msg, { id: toastId });
    } finally {
      if (isMountedRef.current) {
        setIsThinking(false);
        setPendingPrompt(null);
        setImageRevision((value) => value + 1);
      }
    }
  };

  const requestPlan = async (prompt, options = {}) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;

    // Collage requests are handled by the `collage.*` agent commands, which
    // build a template and place the canvas photos into it — a different flow
    // from the per-image edit planner, and one that doesn't need an active
    // ImageKit image.
    if (isCollageIntent(cleanPrompt)) {
      await runCollagePrompt(cleanPrompt);
      return;
    }

    // Focus & Light: only when the deterministic parser recognises the request,
    // so "give it a cinematic grade" still reaches the edit planner.
    if (parseFocusPrompt(cleanPrompt)) {
      await runFocusPrompt(cleanPrompt);
      return;
    }

    // Pixel Stretch, on the same terms: a deterministic parser decides, so an
    // ordinary edit request never gets turned into a ribbon.
    if (parseStretchPrompt(cleanPrompt)) {
      await runStretchPrompt(cleanPrompt);
      return;
    }

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
        toast.error(toUserMessage(error, "Agent edit failed"), { id: toastId });
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
      toast.error(toUserMessage(error, "Failed to save edit"), { id: toastId });
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
      toast.error(toUserMessage(error, "Failed to apply edit set"), { id: toastId });
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
        toast.error(toUserMessage(error, "Could not update preview"));
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
        if (commit) toast.error(toUserMessage(error, "Could not update preview"));
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
      toast.error(toUserMessage(error, "Failed to restore version"), { id: toastId });
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
      toast.error(toUserMessage(error, "Failed to apply edit set"), { id: toastId });
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
      toast.error(toUserMessage(error, "Failed to remove edit set"), { id: toastId });
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
      <AgentHeader
          activeChangeSummary={activeChangeSummary}
          autoPreview={autoPreview}
          canChat={canChat}
          canCollage={canCollage}
          canSend={canSend}
          collageImageCount={collageImageCount}
          contrastingColor={contrastingColor}
          dominantColor={dominantColor}
          isHistoryOpen={isHistoryOpen}
          setAutoPreview={setAutoPreview}
          setIsHistoryOpen={setIsHistoryOpen}
          startNewThread={startNewThread}
      />

      <div className="agent-quick-rail">
        {QUICK_PROMPTS.map((item) => {
          const itemEnabled = isCollageIntent(item.prompt) ? canSend : canChat;
          return (
            <motion.button
              key={item.label}
              type="button"
              onClick={() => requestPlan(item.prompt)}
              disabled={!itemEnabled || isThinking}
              className="agent-quick-card"
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.97 }}
            >
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </motion.button>
          );
        })}
      </div>

      <AgentChatArea
          autoPreview={autoPreview}
          chatEndRef={chatEndRef}
          chatState={chatState}
          deleteThread={deleteThread}
          isApplying={isApplying}
          isHistoryOpen={isHistoryOpen}
          isThinking={isThinking}
          livePreviewToken={livePreviewToken}
          messages={messages}
          pendingPrompt={pendingPrompt}
          project={project}
          revertLiveEdit={revertLiveEdit}
          setChatState={setChatState}
          setIsHistoryOpen={setIsHistoryOpen}
          startNewThread={startNewThread}
          switchToThread={switchToThread}
      />

      {/* Resizable Edits Section */}
      {(pendingConfirmation || multiLayerPlans.length > 0 || activePlan || agentEditSets.length > 0 || revisions.length > 0) && (
        <AgentEditsPanel
            activePlan={activePlan}
            agentEditSets={agentEditSets}
            applyStoredEditSet={applyStoredEditSet}
            commitLiveEdit={commitLiveEdit}
            commitMultiLayerEdit={commitMultiLayerEdit}
            confirmedLayerIds={confirmedLayerIds}
            copyUrl={copyUrl}
            dominantColor={dominantColor}
            editsContainerRef={editsContainerRef}
            editsHeight={editsHeight}
            effectValues={effectValues}
            enabledChanges={enabledChanges}
            handleChangeToggle={handleChangeToggle}
            handleEditsDragStart={handleEditsDragStart}
            handleEffectValueChange={handleEffectValueChange}
            isApplying={isApplying}
            isEditsMinimized={isEditsMinimized}
            isThinking={isThinking}
            hasLiveSnapshot={Boolean(liveSnapshotRef.current)}
            multiLayerPlans={multiLayerPlans}
            pendingConfirmation={pendingConfirmation}
            previewPlanOnCanvas={previewPlanOnCanvas}
            removeStoredEditSet={removeStoredEditSet}
            requestPlan={requestPlan}
            restoreRevision={restoreRevision}
            restoringRevisionId={restoringRevisionId}
            revertLiveEdit={revertLiveEdit}
            revisions={revisions}
            setConfirmedLayerIds={setConfirmedLayerIds}
            setEditsHeight={setEditsHeight}
            setIsEditsMinimized={setIsEditsMinimized}
            setPendingConfirmation={setPendingConfirmation}
        />
      )}

      {!canChat && (
        <div className="agent-empty-note">
          <ImageIcon className="h-3.5 w-3.5" />
          {canCollage
            ? "Select an ImageKit image to edit, or ask me to build a collage."
            : "Select an ImageKit-hosted canvas image."}
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
          disabled={!canSend || isThinking}
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
