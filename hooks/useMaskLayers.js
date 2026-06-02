"use client"

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react"
import { luminanceLayer, colorLayer, linearLayer, radialLayer, semanticLayer, depthLayer, smartBrushLayer, clearMaskTexture, BLEND_OPS } from "@/lib/megashader"

/**
 * useMaskLayers
 * --------------
 * React-side state container for the megashader mask stack. The hook
 * mirrors the lifecycle of `usePixelMaskTool` (the codebase's existing
 * brush-driven mask hook) but is structured around a *chain* of layers
 * rather than a single editable canvas — the megashader is non-destructive
 * and stacks.
 *
 * Returned API:
 *   - `stack`        : the current MaskStack
 *   - `addLayer`     : (kind, params?) => adds a new layer at the end
 *   - `removeLayer`  : (id) => removes the layer
 *   - `updateLayer`  : (id, patch) => merges a partial layer update
 *   - `setLayerOp`   : (id, op) => sets the compositing op
 *   - `moveLayer`    : (id, direction) => 'up' | 'down'
 *   - `clearAll`     : () => empties the chain
 *   - `setGlobalAlpha`: (0..1) => sets the global mask strength fader
 *   - `isReady`      : false while the initial empty stack is being
 *                      established; otherwise true (kept for symmetry with
 *                      the rest of the editor's hooks).
 *
 * The hook deliberately does NOT compile GLSL or touch the canvas itself.
 * It only owns the data + emits change events via the returned `stack`.
 * A separate `useEffect` in the canvas component subscribes to `stack`
 * and calls `applyMegashaderFilter` whenever it changes.
 *
 * Persistence:
 *   Steps 1-7 keep the layer metadata + per-layer textures in module
 *   scope. Persistence to Neon/Redis is Step 8.
 *
 * @returns {object}
 */
