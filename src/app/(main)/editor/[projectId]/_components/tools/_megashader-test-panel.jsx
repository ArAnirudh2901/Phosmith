"use client"

import React, { useCallback, useEffect, useState } from "react"
import { Beaker, Trash2, Sparkles, AlertTriangle, Gauge, RotateCcw } from "lucide-react"
import { useMaskLayers } from "../../../../../../../hooks/useMaskLayers"
import usePlanAccess from "../../../../../../../hooks/usePlanAccess"
import { hasMegashaderWebGL2, setMaskTexture, getRenderMetrics, resetRenderMetrics } from "@/lib/megashader"
import { motion, AnimatePresence } from "framer-motion"
import { MaskChainCard } from "./_pixel-tool-ui"

const KINDS = [
    { id: "linear", label: "Linear Gradient", pro: true },
    { id: "radial", label: "Radial Gradient", pro: true },
    { id: "luminance", label: "Luminance Range" },
    { id: "color", label: "Color Range" },
    { id: "smartBrush", label: "Smart Brush", pro: true },
    { id: "semantic", label: "AI Subject", pro: true },
    { id: "depth", label: "Depth Map", pro: true },
]

const OPS = [
    { id: "replace", label: "Replace" },
    { id: "add", label: "Add" },
    { id: "subtract", label: "Subtract" },
    { id: "intersect", label: "Intersect" },
]

/**
 * Megashader Test Panel (dev-only)
 * --------------------------------
 * Mounted by the editor sidebar only when `process.env.NODE_ENV !==
 * 'production'`. Provides a minimal UI to add up to 8 mask layers, pick
 * their compositing op, toggle visibility, and watch the megashader
 * pipeline recompose in real time. The actual visual result is rendered
 * by the canvas component; this panel is a *control surface*.
 *
 * Step 1's only visible result is the boolean chain exercising itself
 * (steps 2-6 will plug in real mask math). To make the pipeline
 * observable without real math, the panel also displays the compiled
 * fragment-shader source for the current stack — copy/paste friendly for
 * debugging.
 */
