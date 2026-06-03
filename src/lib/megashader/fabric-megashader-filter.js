/**
 * Fabric Megashader Filter
 * ------------------------
 * A `fabric.Image.filters.BaseFilter` subclass that wraps the private-WebGL
 * megashader renderer (`megashader-renderer.js`). It is marked as a 2D
 * filter (`is2d = true`) so Fabric's filter chain treats its output as a
 * regular 2D canvas — this is what lets us coexist with the codebase's
 * decision to disable Fabric's WebGL filtering (see the comment in
 * `canvas.jsx`).
 *
 * Lifecycle:
 *   1. Caller (the canvas component) creates a `new MegashaderFilter({ ... })`
 *      and pushes it into `image.filters`. The constructor stores the layer
 *      stack but does NOT compile a shader yet.
 *   2. Fabric calls `applyTo(canvas, sourceCanvas)` for each filter in the
 *      chain. We render the megashader to a fresh 2D canvas via
 *      `renderMegashader` and `drawImage` it onto the destination canvas.
 *   3. `serialize` produces a Fabric-friendly plain object for persistence
 *      via `loadFromJSON`. `initializeFromObject` is the inverse.
 *
 * Why the filter does not subclass the existing `BaseFilter` directly:
 *   The codebase already has a custom `PixxelCurvesFilter` extending
 *   `fabric.Image.filters.BaseFilter`. We mirror that pattern but keep this
 *   filter in its own file so the curves work and the megashader work can
 *   evolve independently.
 *
 * @module megashader/fabric-megashader-filter
 */

import { filters, classRegistry } from 'fabric'
import { renderMegashader, disposeRenderer } from './megashader-renderer'
import { getMaskTexture, setMaskTexture } from './mask-types'

const MEGASHADER_FILTER_TYPE = 'Megashader'

// Field names that carry an opaque mask-texture-cache key, by kind. Used to
// serialise/restore the per-layer textures (semantic / depth / smartBrush /
// lasso) so a persisted chain survives save → reload.
const TEXTURE_KEY_FIELDS = ['maskTextureKey', 'brushTextureKey', 'depthMapKey']

/**
 * Convert a cached texture (ImageData | HTMLCanvasElement | HTMLImageElement |
 * ImageBitmap) to a PNG data URL for persistence. Returns null if it can't be
 * rasterised (non-browser, tainted canvas, zero-size).
 */
const textureToDataUrl = (data) => {
    try {
        if (!data || typeof document === 'undefined') return null
        let canvas
        if (typeof HTMLCanvasElement !== 'undefined' && data instanceof HTMLCanvasElement) {
            canvas = data
        } else if (typeof ImageData !== 'undefined' && data instanceof ImageData) {
            canvas = document.createElement('canvas')
            canvas.width = data.width
            canvas.height = data.height
            canvas.getContext('2d')?.putImageData(data, 0, 0)
        } else {
            const w = data.width || data.naturalWidth || 0
            const h = data.height || data.naturalHeight || 0
            if (!w || !h) return null
            canvas = document.createElement('canvas')
            canvas.width = w
            canvas.height = h
            canvas.getContext('2d')?.drawImage(data, 0, 0)
        }
        return canvas.toDataURL('image/png')
    } catch {
        return null
    }
}

/**
 * Decode a PNG data URL back into the texture cache under `key`. Resolves
 * once the texture is registered (or on error) so callers can await it BEFORE
 * the filter renders (otherwise the layer would sample the null texture).
 */
const restoreTexture = (key, dataUrl) => new Promise((resolve) => {
    try {
        if (typeof document === 'undefined' || !dataUrl) { resolve(); return }
        const img = new Image()
        img.onload = () => {
            try {
                const c = document.createElement('canvas')
                c.width = img.naturalWidth || img.width
                c.height = img.naturalHeight || img.height
                c.getContext('2d')?.drawImage(img, 0, 0)
                setMaskTexture(key, c)
            } catch { /* ignore */ }
            resolve()
        }
        img.onerror = () => resolve()
        img.src = dataUrl
    } catch {
        resolve()
    }
})

/**
 * @typedef {Object} MegashaderFilterOptions
 * @property {import('./mask-types').MaskStack} [stack]    The current mask stack.
 * @property {number} [globalMaskAlpha]                    0..1 — extra UI fader.
 * @property {boolean} [enabled]                           When false, `applyTo`
 *                                                         is a no-op passthrough
 *                                                         (used during preview
 *                                                         and tool changes).
 */

export class MegashaderFilter extends filters.BaseFilter {
    /**
     * @param {MegashaderFilterOptions} [options]
     */
    constructor(options = {}) {
        super()
        this.type = MEGASHADER_FILTER_TYPE
        // No fragmentSource — the renderer compiles the real source. This
        // 2D filter only drawImages the pre-rendered canvas.
        this.is2d = true
        this.stack = options.stack || { chain: [] }
        this.globalMaskAlpha = typeof options.globalMaskAlpha === 'number' ? options.globalMaskAlpha : 1
        this.enabled = options.enabled !== false
        // Chain-wide render options. globalInvert is persisted (a real mask
        // property); maskOverlay/overlayColor are transient view state.
        this.globalInvert = options.globalInvert === true
        this.maskOverlay = options.maskOverlay === true
        this.overlayColor = options.overlayColor || null
    }

