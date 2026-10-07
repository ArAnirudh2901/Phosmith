import { useEffect, useRef } from "react"
import { isPhosmithMaskOverlay } from "../../../../../../lib/canvas-mask"

// Installs and updates the megashader filter on the primary image whenever the mask layer stack changes.
export function useMegashaderPreview({
    canvasEditor,
    canvasInstanceRef,
    scheduleSaveRef,
}) {
    // Uncompiled, like the component it was cut from.
    "use no memo"

    // ─── Megashader filter wiring ────────────────────────────────────────────
    // The megashader is a stateful pipeline shared via the window event bus
    // (see useMaskLayers in /hooks). Whenever the mask layer stack changes,
    // we find the primary Fabric image on the canvas and install/update the
    // MegashaderFilter. The filter itself is a 2D passthrough that delegates
    // to a private WebGL2 context (see src/lib/megashader/), so installing it
    // doesn't disturb Fabric's filter chain for the curves/grade filters.
    //
    // BOTH refs are component-level so they survive `useEffect` re-runs
    // (which happen when `canvasEditor` changes). Pre-fix, the
    // `getLastAppliedStackRef` was a plain object declared INSIDE the
    // effect, so each re-run created a fresh one starting at `{ chain: [] }`
    // — the first `handleGlobalAlpha` after a re-run would re-apply with
    // an empty stack and silently drop the megashader. The component-level
    // `useRef` keeps the value stable across the effect's re-mounts.
    //
    // Step 10.2 — `recompileTimerRef` is a component-level `useRef`
    // holding the debounce timer for `handleLayersChanged`. Without
    // this, dragging a slider (e.g. per-layer exposure) fires
    // `phosmith:mask-layers-changed` on every step; the GLSL compiler
    // (50-200 ms for a complex chain) re-runs for every step, blocking
    // the main thread. The 150 ms debounce coalesces a rapid burst
    // into one recompile after the user pauses.
    const megashaderAlphaRef = useRef(1)
    // "Show mask" overlay + global invert — chain-wide render options driven
    // by the Mask tool via window events; mirror globalAlpha's ref pattern.
    const megashaderOverlayRef = useRef(false)
    const megashaderViewRef = useRef('tint')
    const megashaderInvertRef = useRef(false)
    const getLastAppliedStackRef = useRef(/** @type {import('@/lib/megashader/mask-types').MaskStack} */ ({ chain: [] }))
    const recompileTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null))
    // Draft live-preview (grade drags): GPU overlay + rAF fast path.
    const previewSessionRef = useRef(/** @type {any} */ (null))
    const previewCommitTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null))
    const maskApplyRafRef = useRef(/** @type {number | null} */ (null))
    const lastStructuralSigRef = useRef(/** @type {string | null} */ (null))
    useEffect(() => {
        if (typeof window === 'undefined') return undefined

        const findPrimaryImage = () => {
            const canvas = canvasInstanceRef.current
            if (!canvas) return null
            const objects = canvas.getObjects?.() || []
            return objects.find(
                (obj) => obj?.type?.toLowerCase?.() === 'image' && !isPhosmithMaskOverlay(obj)
            ) || null
        }

        // The actual recompile — factored out so the debounced wrapper
        // and `handleGlobalAlpha` both call the same code path.
        const doApply = (stack) => {
            const image = findPrimaryImage()
            if (!image) return
            // Lazy-load the megashader module so the production editor bundle
            // never pulls in the GLSL compiler unless the dev test panel
            // (or a Step 2+ tool) actually subscribes.
            import('@/lib/megashader')
                .then((mod) => {
                    // A new chain structure would link its shader synchronously
                    // inside the render. Link it in the background first, then
                    // apply the latest stack.
                    if (mod.isMegashaderProgramReady && !mod.isMegashaderProgramReady(stack)) {
                        mod.prewarmMegashaderProgram(stack).then((linked) => {
                            if (linked) doApply(getLastAppliedStackRef.current)
                            else applyNow(mod, stack)
                        })
                        return
                    }
                    applyNow(mod, stack)
                })
                .catch(() => { /* noop — module not available in non-test paths */ })
        }

        const applyNow = (mod, stack) => {
            const image = findPrimaryImage()
            if (!image) return
            // Split the dynamic-import failure (module genuinely absent
            // in a non-test build — safe to ignore) from a failure
            // INSIDE applyMegashaderFilter. The latter used to be
            // swallowed here, which silently hid a real render bug (the
            // MegashaderFilter constructor threw on every call, so no
            // mask layer ever rendered). Surface apply errors loudly.
            try {
                mod.applyMegashaderFilter(image, stack, {
                    globalMaskAlpha: megashaderAlphaRef.current,
                    globalInvert: megashaderInvertRef.current,
                    maskOverlay: megashaderOverlayRef.current,
                    maskView: megashaderViewRef.current,
                })
                canvasInstanceRef.current?.requestRenderAll?.()
                // Mask edits fire no object:* events; persist via the debounced autosave.
                scheduleSaveRef.current?.('major')
            } catch (err) {
                console.error('[megashader] applyMegashaderFilter failed:', err)
            }
        }

        // ── Draft-preview session ─────────────────────────────────────
        // The exact pipeline (doApply → applyFilters → megashader render →
        // readPixels → getImageData) moves ~5 full-resolution buffers per
        // tick — linear in megapixels, so grade drags on large photos drop
        // to a slideshow. During a drag we instead render the megashader
        // from a capped-resolution snapshot into a DOM <canvas> overlaid
        // exactly on the image (GPU work + one small readback per frame,
        // independent of source size), and run the exact full-res pipeline
        // ONCE when the drag goes idle. Lightroom-style draft preview.
        // The drag preview used to render at a fixed 1280 px because a full
        // frame cost too much. The batched renderer with its prefix cache holds
        // ~60 fps at 4K, so the preview now matches what is actually on screen
        // (device pixels), capped so a zoomed-in 100 MP file cannot blow up.
        const PREVIEW_MAX_EDGE = 4096
        const PREVIEW_MIN_EDGE = 640
        const PREVIEW_COMMIT_IDLE_MS = 160

        const startPreviewSession = () => {
            const canvas = canvasInstanceRef.current
            const image = findPrimaryImage()
            if (!canvas || !image || !canvas.wrapperEl) return null
            // An axis-aligned overlay can't represent a rotated image —
            // fall back to the exact per-tick pipeline (correct, slower).
            if (Math.abs((image.angle || 0) % 360) > 0.01) return null

            // Clean source = all prior filters, WITHOUT the megashader.
            // When the megashader is the only filter this is simply the
            // original element (free); otherwise re-run the chain once with
            // the megashader disabled — a single full-res cost at drag
            // START, not per tick.
            let cleanSource = image._originalElement
            const hasOtherFilters = Array.isArray(image.filters)
                && image.filters.some((f) => f && f.type !== 'Megashader')
            if (hasOtherFilters) {
                const mega = image.filters.find((f) => f && f.type === 'Megashader')
                if (mega) {
                    mega.enabled = false
                    try { image.applyFilters() } catch { /* keep going */ }
                    mega.enabled = true
                }
                cleanSource = image._element || cleanSource
            }
            const srcW = cleanSource?.naturalWidth || cleanSource?.width || 0
            const srcH = cleanSource?.naturalHeight || cleanSource?.height || 0
            if (!srcW || !srcH) return null

            // How many device pixels this image actually occupies right now.
            const coords = image.oCoords || {}
            const onScreenW = coords.tr && coords.tl ? Math.abs(coords.tr.x - coords.tl.x) : 0
            const onScreenH = coords.bl && coords.tl ? Math.abs(coords.bl.y - coords.tl.y) : 0
            const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1
            const neededEdge = Math.max(onScreenW, onScreenH) * dpr
            const targetEdge = Math.min(
                PREVIEW_MAX_EDGE,
                Math.max(PREVIEW_MIN_EDGE, Math.round(neededEdge || PREVIEW_MIN_EDGE)),
            )
            const scale = Math.min(1, targetEdge / Math.max(srcW, srcH))
            const srcCanvas = document.createElement('canvas')
            srcCanvas.width = Math.max(1, Math.round(srcW * scale))
            srcCanvas.height = Math.max(1, Math.round(srcH * scale))
            const sctx = srcCanvas.getContext('2d')
            if (!sctx) return null
            sctx.imageSmoothingEnabled = true
            sctx.imageSmoothingQuality = 'high'
            sctx.drawImage(cleanSource, 0, 0, srcCanvas.width, srcCanvas.height)

            const overlayEl = document.createElement('canvas')
            overlayEl.className = 'phosmith-megashader-preview'
            overlayEl.style.position = 'absolute'
            overlayEl.style.pointerEvents = 'none'
            // Under the interaction canvas (selection borders, brush cursor
            // stay visible), over the lower canvas that shows the image.
            canvas.wrapperEl.insertBefore(overlayEl, canvas.upperCanvasEl || null)
            const session = {
                overlayEl,
                ctx: overlayEl.getContext('2d'),
                srcCanvas,
                image,
                // The session's source is drawn once and never changes, so the
                // renderer can keep its GPU copy and the composite below the
                // edited layer across frames (see prefixCache).
                sourceVersion: `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            }
            previewSessionRef.current = session
            return session
        }

        const removePreviewOverlay = (session) => {
            try { session.overlayEl.remove() } catch { /* already gone */ }
        }

        const endPreviewSession = (commit) => {
            const session = previewSessionRef.current
            if (!session) return
            previewSessionRef.current = null
            if (previewCommitTimerRef.current !== null) {
                clearTimeout(previewCommitTimerRef.current)
                previewCommitTimerRef.current = null
            }
            if (!commit) {
                removePreviewOverlay(session)
                return
            }
            // Exact full-res commit; drop the overlay only after fabric has
            // painted the committed pixels so the swap is seamless.
            doApply(getLastAppliedStackRef.current)
            const canvas = canvasInstanceRef.current
            let removed = false
            const removeOnce = () => {
                if (removed) return
                removed = true
                removePreviewOverlay(session)
            }
            if (canvas?.once) canvas.once('after:render', removeOnce)
            // Safety net — never leave a stale overlay glued to the DOM.
            setTimeout(removeOnce, 600)
        }

        const renderPreviewFrame = (stack) => {
            const session = previewSessionRef.current
            const canvas = canvasInstanceRef.current
            if (!session || !canvas) return
            const { image, overlayEl, ctx, srcCanvas } = session
            if (!ctx || !canvas.getObjects?.().includes(image)) {
                endPreviewSession(false)
                return
            }
            import('@/lib/megashader').then((mod) => {
                // Guard: session may have committed while the module loaded.
                if (previewSessionRef.current !== session) return
                // Never block a live-preview frame on a shader link: link in
                // the background and repaint once ready.
                if (mod.isMegashaderProgramReady && !mod.isMegashaderProgramReady(stack)) {
                    mod.prewarmMegashaderProgram(stack).then((linked) => {
                        if (linked) scheduleImmediateApply()
                        else if (previewSessionRef.current === session) endPreviewSession(true)
                    })
                    return
                }
                try {
                    // Position the overlay on the image's on-screen quad.
                    // oCoords are fabric's own viewport-space (CSS px)
                    // corners — exact under any pan/zoom, refreshed here so
                    // a mid-drag zoom can't leave the overlay stranded.
                    image.setCoords()
                    const { tl, tr, bl } = image.oCoords || {}
                    if (!tl || !tr || !bl) { endPreviewSession(false); return }
                    const cssW = Math.max(1, tr.x - tl.x)
                    const cssH = Math.max(1, bl.y - tl.y)
                    overlayEl.style.left = `${tl.x}px`
                    overlayEl.style.top = `${tl.y}px`
                    overlayEl.style.width = `${cssW}px`
                    overlayEl.style.height = `${cssH}px`
                    // Backing store: preview-res is enough while dragging —
                    // scale to the smaller of screen size and preview size.
                    const dpr = window.devicePixelRatio || 1
                    const bw = Math.max(1, Math.min(Math.round(cssW * dpr), srcCanvas.width))
                    const bh = Math.max(1, Math.min(Math.round(cssH * dpr), srcCanvas.height))
                    if (overlayEl.width !== bw) overlayEl.width = bw
                    if (overlayEl.height !== bh) overlayEl.height = bh

                    const result = mod.renderMegashader(srcCanvas, stack, {
                        globalMaskAlpha: megashaderAlphaRef.current,
                        globalInvert: megashaderInvertRef.current,
                        maskOverlay: megashaderOverlayRef.current,
                        maskView: megashaderViewRef.current,
                        sourceVersion: session.sourceVersion,
                        reuseOutput: true,
                    })
                    if (!result) return
                    ctx.imageSmoothingEnabled = true
                    ctx.clearRect(0, 0, overlayEl.width, overlayEl.height)
                    ctx.drawImage(result, 0, 0, overlayEl.width, overlayEl.height)
                } catch (err) {
                    console.warn('[megashader] preview frame failed, committing full-res:', err)
                    endPreviewSession(true)
                }
            }).catch((err) => {
                console.warn('[megashader] preview module load failed:', err)
                endPreviewSession(false)
            })
        }

        const schedulePreviewCommit = () => {
            if (previewCommitTimerRef.current !== null) {
                clearTimeout(previewCommitTimerRef.current)
            }
            previewCommitTimerRef.current = setTimeout(() => {
                previewCommitTimerRef.current = null
                endPreviewSession(true)
            }, PREVIEW_COMMIT_IDLE_MS)
        }

        // Structural signature — mirrors `computeCacheKey()` in
        // src/lib/megashader/megashader-compiler.js (length|kinds|ops).
        // Grade values (gamma/wheels/curves/adjust sliders) are uniforms
        // and never change it. Deliberately NOT imported from
        // '@/lib/megashader': that module stays lazy-loaded (see doApply)
        // so the editor bundle never pulls in the GLSL compiler. Keep in
        // sync with computeCacheKey if mask kinds/ops semantics change.
        const structuralSignature = (stack) => {
            const chain = Array.isArray(stack?.chain) ? stack.chain : []
            return `${chain.length}|${chain.map((e) => e?.layer?.kind).join(',')}|${chain.map((e) => e?.op).join(',')}`
        }

        // Uniform-only fast path: one trailing rAF per frame; it reads the
        // latest stack at fire time, so the drag's release value always
        // lands and a pending frame can never apply a stale snapshot.
        // Inside the rAF, prefer the draft-preview session (GPU-only,
        // resolution-capped, instantaneous at any source size); fall back
        // to the exact per-tick pipeline when a session can't be built
        // (no image, rotated image, missing wrapper).
        const scheduleImmediateApply = () => {
            if (maskApplyRafRef.current !== null) return
            maskApplyRafRef.current = requestAnimationFrame(() => {
                maskApplyRafRef.current = null
                const stack = getLastAppliedStackRef.current
                const session = previewSessionRef.current || startPreviewSession()
                if (session) {
                    renderPreviewFrame(stack)
                    schedulePreviewCommit()
                } else {
                    doApply(stack)
                }
            })
        }

        // Step 10.2: debounced entry point. Cancels any pending
        // recompile and schedules a new one 150 ms out. The 150 ms
        // window is short enough to feel instant on slider release
        // but long enough to coalesce a fast slider drag into a
        // single recompile.
        const RECOMPILE_DEBOUNCE_MS = 150
        let structuralGen = 0
        const handleLayersChanged = () => {
            // A structural change mid-drag invalidates the preview's
            // compiled assumptions — drop the overlay; the debounced
            // full-res apply below repaints the truth.
            endPreviewSession(false)
            if (recompileTimerRef.current !== null) {
                clearTimeout(recompileTimerRef.current)
            }
            recompileTimerRef.current = setTimeout(() => {
                recompileTimerRef.current = null
                // Link the new structure's program in the background first so
                // the full apply is a cache hit rather than a ~300 ms sync link.
                // Only the newest structural change applies.
                const gen = ++structuralGen
                import('@/lib/megashader')
                    .then((mod) => mod.prewarmMegashaderProgram?.(getLastAppliedStackRef.current))
                    .catch(() => {})
                    .finally(() => {
                        // Apply the LATEST stack, not the triggering event's — uniform
                        // drags may have landed via the fast path while this was
                        // pending, and re-applying an older snapshot would revert them.
                        if (gen === structuralGen) doApply(getLastAppliedStackRef.current)
                    })
            }, RECOMPILE_DEBOUNCE_MS)
        }

        const handleGlobalAlpha = (event) => {
            const value = event?.detail?.value
            if (typeof value !== 'number') return
            megashaderAlphaRef.current = Math.max(0, Math.min(1, value))
            // Alpha is a uniform, not a shader-struct change — skip
            // the debounce so the slider feels live. The shader
            // recompile is gated on the LRU cache, so if the program
            // was already compiled for this exact stack, the second
            // call is just a `applyFilters` re-run.
            scheduleImmediateApply()
        }

        // "Show mask" overlay + global invert — chain-wide render options.
        // Like alpha, they're uniforms (no recompile), so re-apply live
        // against the last-applied stack.
        const handleOverlay = (event) => {
            megashaderOverlayRef.current = Boolean(event?.detail?.value)
            scheduleImmediateApply()
        }
        const handleView = (event) => {
            megashaderViewRef.current = event?.detail?.value === 'bw' ? 'bw' : 'tint'
            scheduleImmediateApply()
        }
        const handleInvert = (event) => {
            megashaderInvertRef.current = Boolean(event?.detail?.value)
            scheduleImmediateApply()
        }

        const wrapped = (event) => {
            const stack = event?.detail?.stack || { chain: [] }
            getLastAppliedStackRef.current = stack
            // Uniform-only edits (grade slider drags: gamma/wheels/curves/
            // adjust) keep the same length|kinds|ops signature — no recompile,
            // so take the live rAF preview path. A changed signature (layer
            // add/remove/reorder/op) is structural → debounced full apply.
            const sig = structuralSignature(stack)
            const structural = lastStructuralSigRef.current === null || sig !== lastStructuralSigRef.current
            lastStructuralSigRef.current = sig
            if (structural) {
                handleLayersChanged()
            } else {
                scheduleImmediateApply()
            }
        }

        window.addEventListener('phosmith:mask-layers-changed', wrapped)
        window.addEventListener('phosmith:mask-global-alpha', handleGlobalAlpha)
        window.addEventListener('phosmith:mask-overlay', handleOverlay)
        window.addEventListener('phosmith:mask-invert', handleInvert)
        window.addEventListener('phosmith:mask-view', handleView)

        return () => {
            window.removeEventListener('phosmith:mask-layers-changed', wrapped)
            window.removeEventListener('phosmith:mask-global-alpha', handleGlobalAlpha)
            window.removeEventListener('phosmith:mask-overlay', handleOverlay)
            window.removeEventListener('phosmith:mask-invert', handleInvert)
            window.removeEventListener('phosmith:mask-view', handleView)
            // Cancel the live-preview rAF/commit timers and drop any
            // overlay so a mid-drag unmount can't leave a stale <canvas>
            // glued to the DOM or fire an apply against a torn-down renderer.
            if (maskApplyRafRef.current !== null) {
                cancelAnimationFrame(maskApplyRafRef.current)
                maskApplyRafRef.current = null
            }
            endPreviewSession(false)
            // Step 10.2: clear any pending debounced recompile so a
            // canvasEditor change mid-debounce doesn't fire a stale
            // apply against a torn-down renderer.
            if (recompileTimerRef.current !== null) {
                clearTimeout(recompileTimerRef.current)
                recompileTimerRef.current = null
            }
        }
    }, [canvasEditor])
}