const MegashaderTestPanel = () => {
    const layers = useMaskLayers()
    const { isPro } = usePlanAccess()
    const { stack, addLayer, removeLayer, updateLayer, setLayerOp, moveLayer, clearAll, setGlobalAlpha } = layers
    const [globalAlpha, setGlobalAlphaLocal] = useState(1)
    const [webgl2, setWebgl2] = useState(null)
    const [compiledPreview, setCompiledPreview] = useState(null)
    // Step 10.3: live render metrics. The renderer's counters live
    // in module scope, so we poll `getRenderMetrics()` on a 250 ms
    // tick (cheap, no allocations, no React re-renders outside the
    // state setter). The "Reset" button calls `resetRenderMetrics()`.
    const [metrics, setMetrics] = useState(() => getRenderMetrics())
    useEffect(() => {
        if (typeof window === 'undefined') return undefined
        // Poll render metrics every 250ms, but only re-render when one of
        // the tracked counters actually changes. `getRenderMetrics()` returns
        // a fresh object snapshot every call, so a naive `setMetrics(snap)`
        // would force a re-render four times a second for the lifetime of
        // the editor — even when no work is happening. We keep the last
        // snapshot in a ref and bail out on a no-op update.
        const lastRef = { current: getRenderMetrics() }
        const id = setInterval(() => {
            const next = getRenderMetrics()
            const prev = lastRef.current
            if (
                prev.compileCount === next.compileCount &&
                prev.cacheHits === next.cacheHits &&
                prev.cacheMisses === next.cacheMisses &&
                prev.evictions === next.evictions &&
                prev.lastCompileMs === next.lastCompileMs &&
                prev.totalCompileMs === next.totalCompileMs &&
                prev.drawCount === next.drawCount &&
                prev.identityShortCircuits === next.identityShortCircuits
            ) {
                return
            }
            lastRef.current = next
            setMetrics(next)
        }, 250)
        return () => clearInterval(id)
    }, [])

    useEffect(() => {
        // `hasMegashaderWebGL2` is synchronous (returns a boolean, not a
        // Promise) — it just calls `canvas.getContext('webgl2')` and
        // returns the result. Earlier versions of the test panel treated
        // it as a Promise (`.then(...)`), which threw a runtime
        // `boolean.then is not a function` TypeError on mount. The
        // check is cheap and safe to run on every mount, so no cleanup
        // flag is needed.
        setWebgl2(hasMegashaderWebGL2())
    }, [])

    // Re-compile the shader whenever the structural shape changes (Step 1
    // does this lazily so the user can see what the megashader would
    // produce). We import dynamically so production builds never pull
    // the compiler into the editor bundle.
    useEffect(() => {
        let cancelled = false
        if (process.env.NODE_ENV === 'production') return
        import('@/lib/megashader').then((mod) => {
            if (cancelled) return
            try {
                const compiled = mod.compileMegashader(stack)
                setCompiledPreview({
                    cacheKey: compiled.cacheKey,
                    passthrough: compiled.passthrough,
                    chain: stack.chain.map((e) => `${e.op} ${e.layer.kind}`),
                    opStrings: extractBooleanOps(compiled.frag),
                })
            } catch (e) {
                setCompiledPreview({ error: e?.message || String(e) })
            }
        }).catch(() => { /* ignore */ })
        return () => { cancelled = true }
    }, [stack])

    const handleAdd = useCallback((kind) => {
        // Semantic needs a mask texture before it can be added. The dev
        // test panel synthesises a small test mask (a centred white
        // circle on a black background) so the kind can be exercised
        // end-to-end without going through the AI service. Production
        // users add semantic layers via the Mask tool's "Click to
        // Select" panel, which fetches a real SAM 2 mask.
        if (kind === 'semantic') {
            const W = 256
            const H = 256
            const c = document.createElement('canvas')
            c.width = W
            c.height = H
            const ctx = c.getContext('2d')
            if (!ctx) return
            // Black background
            ctx.fillStyle = '#000'
            ctx.fillRect(0, 0, W, H)
            // White filled circle (the "subject")
            ctx.fillStyle = '#fff'
            ctx.beginPath()
            ctx.arc(W / 2, H / 2, Math.min(W, H) * 0.3, 0, Math.PI * 2)
            ctx.fill()
            const imageData = ctx.getImageData(0, 0, W, H)
            const key = `test-semantic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
            setMaskTexture(key, imageData)
            addLayer('semantic', { maskTextureKey: key, label: 'Test Semantic' })
            return
        }
        // Depth needs a depth-map texture. Synthesise a vertical gradient
        // (top = white/near, bottom = black/far) so the kind can be
        // exercised end-to-end without the Python service. Production
        // users add depth layers via the Mask tool's "Depth Range"
        // panel, which fetches a real Depth Anything V2 map.
        if (kind === 'depth') {
            const W = 256
            const H = 256
            const c = document.createElement('canvas')
            c.width = W
            c.height = H
            const ctx = c.getContext('2d')
            if (!ctx) return
            // Vertical gradient: top (y=0) is white (255), bottom (y=H)
            // is black (0). The megashader's depth range then selects a
            // band — e.g. min=0.4 picks the middle rows.
            const grad = ctx.createLinearGradient(0, 0, 0, H)
            grad.addColorStop(0, 'rgb(255,255,255)')
            grad.addColorStop(1, 'rgb(0,0,0)')
            ctx.fillStyle = grad
            ctx.fillRect(0, 0, W, H)
            const imageData = ctx.getImageData(0, 0, W, H)
            const key = `test-depth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
            setMaskTexture(key, imageData)
            addLayer('depth', { depthMapKey: key, min: 0.3, max: 0.7, softness: 0.1, label: 'Test Depth' })
            return
        }
        // Smart brush needs a painted alpha texture. Synthesise a
        // soft diagonal stroke via overlapping radial-gradient stamps
        // so the bilateral filter has non-trivial input to smooth.
        if (kind === 'smartBrush') {
            const W = 256
            const H = 256
            const c = document.createElement('canvas')
            c.width = W
            c.height = H
            const ctx = c.getContext('2d')
            if (!ctx) return
            const stamps = [
                { x: 60,  y: 60,  r: 30 },
                { x: 110, y: 110, r: 30 },
                { x: 160, y: 160, r: 30 },
                { x: 200, y: 200, r: 30 },
            ]
            for (const s of stamps) {
                const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r)
                grad.addColorStop(0, 'rgba(255,255,255,1)')
                grad.addColorStop(0.7, 'rgba(255,255,255,1)')
                grad.addColorStop(1, 'rgba(255,255,255,0)')
                ctx.fillStyle = grad
                ctx.beginPath()
                ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
                ctx.fill()
            }
            const key = `test-brush-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
            setMaskTexture(key, c)
            addLayer('smartBrush', { brushTextureKey: key, filterRadius: 3, sigmaColor: 0.15, sigmaSpace: 2, label: 'Test Smart Brush' })
            return
        }
        addLayer(kind)
    }, [addLayer])

    const handleGlobalAlpha = useCallback((v) => {
        setGlobalAlphaLocal(v)
        setGlobalAlpha(v)
    }, [setGlobalAlpha])

    /**
     * Step 8 — One-click demo: add a luminance layer with non-zero
     * adjustments so the panel surfaces the new per-layer adjustment
     * sliders in action. The user can then tweak the sliders under
     * "Adjustments (this layer)" to see the result in real time.
     */
    const handleAddAdjustDemo = useCallback(() => {
        const id = addLayer('luminance', {
            label: 'Step 8 Adjust Demo',
            exposure: 0.5,
            contrast: 20,
            saturation: 30,
            brightness: 10,
        })
        // The returned id lets the test panel scroll the new card into
        // view in a future polish step. For now we just discard it.
        return id
    }, [addLayer])

    return (
        <div className="space-y-3 panel-scroll pr-1">
            {/* ─── Banner ─── */}
            <div
                className="rounded-lg p-2.5 text-[10px] flex items-start gap-2"
                style={{
                    background: "rgba(245, 158, 11, 0.08)",
                    border: "1px solid rgba(245, 158, 11, 0.25)",
                    color: "var(--text-secondary)",
                }}
            >
                <Beaker className="h-3.5 w-3.5 mt-px shrink-0" style={{ color: "#F59E0B" }} />
                <div className="flex-1">
                    <div className="font-semibold mb-0.5 flex items-center gap-1.5" style={{ color: "#F59E0B" }}>
                        Megashader Test Panel
                        <span
                            className="text-[8px] font-bold px-1 rounded"
                            style={{ background: "rgba(245, 158, 11, 0.18)", color: "#F59E0B" }}
                            title="Mounted only when NODE_ENV !== 'production'. Hidden in production builds."
                        >DEV</span>
                    </div>
                    <p>Steps 1-9 are live: boolean compositing, luminance/color/
                        linear/radial, smart brush, AI semantic, depth, per-layer
                        image adjustments (exposure/contrast/saturation/brightness),
                        and the identity fast-path. When every layer&apos;s
                        adjustments are zero, the renderer skips the GL pass
                        entirely and returns the source canvas as-is.</p>
                </div>
            </div>

            {/* ─── Capability badge ─── */}
            <div className="flex items-center gap-2 text-[10px]">
                <span
                    className="px-1.5 py-0.5 rounded font-semibold"
                    style={{
                        background: webgl2 === null
                            ? "var(--bg-elevated)"
                            : webgl2
                                ? "rgba(34, 197, 94, 0.18)"
                                : "rgba(239, 68, 68, 0.18)",
                        color: webgl2 === null
                            ? "var(--text-muted)"
                            : webgl2
                                ? "#22C55E"
                                : "#EF4444",
                    }}
                >
                    {webgl2 === null ? "Checking…" : webgl2 ? "WebGL2: OK" : "WebGL2: MISSING (CPU fallback)"}
                </span>
                {webgl2 === false && (
                    <span className="flex items-center gap-1" style={{ color: "var(--text-muted)" }}>
                        <AlertTriangle className="h-3 w-3" /> CPU path
                    </span>
                )}
            </div>

            {/* ─── Add layer ─── */}
            <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "var(--text-muted)" }}>
                    Add Test Layer
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                    {KINDS.map((k) => {
                        // Only show the PRO tag when the kind is a paid
                        // feature AND the current user is not on the Pro
                        // plan. Pro users don't need the affordance.
                        const isProLocked = k.pro && !isPro
                        return (
                            <motion.button
                                key={k.id}
                                type="button"
                                onClick={() => handleAdd(k.id)}
                                whileTap={{ scale: 0.95 }}
                                className="flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-[10px] font-medium editor-interactive"
                                style={{
                                    background: "var(--bg-elevated)",
                                    border: "1px solid var(--border-subtle)",
                                    color: "var(--text-secondary)",
                                }}
                            >
                                <span className="truncate">{k.label}</span>
                                {isProLocked && (
                                    <span className="text-[8px] font-bold px-1 rounded" style={{ background: "rgba(124,58,237,0.2)", color: "#A78BFA" }}>PRO</span>
                                )}
                            </motion.button>
                        )
                    })}
                </div>
                <motion.button
                    type="button"
                    onClick={handleAddAdjustDemo}
                    whileTap={{ scale: 0.97 }}
                    className="w-full mt-1.5 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] font-medium editor-interactive"
                    style={{
                        background: "rgba(6, 184, 212, 0.1)",
                        border: "1px solid rgba(6, 184, 212, 0.35)",
                        color: "var(--accent-primary)",
                    }}
                    title="Adds a Luminance layer with +0.5 EV exposure, +20 contrast, +30 saturation, +10 brightness"
                >
                    <Sparkles className="h-3 w-3" />
                    Step 8 demo: Add with adjustments
                </motion.button>
            </div>

            {/* ─── Global alpha ─── */}
            <div>
                <div className="flex items-center justify-between text-[10px] mb-1.5">
                    <span className="font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Global Mask Alpha</span>
                    <span style={{ color: "var(--text-secondary)" }}>{Math.round(globalAlpha * 100)}%</span>
                </div>
                <input
                    type="range"
                    min="0"
                    max="100"
                    value={Math.round(globalAlpha * 100)}
                    onChange={(e) => handleGlobalAlpha(Number(e.target.value) / 100)}
                    className="w-full"
                />
            </div>

            {/* ─── Layer list ─── */}
            <div>
                <div className="flex items-center justify-between text-[10px] mb-1.5">
                    <span className="font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                        Chain ({stack.chain.length}/8)
                    </span>
                    {stack.chain.length > 0 && (
                        <button
                            type="button"
                            onClick={clearAll}
                            className="flex items-center gap-1 text-[10px]"
                            style={{ color: "#EF4444" }}
                        >
                            <Trash2 className="h-3 w-3" /> Clear
                        </button>
                    )}
                </div>

                <div className="space-y-1.5">
                    <AnimatePresence>
                        {stack.chain.map((entry, i) => (
                            <MaskChainCard
                                key={entry.layer.id}
                                entry={entry}
                                index={i}
                                total={stack.chain.length}
                                isFirst={i === 0}
                                onUpdate={(patch) => updateLayer(entry.layer.id, patch)}
                                onRemove={removeLayer}
                                onMove={moveLayer}
                                onSetOp={setLayerOp}
                            />
                        ))}
                    </AnimatePresence>

                    {stack.chain.length === 0 && (
                        <div
                            className="text-[10px] text-center py-4 rounded-md"
                            style={{ color: "var(--text-muted)", border: "1px dashed var(--border-subtle)" }}
                        >
                            No layers yet. Pick a kind above to add one.
                        </div>
                    )}
                </div>
            </div>

            {/* ─── Step 10.3: Render perf metrics ─── */}
            <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider mb-1.5 flex items-center justify-between" style={{ color: "var(--text-muted)" }}>
                    <span className="flex items-center gap-1.5">
                        <Gauge className="h-3 w-3" /> Render perf
                    </span>
                    <button
                        type="button"
                        onClick={() => { resetRenderMetrics(); setMetrics(getRenderMetrics()) }}
                        className="text-[9px] px-1.5 py-0.5 rounded inline-flex items-center gap-1 hover:opacity-100 opacity-60"
                        style={{ border: "1px solid var(--border-subtle)" }}
                        title="Reset all render counters"
                    >
                        <RotateCcw className="h-2.5 w-2.5" /> reset
                    </button>
                </div>
                <div
                    className="rounded-md p-2 text-[9px] font-mono leading-relaxed grid grid-cols-2 gap-x-3 gap-y-0.5"
                    style={{
                        background: "var(--bg-base)",
                        border: "1px solid var(--border-subtle)",
                        color: "var(--text-secondary)",
                    }}
                >
                    <div><span style={{ color: "var(--text-muted)" }}>draws:</span> {metrics.drawCount}</div>
                    <div><span style={{ color: "var(--text-muted)" }}>id-shortcuts:</span> {metrics.identityShortCircuits}</div>
                    <div><span style={{ color: "var(--text-muted)" }}>cache hits:</span> {metrics.cacheHits}</div>
                    <div><span style={{ color: "var(--text-muted)" }}>cache misses:</span> {metrics.cacheMisses}</div>
                    <div><span style={{ color: "var(--text-muted)" }}>compile count:</span> {metrics.compileCount}</div>
                    <div><span style={{ color: "var(--text-muted)" }}>evictions:</span> {metrics.evictions}</div>
                    <div><span style={{ color: "var(--text-muted)" }}>last compile:</span> {metrics.lastCompileMs.toFixed(1)} ms</div>
                    <div><span style={{ color: "var(--text-muted)" }}>total compile:</span> {metrics.totalCompileMs.toFixed(1)} ms</div>
                </div>
            </div>

            {/* ─── Compiled shader preview ─── */}
            <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider mb-1.5 flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
                    <Sparkles className="h-3 w-3" /> Compiled Megashader
                </div>
                <div
                    className="rounded-md p-2 text-[9px] font-mono leading-relaxed"
                    style={{
                        background: "var(--bg-base)",
                        border: "1px solid var(--border-subtle)",
                        color: "var(--text-secondary)",
                        maxHeight: 160,
                        overflow: "auto",
                    }}
                >
                    {!compiledPreview ? (
                        <span style={{ color: "var(--text-muted)" }}>compiling…</span>
                    ) : compiledPreview.error ? (
                        <span style={{ color: "#EF4444" }}>Error: {compiledPreview.error}</span>
                    ) : (
                        <>
                            <div><span style={{ color: "var(--text-muted)" }}>cacheKey:</span> {compiledPreview.cacheKey}</div>
                            <div><span style={{ color: "var(--text-muted)" }}>passthrough:</span> {String(compiledPreview.passthrough)}</div>
                            <div><span style={{ color: "var(--text-muted)" }}>chain:</span> {compiledPreview.chain.join(" → ") || "(empty)"}</div>
                            {compiledPreview.opStrings && compiledPreview.opStrings.length > 0 && (
                                <div className="mt-1">
                                    <span style={{ color: "var(--text-muted)" }}>emitted GLSL ops:</span>
                                    <ul className="pl-3 mt-0.5">
                                        {compiledPreview.opStrings.map((s, i) => (
                                            <li key={i}>• <code>{s}</code></li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}

/**
 * Pull the boolean op strings out of the compiled fragment shader for
 * the test panel's preview. Naive substring search is fine — the strings
 * are produced by the compiler verbatim.
 *
 * Step 8: the chain format changed from a single `runningAlpha` to a
 * pair of `runningColor`/`runningAlpha` accumulators. The op emissions
 * are still recognisable by their unique forms.
 */
const extractBooleanOps = (frag) => {
    if (!frag) return []
    const out = []
    if (frag.includes("float a_0 = evalLayer(0);") && frag.includes("vec3 c_0 = applyLayerAdjust_0(srcRgb);")) {
        out.push("float a_0 = evalLayer(0); vec3 c_0 = applyLayerAdjust_0(srcRgb);  // base")
    }
    if (frag.includes("runningColor = mix(runningColor, c_") && frag.includes("runningAlpha = clamp(runningAlpha + a_")) {
        out.push("runningColor = mix(runningColor, c_i, a_i); runningAlpha = clamp(...)  // add")
    }
    if (frag.includes("runningAlpha = max(runningAlpha - a_")) {
        out.push("runningAlpha = max(runningAlpha - a_i, 0.0);  // subtract")
    }
    if (frag.includes("runningAlpha = runningAlpha * a_")) {
        out.push("runningColor = mix(...); runningAlpha = runningAlpha * a_i;  // intersect")
    }
    return out
}

export default MegashaderTestPanel
