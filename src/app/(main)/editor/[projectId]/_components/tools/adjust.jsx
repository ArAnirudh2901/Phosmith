"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { RotateCcw, SlidersHorizontal } from "lucide-react"
import { toast } from "sonner"
import { ProRulerSlider } from "@/components/editor/ProRulerSlider"
import { computeImageHistogram } from "@/lib/image-histogram"
import { toUserMessage } from "@/lib/user-error"
import { useCanvas } from "../../../../../../../context/context"
import { buildImageKitChainedTransformUrl, ensureCurrentImageKitEndpoint, isImageKitUrl, normalizeImageKitUrl } from "../../../../../../lib/imagekit-ai"
import { ColorWheelCard } from "./adjust/color-wheel"
import { CURVE_POINTS_KEYS, DEFAULT_VALUES, FILTER_GROUPS, FILTER_VISUAL, IMAGEKIT_DEFAULTS, LOOKS, LOOK_PRESET_KEYS, SLIDER_CONFIGS, WHEEL_CONFIGS } from "./adjust/config"
import { CurveEditorPanel } from "./adjust/curves"
import { applyAdjustmentFilters, getValuesFromImageFilters, getValuesSignature, normalizeStoredValues } from "./adjust/filters"
import { ImageKitPanel, buildImageKitTokens, isAiTransform } from "./adjust/imagekit"
import { buildProxyCanvas, ensureAdjustmentObjectId, getAdjustmentSourceImage, getAdjustmentTargets, getImageSrc, getSelectedImage, getVisibleImages } from "./adjust/targets"


