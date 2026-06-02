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

const MEGASHADER_FILTER_TYPE = 'Megashader'

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
        const result = renderMegashader(sourceCanvas, this.stack, {
            globalMaskAlpha: this.globalMaskAlpha,
        })
        targetCtx.save()
        targetCtx.globalCompositeOperation = 'source-over'
        targetCtx.drawImage(result, 0, 0)
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
        return {
            ...super.toObject(),
            type: MEGASHADER_FILTER_TYPE,
            stack: this.stack,
            globalMaskAlpha: this.globalMaskAlpha,
            enabled: this.enabled,
        }
    }

    /**
     * Inverse of `toObject`. Fabric's `loadFromJSON` calls this on the
     * registered class.
     *
     * @param {object} [object]
     * @param {{ target: any }} [options]
     */
    static fromObject(object, options = {}) {
        const filter = new MegashaderFilter({
            stack: object?.stack,
            globalMaskAlpha: object?.globalMaskAlpha,
            enabled: object?.enabled,
        })
        const target = options?.target
        if (target) filter.target = target
        return Promise.resolve(filter)
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
