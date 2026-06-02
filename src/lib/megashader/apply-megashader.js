/**
 * Apply Megashader Filter — high-level helper
 * --------------------------------------------
 * The Fabric filter itself is the per-image installation point, but
 * callers (canvas components, hooks) often want a one-shot helper that:
 *
 *   1. Removes any prior MegashaderFilter from the image's filter list.
 *   2. Pushes a fresh MegashaderFilter with the new stack.
 *   3. Calls `image.applyFilters()` (the Fabric trigger that re-runs the
 *      chain through the WebGL2/Canvas2D backend).
 *
 * This is the function the React hook will use on every state change.
 *
 * @module megashader/apply-megashader
 */

import { MegashaderFilter } from './fabric-megashader-filter'
import { hasWebGL2, disposeRenderer } from './megashader-renderer'
import { isAdjustmentsIdentity } from './mask-types'

/**
 * Returns true if the runtime has WebGL2 (or WebGL1, as a degraded
 * fallback). The renderer actually requires WebGL2; this function is
 * exposed so the UI can downgrade a UI affordance (e.g. the test panel's
 * preview badge) when GPU compositing is unavailable.
 *
 * @returns {boolean}
 */
export const hasMegashaderWebGL2 = () => {
    try {
        return hasWebGL2()
    } catch {
        return false
    }
}

/**
 * Type guard: is `obj` a Fabric image (has `filters` + `applyFilters`)?
 * We deliberately duck-type instead of importing `fabric` types to avoid
 * a circular import in some build configurations.
 *
 * @param {any} obj
 * @returns {boolean}
 */
const isFabricImage = (obj) => obj
    && Array.isArray(obj.filters)
    && typeof obj.applyFilters === 'function'

/**
 * Remove every existing MegashaderFilter from `image.filters`. Mutates
 * the array in place so we don't reallocate Fabric's internal filter list.
 *
 * @param {any} image
 * @returns {MegashaderFilter[]} the removed filters (for debugging)
 */
const stripExistingMegashaderFilters = (image) => {
    const removed = []
    image.filters = image.filters.filter((f) => {
        if (f && f.type === 'Megashader') {
            removed.push(f)
            return false
        }
        return true
    })
    return removed
}

/**
 * Install or update the MegashaderFilter on a Fabric image.
 *
 * The function is idempotent — calling it twice with the same `stack`
 * removes the old filter and installs a fresh one. This is cheap because
 * the renderer caches the compiled WebGLProgram by the stack's structural
 * cache key (see `megashader-compiler.js`).
 *
 * If `stack` is empty AND `globalMaskAlpha` is 1, the function is a no-op
 * (no filter installed, no `applyFilters` call) so the image renders
 * through its normal pipeline.
 *
 * Step 9 — Also a no-op when the stack's colour math is identity (every
 * layer's per-layer adjustments are 0). In that case the chain's
 * output is bit-for-bit the source (see `isAdjustmentsIdentity` in
 * mask-types.js for the math), so we can skip installing the filter
 * entirely. This pairs with the `renderMegashader` fast-path, which
 * also short-circuits on identity; doing it here too saves the Fabric
 * filter installation + `applyFilters` call as well.
 *
 * @param {any} image                 Fabric.Image instance.
 * @param {import('./mask-types').MaskStack} stack
 * @param {object} [options]
 * @param {number} [options.globalMaskAlpha]
 * @returns {MegashaderFilter | null} the installed filter, or null if none.
 */
export const applyMegashaderFilter = (image, stack, options = {}) => {
    if (!isFabricImage(image)) return null
    const globalMaskAlpha = typeof options.globalMaskAlpha === 'number' ? options.globalMaskAlpha : 1

    stripExistingMegashaderFilters(image)

    const isEmpty = !stack || !Array.isArray(stack.chain) || stack.chain.length === 0
    // Step 9: identity stacks (chain non-empty but all adjustments 0) are
    // mathematically equivalent to the empty case at the colour level, so
    // they take the same no-op path. The chain's boolean composition still
    // produces a non-trivial alpha, but the colour it would mix in is
    // always srcRgb, so `mix(src, src, x) = src` regardless of x.
    if ((isEmpty || isAdjustmentsIdentity(stack)) && globalMaskAlpha === 1) {
        // No filter to install. Re-run the chain in case a previous filter
        // was removed, so the image re-renders without the megashader.
        try {
            image.applyFilters()
        } catch {
            // Some Fabric versions throw if there are zero filters. Safe to
            // ignore — the image is already in the correct state.
        }
        return null
    }

    const filter = new MegashaderFilter({ stack, globalMaskAlpha })
    image.filters.push(filter)
    try {
        image.applyFilters()
    } catch (e) {
        console.warn('[megashader] applyFilters failed:', e)
    }
    return filter
}

/**
 * Tear down everything. Used by the React hook on full unmount and by
 * test harnesses. The renderer's WebGL cache is freed here; the Fabric
 * filter instance lives on the image and is GC'd with it.
 */
export const disposeMegashader = () => {
    try {
        disposeRenderer()
    } catch {
        // Renderer may not be initialised in a non-browser environment.
    }
}