export const useMaskLayers = () => {
    const initial = useMemo(() => ({ chain: [] }), [])
    const [stack, dispatch] = useReducer(reducer, initial)
    const isReady = true
    const lastSignatureRef = useRef(null)

    // Notify subscribers when the structural signature changes. We use a
    // custom event on `window` (matching the codebase's pixxel:* convention
    // — see `page.jsx`'s use of "pixxel:tool-sub" for the same pattern).
    useEffect(() => {
        const next = computeSignature(stack)
        if (next !== lastSignatureRef.current) {
            lastSignatureRef.current = next
            try {
                window.dispatchEvent(new CustomEvent('pixxel:mask-layers-changed', { detail: { stack } }))
            } catch { /* SSR safe */ }
        }
    }, [stack])

    const addLayer = useCallback((kind, params = {}) => {
        if (!kind) return null
        // For kinds with real per-kind parameters (luminance, color in Step 2;
        // linear, radial, smartBrush, semantic, depth in later steps), defer
        // to the factory in mask-types.js so the layer comes out with the
        // correct defaults and clamping. Unknown / unsupported kinds fall
        // through to the legacy generic shape (the compiler's stub bodies
        // don't care about field shape).
        let layer = null
        if (kind === 'luminance') {
            layer = luminanceLayer(params)
        } else if (kind === 'color') {
            layer = colorLayer(params)
        } else if (kind === 'linear') {
            layer = linearLayer(params)
        } else if (kind === 'radial') {
            layer = radialLayer(params)
        } else if (kind === 'smartBrush') {
            layer = smartBrushLayer(params)
        } else if (kind === 'semantic') {
            layer = semanticLayer(params)
        } else if (kind === 'depth') {
            layer = depthLayer(params)
        } else {
            // Unknown / future kind: build a minimal layer from `params`
            // (the compiler's stub bodies don't care about field shape).
            // Re-assert id/label/visible/inverted AFTER the `...params`
            // spread so a caller that supplies `id: ''` or `label: ''`
            // (empty string is truthy-falsy in the wrong direction) still
            // ends up with valid values. Same fix as `sanitiseLayer` —
            // see the comment there for the full explanation.
            const id = `layer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
            layer = {
                id,
                kind,
                label: params.label || `Mask ${kind}`,
                opacity: typeof params.opacity === 'number' ? params.opacity : 1,
                visible: params.visible !== false,
                inverted: params.inverted === true,
                ...params,
                id: params.id || id,
                label: params.label || `Mask ${kind}`,
                visible: params.visible !== false,
                inverted: params.inverted === true,
            }
            // Sub-task 1 — `lock` is on every layer (MaskLayerBase), so the
            // generic-kinds fallback has to set it too. The factory-built
            // kinds (luminance/color/linear/radial/smartBrush/semantic/
            // depth) all default it in their factory.
            if (typeof layer.lock !== 'boolean') {
                layer.lock = false
            }
        }
        dispatch({ type: 'add', layer })
        return layer.id
    }, [])

    const removeLayer = useCallback((id) => {
        // Free the texture cache entry for kinds that ship a per-layer
        // image (semantic, smartBrush, depth). The lookup needs the layer
        // object, so we read it from the *current* stack before dispatching
        // — `remove` would drop the entry from the chain. The callback
        // closes over `stack`, but the dispatch is async-ish (the new
        // state is rendered on the next tick), so reading from the
        // current state is still safe.
        const entry = stack.chain.find((e) => e.layer.id === id)
        if (entry && entry.layer) {
            const l = entry.layer
            // semantic / smartBrush use `maskTextureKey` / `brushTextureKey`;
            // depth uses `depthMapKey` — same underlying cache, different
            // field names per kind. All three can coexist in the cache.
            if (typeof l.maskTextureKey === 'string') {
                try { clearMaskTexture(l.maskTextureKey) } catch { /* SSR safe */ }
            }
            if (typeof l.brushTextureKey === 'string') {
                try { clearMaskTexture(l.brushTextureKey) } catch { /* SSR safe */ }
            }
            if (typeof l.depthMapKey === 'string') {
                try { clearMaskTexture(l.depthMapKey) } catch { /* SSR safe */ }
            }
        }
        dispatch({ type: 'remove', id })
    }, [stack])

    const updateLayer = useCallback((id, patch) => {
        dispatch({ type: 'update', id, patch })
    }, [])

    const setLayerOp = useCallback((id, op) => {
        // Sub-task 1 — `BLEND_OPS` now includes the four Photoshop-parity
        // modes (screen/lighten/darken/overlay) in addition to the original
        // four. Validate before dispatch so a stray string from a stale
        // picker can't poison the GLSL chain (the compiler has a default
        // branch but it renders the layer as `add` — silent corruption is
        // worse than a thrown error here).
        if (typeof op !== 'string' || !BLEND_OPS.includes(/** @type {any} */ (op))) {
            if (typeof console !== 'undefined') {
                console.warn(`[useMaskLayers] setLayerOp: ignoring unknown op "${op}"`)
            }
            return
        }
        dispatch({ type: 'setOp', id, op })
    }, [])

    const moveLayer = useCallback((id, direction) => {
        // Sub-task 1 — accept 'up' | 'down' (legacy) and 'top' | 'bottom'
        // (Photoshop's "Bring to front" / "Send to back"). Drag-to-reorder
        // uses the same dispatcher; a drag that lands at index 0 dispatches
        // 'top' and a drag from the top dispatches 'bottom'.
        if (!['up', 'down', 'top', 'bottom'].includes(direction)) {
            if (typeof console !== 'undefined') {
                console.warn(`[useMaskLayers] moveLayer: ignoring unknown direction "${direction}"`)
            }
            return
        }
        dispatch({ type: 'move', id, direction })
    }, [])

    const clearAll = useCallback(() => {
        dispatch({ type: 'clear' })
    }, [])

    const setGlobalAlpha = useCallback((value) => {
        // The global alpha is NOT part of MaskStack — it's a separate UI
        // fader that lives in the hook consumer. Exposed as a callback
        // so the test panel can write to it without owning a second
        // piece of state. Step 1 stores it in the test panel's local
        // state; the canvas reads it through a window event.
        try {
            window.dispatchEvent(new CustomEvent('pixxel:mask-global-alpha', { detail: { value } }))
        } catch { /* SSR safe */ }
    }, [])

    return {
        stack,
        addLayer,
        removeLayer,
        updateLayer,
        setLayerOp,
        moveLayer,
        clearAll,
        setGlobalAlpha,
        isReady,
    }
}

/**
 * Compute a coarse signature for change detection. Used by the canvas
 * effect to decide whether to reinstall the filter or just update its
 * stack reference. Two stacks with the same signature can share a
 * WebGLProgram (the compiler's cache key is more granular than this
 * signature — this is for *filter re-installation* deduping, not shader
 * recompilation).
 */
const computeSignature = (stack) => {
    if (!stack || !Array.isArray(stack.chain)) return 'empty'
    return stack.chain
        .map((e) => `${e.layer.id}:${e.layer.kind}:${e.op}:${e.layer.inverted ? 1 : 0}:${e.layer.visible === false ? 0 : 1}:${e.layer.lock === true ? 1 : 0}`)
        .join('|')
}

const reducer = (state, action) => {
    switch (action.type) {
        case 'add': {
            const chain = state.chain.slice()
            const layer = action.layer
            // First layer always uses 'replace' (compile enforces this too).
            const op = chain.length === 0 ? 'replace' : 'add'
            chain.push({ layer, op })
            return { ...state, chain }
        }
        case 'remove': {
            const chain = state.chain.filter((e) => e.layer.id !== action.id)
            // The first entry's op must stay 'replace' after removal.
            if (chain.length > 0 && chain[0].op !== 'replace') {
                chain[0] = { ...chain[0], op: 'replace' }
            }
            return { ...state, chain }
        }
        case 'clear': {
            // Free every semantic / smartBrush / depth texture before
            // dropping the chain — the cache is module-scoped so the
            // entries would otherwise live on until the next reload.
            for (const entry of state.chain) {
                if (!entry?.layer) continue
                const l = entry.layer
                if (typeof l.maskTextureKey === 'string') {
                    try { clearMaskTexture(l.maskTextureKey) } catch { /* SSR safe */ }
                }
                if (typeof l.brushTextureKey === 'string') {
                    try { clearMaskTexture(l.brushTextureKey) } catch { /* SSR safe */ }
                }
                if (typeof l.depthMapKey === 'string') {
                    try { clearMaskTexture(l.depthMapKey) } catch { /* SSR safe */ }
                }
            }
            return { ...state, chain: [] }
        }
        case 'update': {
            const chain = state.chain.map((e) => {
                if (e.layer.id !== action.id) return e
                return { ...e, layer: { ...e.layer, ...action.patch } }
            })
            return { ...state, chain }
        }
        case 'setOp': {
            const idx = state.chain.findIndex((e) => e.layer.id === action.id)
            if (idx <= 0) return state // cannot change op of first layer
            const chain = state.chain.map((e, i) => {
                if (i !== idx) return e
                return { ...e, op: action.op }
            })
            return { ...state, chain }
        }
        case 'move': {
            const idx = state.chain.findIndex((e) => e.layer.id === action.id)
            if (idx < 0) return state
            let swap = idx
            if (action.direction === 'up') swap = idx - 1
            else if (action.direction === 'down') swap = idx + 1
            else if (action.direction === 'top') swap = 0
            else if (action.direction === 'bottom') swap = state.chain.length - 1
            if (swap === idx) return state
            if (swap < 0 || swap >= state.chain.length) return state
            const chain = state.chain.slice()
            const [moved] = chain.splice(idx, 1)
            chain.splice(swap, 0, moved)
            // After reordering, the first entry's op must be 'replace'.
            if (chain.length > 0 && chain[0].op !== 'replace') {
                chain[0] = { ...chain[0], op: 'replace' }
            }
            return { ...state, chain }
        }
        default:
            return state
    }
}

export default useMaskLayers