    /**
     * Fabric invokes `applyTo` for each filter in the chain. We render the
     * megashader over `sourceCanvas` and draw the result onto `targetCanvas`.
     *
     * @param {CanvasRenderingContext2D} targetCtx
     * @param {HTMLCanvasElement} sourceCanvas
     */
    applyTo(targetCtx, sourceCanvas) {
        if (!this.enabled) {
            targetCtx.drawImage(sourceCanvas, 0, 0)
            return
        }
        // Bug #3 hardening: a bad stack (unknown kind/op, GL link failure,
        // readback error) must degrade to a passthrough — drawing the
        // untouched source — instead of throwing out of Fabric's filter
        // loop and leaving the image canvas blank.
        let result
        try {
            result = renderMegashader(sourceCanvas, this.stack, {
                globalMaskAlpha: this.globalMaskAlpha,
                globalInvert: this.globalInvert,
                maskOverlay: this.maskOverlay,
                overlayColor: this.overlayColor,
            })
        } catch (e) {
            console.warn('[megashader] render failed, passing through source:', e)
            result = sourceCanvas
        }
        targetCtx.save()
        targetCtx.globalCompositeOperation = 'source-over'
        targetCtx.drawImage(result || sourceCanvas, 0, 0)
        targetCtx.restore()
    }

    /**
     * Update the mask stack + global alpha. Triggers a redraw of the owning
     * image via the caller (we don't have a Fabric `image` ref here).
     *
     * @param {MegashaderFilterOptions} next
     */
    update(next = {}) {
        if (next.stack) this.stack = next.stack
        if (typeof next.globalMaskAlpha === 'number') this.globalMaskAlpha = next.globalMaskAlpha
        if (typeof next.enabled === 'boolean') this.enabled = next.enabled
    }

    /**
     * Fabric serialises filters via `toObject`/`toJSON`. Persist the
     * minimum needed to rehydrate the filter on `loadFromJSON`. Texture
     * handles (smartBrush, semantic, depth) are intentionally NOT persisted
     * here — those need separate persistence paths (Step 7).
     *
     * @returns {object}
     */
    toObject() {
        // Serialise every texture-backed layer's texture (semantic / depth /
        // smartBrush / lasso) as a PNG data URL keyed by its cache key, so a
        // reloaded project re-registers them and the selection survives.
        const textures = {}
        const chain = (this.stack && Array.isArray(this.stack.chain)) ? this.stack.chain : []
        for (const entry of chain) {
            const layer = entry && entry.layer
            if (!layer) continue
            for (const field of TEXTURE_KEY_FIELDS) {
                const key = layer[field]
                if (typeof key === 'string' && key && !textures[key]) {
                    const url = textureToDataUrl(getMaskTexture(key))
                    if (url) textures[key] = url
                }
            }
        }
        const out = {
            ...super.toObject(),
            type: MEGASHADER_FILTER_TYPE,
            stack: this.stack,
            globalMaskAlpha: this.globalMaskAlpha,
            globalInvert: this.globalInvert,
            enabled: this.enabled,
        }
        if (Object.keys(textures).length > 0) out.textures = textures
        return out
    }

    /**
     * Inverse of `toObject`. Fabric's `loadFromJSON` calls this on the
     * registered class. We restore the persisted textures into the cache
     * BEFORE resolving the filter, so the first render samples real masks
     * instead of the null texture.
     *
     * @param {object} [object]
     * @param {{ target: any }} [options]
     */
    static async fromObject(object, options = {}) {
        const textures = object && object.textures
        if (textures && typeof textures === 'object') {
            await Promise.all(
                Object.entries(textures).map(([key, url]) => restoreTexture(key, url)),
            )
        }
        const filter = new MegashaderFilter({
            stack: object?.stack,
            globalMaskAlpha: object?.globalMaskAlpha,
            globalInvert: object?.globalInvert,
            enabled: object?.enabled,
        })
        const target = options?.target
        if (target) filter.target = target
        return filter
    }
}

// Register with Fabric's classRegistry so `loadFromJSON` can rehydrate
// `type: "Megashader"` filters. Importing this file is the side effect
// that wires it up — the same pattern the codebase uses for the curves
// filter (see `import "../../../../../lib/curves-filter"` in canvas.jsx).
classRegistry.setClass(MegashaderFilter, MEGASHADER_FILTER_TYPE)

/**
 * Tear down the renderer's GL cache. Call this from a React cleanup
 * effect if the editor is fully unmounting.
 */
export const disposeMegashader = () => disposeRenderer()