const AdjustControls = () => {
    const { canvasEditor, setProcessingMessage } = useCanvas()
    const [activeTab, setActiveTab] = useState("Tone")
    const [activeCurveChannel, setActiveCurveChannel] = useState("rgb")
    const [values, setValues] = useState(DEFAULT_VALUES)
    const [curveHistogram, setCurveHistogram] = useState(null)
    const [imageKitValues, setImageKitValues] = useState(IMAGEKIT_DEFAULTS)
    const [isApplyingImageKit, setIsApplyingImageKit] = useState(false)
    const latestRef = useRef(DEFAULT_VALUES)
    const sigRef = useRef(getValuesSignature(DEFAULT_VALUES))
    const committedSigRef = useRef(getValuesSignature(DEFAULT_VALUES))
    const previewFrame = useRef(null)
    const histogramFrameRef = useRef(null)
    const pendingPreviewRef = useRef(null)
    const isInteractingRef = useRef(false)
    // Preview-proxy state. proxyCacheRef: adjustmentId -> { canvas|null, srcW, srcH }
    // (canvas === null means the image is already ≤ PROXY_MAX_PX, so no proxy is
    // needed). previewSwapRef holds the images whose _originalElement is currently
    // pointed at their proxy so the drag can be restored to full-res on commit.
    const proxyCacheRef = useRef(new Map())
    const previewSwapRef = useRef([])
    const previewActiveRef = useRef(false)

    // Kick off (async) a downscaled proxy for `img`, cached by its adjustment
    // id. No-op if a proxy for the same source dims already exists or is in
    // flight. Never throws into the caller.
    const ensureProxyFor = (img) => {
        if (!img?._originalElement) return
        // A cropped image (cropX/cropY in full-res px) would misalign against a
        // downscaled source, so skip the proxy for those — they stay full-res.
        if (img.cropX || img.cropY) return
        const id = ensureAdjustmentObjectId(img)
        const src = img._originalElement
        const W = src.naturalWidth || src.width || 0
        const H = src.naturalHeight || src.height || 0
        if (!W || !H) return
        const cached = proxyCacheRef.current.get(id)
        if (cached && cached.srcW === W && cached.srcH === H) return // ready or in flight
        proxyCacheRef.current.set(id, { canvas: null, srcW: W, srcH: H }) // reserve
        buildProxyCanvas(src)
            .then((canvas) => {
                const entry = proxyCacheRef.current.get(id)
                if (entry && entry.srcW === W && entry.srcH === H) {
                    proxyCacheRef.current.set(id, { canvas, srcW: W, srcH: H })
                }
            })
            .catch(() => {
                const entry = proxyCacheRef.current.get(id)
                if (entry && entry.srcW === W && entry.srcH === H) proxyCacheRef.current.delete(id)
            })
    }

    // Point each drag target's _originalElement at its ready proxy so preview
    // applyFilters() runs on ~1 MP. Idempotent; targets without a ready proxy
    // stay full-res (still RAF-gated).
    const enterPreviewMode = () => {
        if (previewActiveRef.current) return
        previewActiveRef.current = true
        const swapped = []
        for (const img of getAdjustmentTargets(canvasEditor)) {
            if (img?.cropX || img?.cropY) continue // cropped images stay full-res (see ensureProxyFor)
            const id = img?.phosmithAdjustmentId || img?._phosmithAdjustmentId
            const entry = id ? proxyCacheRef.current.get(id) : null
            if (entry?.canvas && img._originalElement && img._originalElement !== entry.canvas) {
                const fullEl = img._originalElement
                const logicalWidth = Math.max(1, Number(img.width) || fullEl.naturalWidth || fullEl.width || 1)
                const logicalHeight = Math.max(1, Number(img.height) || fullEl.naturalHeight || fullEl.height || 1)
                const previewScale = {
                    x: entry.canvas.width / logicalWidth,
                    y: entry.canvas.height / logicalHeight,
                }
                swapped.push({
                    img,
                    fullEl,
                    filterScalingX: img._filterScalingX,
                    filterScalingY: img._filterScalingY,
                })
                img._originalElement = entry.canvas
                // Point _element at the proxy too so applyFilters() allocates a
                // FRESH proxy-sized canvas. If _element still referenced the
                // full-res source (a freshly loaded image with no filters yet),
                // Fabric would write the filtered pixels straight into the
                // original source canvas and corrupt it.
                img._element = entry.canvas
                img._filteredEl = undefined
                // Fabric's renderer uses _filterScaling* to convert a filtered
                // element back into the image object's logical dimensions. Its
                // applyFilters() method sees proxy → proxy as scale 1, which made
                // a 1000px proxy render as a physically tiny image during drag.
                // Keep this marker so applyAdjustmentFilters can restore it after
                // every proxy filter pass (including a neutral first frame).
                img.__phosmithAdjustmentPreviewScale = previewScale
                img._filterScalingX = previewScale.x
                img._filterScalingY = previewScale.y
                // WebGL caches the SOURCE texture by cacheKey and applyFilters()
                // only evicts the _filtered texture — evict the source ourselves
                // on every _originalElement change or the proxy/full-res textures
                // cross. No-op on Canvas2D.
                img.removeTexture?.(img.cacheKey)
            }
        }
        previewSwapRef.current = swapped
    }

    // Restore full-res source elements. Called before every commit (so the
    // committed apply + histogram read the full-res source) and defensively on
    // selection change / unmount.
    const exitPreviewMode = () => {
        if (!previewActiveRef.current) return
        previewActiveRef.current = false
        for (const { img, fullEl, filterScalingX, filterScalingY } of previewSwapRef.current) {
            img._originalElement = fullEl
            // Fabric reuses a stale _filteredEl (still at proxy size) and only
            // clears it, never resizes it — so a full-res commit would render
            // into the 1000px canvas. Point _element back at the original and
            // drop _filteredEl so applyFilters() rebuilds a full-res canvas.
            img._element = fullEl
            img._filteredEl = undefined
            delete img.__phosmithAdjustmentPreviewScale
            img._filterScalingX = filterScalingX
            img._filterScalingY = filterScalingY
            img.removeTexture?.(img.cacheKey) // evict the proxy SOURCE texture too
        }
        previewSwapRef.current = []
    }

    const queueCurveHistogramRefresh = useCallback((image) => {
        if (histogramFrameRef.current) {
            cancelAnimationFrame(histogramFrameRef.current)
            histogramFrameRef.current = null
        }

        const targetImage = image || getAdjustmentSourceImage(canvasEditor)
        histogramFrameRef.current = requestAnimationFrame(() => {
            histogramFrameRef.current = null
            setCurveHistogram(targetImage ? computeImageHistogram(targetImage) : null)
        })
    }, [canvasEditor])

    useEffect(() => {
        if (!canvasEditor) return
        const sync = () => {
            if (isInteractingRef.current) return
            const img = getAdjustmentSourceImage(canvasEditor)
            const next = img ? getValuesFromImageFilters(img) : { ...DEFAULT_VALUES }
            queueCurveHistogramRefresh(img)
            // Eagerly build proxies for the current drag targets so they're ready
            // before the next gesture; prune cache entries for images no longer present.
            const targets = getAdjustmentTargets(canvasEditor)
            targets.forEach(ensureProxyFor)
            const liveIds = new Set(getVisibleImages(canvasEditor)
                .map((im) => im.phosmithAdjustmentId || im._phosmithAdjustmentId).filter(Boolean))
            for (const key of proxyCacheRef.current.keys()) {
                if (!liveIds.has(key)) proxyCacheRef.current.delete(key)
            }
            pendingPreviewRef.current = null
            if (previewFrame.current) {
                cancelAnimationFrame(previewFrame.current)
                previewFrame.current = null
            }
            latestRef.current = next
            sigRef.current = getValuesSignature(next)
            committedSigRef.current = getValuesSignature(next)
            setValues((cur) => (getValuesSignature(cur) === getValuesSignature(next) ? cur : next))
        }
        const proxyCache = proxyCacheRef.current
        sync()
        canvasEditor.on("selection:created", sync)
        canvasEditor.on("selection:updated", sync)
        canvasEditor.on("selection:cleared", sync)
        canvasEditor.on("object:added", sync)
        return () => {
            exitPreviewMode() // restore any swapped source before teardown
            proxyCache.clear()
            pendingPreviewRef.current = null
            if (previewFrame.current) cancelAnimationFrame(previewFrame.current)
            if (histogramFrameRef.current) {
                cancelAnimationFrame(histogramFrameRef.current)
                histogramFrameRef.current = null
            }
            canvasEditor.off("selection:created", sync)
            canvasEditor.off("selection:updated", sync)
            canvasEditor.off("selection:cleared", sync)
            canvasEditor.off("object:added", sync)
        }
    }, [canvasEditor, queueCurveHistogramRefresh])

    const handleBeginChange = () => {
        isInteractingRef.current = true
        enterPreviewMode() // swap targets to their downscaled proxy for the drag
    }

    const applyNextValues = (next, { commit = false, updateState = false } = {}) => {
        latestRef.current = next
        if (updateState) setValues(next)
        const nextSig = getValuesSignature(next)
        // Restore full-res source BEFORE the committed apply so it's lossless and
        // the source histogram reads full-res.
        if (commit) exitPreviewMode()
        applyAdjustmentFilters(canvasEditor, next, sigRef, { commit: commit && nextSig !== committedSigRef.current })
        // Histogram is computed from the source image (see getHistogramSourceElement)
        // so it doesn't change during a drag — no refresh needed on every preview frame.
        if (commit) {
            committedSigRef.current = nextSig
            isInteractingRef.current = false
        }
    }

    // RAF-gated preview: pointermove fires at 60-240Hz, but full-res
    // img.applyFilters() only needs to run once per frame with the newest
    // value. Without this, every move ran applyFilters synchronously and
    // froze the slider handle on large images. State (latestRef / curve SVG)
    // still updates synchronously so the UI tracks the drag in real time;
    // only the expensive filter apply is coalesced to one call per frame.
    const schedulePreview = (next, { updateState = false } = {}) => {
        latestRef.current = next
        if (updateState) setValues(next)
        pendingPreviewRef.current = next
        if (previewFrame.current) return
        previewFrame.current = requestAnimationFrame(() => {
            previewFrame.current = null
            const v = pendingPreviewRef.current
            pendingPreviewRef.current = null
            if (v) applyAdjustmentFilters(canvasEditor, v, sigRef, { commit: false })
        })
    }

    const handlePreviewChange = (key, v) => {
        const isPointsKey = CURVE_POINTS_KEYS.includes(key)
        const val = isPointsKey ? v : (Array.isArray(v) ? v[0] : v)
        const prev = latestRef.current
        if (!isPointsKey && prev[key] === val) return
        const next = { ...prev, [key]: val }
        // For curve points, update React state immediately so the SVG path
        // re-renders in real-time while dragging (not just on mouse-up).
        schedulePreview(next, { updateState: isPointsKey })
    }

    const handleCommitChange = (key, v) => {
        const isPointsKey = CURVE_POINTS_KEYS.includes(key)
        const val = isPointsKey ? v : (Array.isArray(v) ? v[0] : v)
        if (previewFrame.current) {
            cancelAnimationFrame(previewFrame.current)
            previewFrame.current = null
        }
        pendingPreviewRef.current = null
        applyNextValues({ ...latestRef.current, [key]: val }, { commit: true, updateState: true })
    }

    const handleColorChange = (key, color) => {
        const next = { ...latestRef.current, [key]: color }
        applyNextValues(next, { commit: true, updateState: true })
    }

    const handleWheelAmount = (key, v, commit) => {
        const val = Array.isArray(v) ? v[0] : v
        const next = { ...latestRef.current, [key]: val }
        if (commit) {
            // Drop any pending preview frame so it can't overwrite the
            // committed full-res result after mouse-up.
            if (previewFrame.current) {
                cancelAnimationFrame(previewFrame.current)
                previewFrame.current = null
            }
            pendingPreviewRef.current = null
            applyNextValues(next, { commit: true, updateState: true })
        } else {
            // Color wheels have no onBegin hook — enter preview mode on the first
            // drag frame (idempotent). Committed on release via the branch above.
            isInteractingRef.current = true
            enterPreviewMode()
            schedulePreview(next)
        }
    }

    const resolveImageKitUrl = async (url, { source, tokens }) => {
        console.log("[Adjust ImageKit] resolve request", {
            source,
            tokens,
            url,
        })

        const response = await fetch("/api/imagekit/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url,
                source,
                preset: tokens.join(","),
                maxAttempts: 12,
                retryDelayMs: 5000,
            }),
        })
        const data = await response.json().catch(() => ({}))

        console.log("[Adjust ImageKit] resolve response", {
            source,
            tokens,
            ok: response.ok,
            status: response.status,
            data,
            url,
        })

        if (!response.ok || !data?.success) {
            throw new Error(data?.error || "ImageKit transform did not finish")
        }

        return data.url || url
    }

    const setLook = (lookId) => {
        const look = LOOKS.find((item) => item.id === lookId)
        const next = normalizeStoredValues({
            ...latestRef.current,
            ...LOOK_PRESET_KEYS.reduce((acc, key) => {
                acc[key] = DEFAULT_VALUES[key]
                return acc
            }, {}),
            ...(look?.preset || {}),
            look: lookId,
        })
        applyNextValues(next, { commit: true, updateState: true })
    }

    const reset = () => {
        const next = { ...DEFAULT_VALUES }
        latestRef.current = next
        pendingPreviewRef.current = null
        if (previewFrame.current) {
            cancelAnimationFrame(previewFrame.current)
            previewFrame.current = null
        }
        setValues(next)
        exitPreviewMode() // restore full-res before applying the reset
        const nextSig = getValuesSignature(next)
        applyAdjustmentFilters(canvasEditor, next, sigRef, { commit: nextSig !== committedSigRef.current })
        queueCurveHistogramRefresh()
        committedSigRef.current = nextSig
        isInteractingRef.current = false
    }

    const applyImageKitTransforms = async () => {
        const img = getSelectedImage(canvasEditor)
        if (!img) {
            toast.error("Select an image first")
            return
        }

        const sourceUrl = getImageSrc(img)
        if (!isImageKitUrl(sourceUrl)) {
            toast.error("ImageKit URL transforms need an ImageKit-hosted image")
            return
        }

        const tokens = buildImageKitTokens(imageKitValues)
        if (!tokens.length) {
            toast.info("Choose at least one ImageKit transform")
            return
        }

        let baseUrl = img._phosmithImageKitAdjustBaseSrc || img.phosmithImageKitAdjustBaseSrc || sourceUrl

        // AI transforms (e-retouch, e-upscale) must be separate chained steps,
        // not comma-joined in a single step. Split them out.
        const aiTokens = tokens.filter(isAiTransform)
        const regularTokens = tokens.filter((t) => !isAiTransform(t))

        // If AI transforms are present and the image belongs to a different
        // ImageKit account, re-upload it so units are charged correctly.
        if (aiTokens.length > 0) {
            try {
                baseUrl = await ensureCurrentImageKitEndpoint(baseUrl, {
                    onStatus: (msg) => setProcessingMessage?.(msg),
                })
            } catch (reuploadErr) {
                console.warn('[Adjust ImageKit] Re-upload failed:', reuploadErr)
                toast.error('Failed to re-upload image to current account: ' + (toUserMessage(reuploadErr, '')))
                return
            }
        }

        img._phosmithImageKitAdjustBaseSrc = baseUrl
        img.phosmithImageKitAdjustBaseSrc = baseUrl
        img.phosmithImageKitAdjustValues = imageKitValues

        // Build: existing-transforms : regular-tokens : ai-token-1 : ai-token-2
        const base = normalizeImageKitUrl(baseUrl)
        const allSteps = []
        // Regular transforms as one comma-joined step
        if (regularTokens.length) allSteps.push(regularTokens.join(','))
        // Each AI transform as its own step
        aiTokens.forEach((t) => allSteps.push(t))

        const nextUrl = buildImageKitChainedTransformUrl(base, allSteps)

        console.log("[Adjust ImageKit] apply start", {
            sourceUrl,
            baseUrl,
            base,
            tokens,
            regularTokens,
            aiTokens,
            allSteps,
            nextUrl,
            image: {
                width: img.width,
                height: img.height,
                scaledWidth: img.getScaledWidth?.(),
                scaledHeight: img.getScaledHeight?.(),
            },
        })

        setIsApplyingImageKit(true)
        setProcessingMessage?.("Applying ImageKit URL transforms...")
        try {
            let readyUrl = nextUrl

            // Only poll when AI transforms are present — they're async.
            // Standard transforms (e-contrast, e-sharpen, etc.) are instant
            // and don't need polling. Polling standard URLs can fail due to CORS.
            if (aiTokens.length > 0) {
                setProcessingMessage?.("Waiting for ImageKit AI processing...")
                readyUrl = await resolveImageKitUrl(nextUrl, {
                    source: "adjust-imagekit-apply",
                    tokens,
                })
            }

            await img.setSrc(readyUrl, { crossOrigin: "anonymous" })
            img.set("dirty", true)
            img.setCoords()
            canvasEditor.requestRenderAll()
            canvasEditor.fire("object:modified", { target: img })
            queueCurveHistogramRefresh(img)
            console.log("[Adjust ImageKit] apply complete", {
                readyUrl,
                width: img.width,
                height: img.height,
                scaledWidth: img.getScaledWidth?.(),
                scaledHeight: img.getScaledHeight?.(),
            })
            toast.success("ImageKit transforms applied")
        } catch (error) {
            console.warn("ImageKit adjustment failed:", error)
            // Provide a user-friendly message for extension quota errors
            const msg = error?.message || ''
            if (/extension.?limit|limit.?exceeded|units.?exhausted/i.test(msg)) {
                toast.error('ImageKit AI extension units exhausted. Only free transforms (contrast, sharpen) are available this month.')
            } else {
                toast.error(msg || "ImageKit transform failed")
            }
        } finally {
            setIsApplyingImageKit(false)
            setProcessingMessage?.(null)
        }
    }

    if (!canvasEditor) {
        return (
            <div className="p-4">
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>Load an image to adjust</p>
            </div>
        )
    }

    return (
        <div className="adjust-panel">
            <div className="adjust-panel-header">
                <div className="flex items-center gap-2">
                    <SlidersHorizontal className="h-4 w-4" />
                    <span>Professional Adjust</span>
                </div>
                <button type="button" onClick={reset} className="adjust-reset-button">
                    <RotateCcw className="h-3.5 w-3.5" /> Reset
                </button>
            </div>

            <div className="adjust-tabs" role="tablist" aria-label="Adjustment groups">
                {FILTER_GROUPS.map((group) => (
                    <button
                        key={group}
                        type="button"
                        onClick={() => setActiveTab(group)}
                        className={`adjust-tab ${activeTab === group ? "is-active" : ""}`}
                        data-active={activeTab === group}
                        role="tab"
                        aria-selected={activeTab === group}
                    >
                        {group}
                    </button>
                ))}
            </div>

            {activeTab === "Curves" ? (
                <div className="adjust-control-list">
                    <CurveEditorPanel
                        values={values}
                        histogram={curveHistogram}
                        activeChannel={activeCurveChannel}
                        onChannelChange={setActiveCurveChannel}
                        onBegin={handleBeginChange}
                        onPreview={handlePreviewChange}
                        onCommit={handleCommitChange}
                    />
                </div>
            ) : activeTab === "Wheels" ? (
                <div className="adjust-control-list">
                    <div className="adjust-look-strip">
                        {LOOKS.map((look) => (
                            <button
                                key={look.id}
                                type="button"
                                onClick={() => setLook(look.id)}
                                className={`adjust-look-button ${values.look === look.id ? "is-active" : ""}`}
                            >
                                {look.label}
                            </button>
                        ))}
                    </div>
                    {WHEEL_CONFIGS.map((config) => (
                        <ColorWheelCard
                            key={config.key}
                            config={config}
                            values={values}
                            onColor={handleColorChange}
                            onAmount={handleWheelAmount}
                        />
                    ))}
                </div>
            ) : activeTab === "ImageKit" ? (
                <div className="adjust-control-list">
                    <ImageKitPanel
                        imageKitValues={imageKitValues}
                        setImageKitValues={setImageKitValues}
                        onApply={applyImageKitTransforms}
                        isApplying={isApplyingImageKit}
                    />
                </div>
            ) : (
                <div className="adjust-control-list">
                    {SLIDER_CONFIGS.filter((cfg) => cfg.group === activeTab).map((cfg) => (
                        <ProRulerSlider
                            key={cfg.key}
                            variant="instrument"
                            value={values[cfg.key]}
                            onBegin={handleBeginChange}
                            onPreview={(v) => handlePreviewChange(cfg.key, v)}
                            onCommit={(v) => handleCommitChange(cfg.key, v)}
                            min={cfg.min}
                            max={cfg.max}
                            step={cfg.step}
                            defaultValue={cfg.defaultValue}
                            label={cfg.label}
                            suffix={cfg.suffix ?? ""}
                            visual={FILTER_VISUAL[cfg.key] || FILTER_VISUAL.brightness}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

export default AdjustControls
