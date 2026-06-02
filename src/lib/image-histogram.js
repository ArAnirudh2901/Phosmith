/**
 * Image Histogram Utilities
 * -------------------------
 * Computes a 256-bucket luminance + RGB histogram for a source image
 * element (or canvas). Used by the Adjust tool's curves panel and by
 * the Mask tool's Luminance Range section. Extracted from
 * `adjust.jsx` in Step 2 so multiple tools can share it without one
 * importing the other's panel.
 *
 * @module image-histogram
 */

export const HISTOGRAM_BUCKETS = 256
export const HISTOGRAM_SAMPLE_SIZE = 260

/**
 * Build an empty histogram object (256 zeroed buckets per channel).
 * @returns {{ red: number[], green: number[], blue: number[], luma: number[] }}
 */
export const emptyHistogram = () => ({
    red: Array(HISTOGRAM_BUCKETS).fill(0),
    green: Array(HISTOGRAM_BUCKETS).fill(0),
    blue: Array(HISTOGRAM_BUCKETS).fill(0),
    luma: Array(HISTOGRAM_BUCKETS).fill(0),
})

/**
 * Resolve the original (pre-filter) image source element from a Fabric
 * image object. Matches the convention used by `adjust.jsx` so the
 * histogram reflects the source pixels, not any active filter state.
 *
 * @param {any} image       Fabric image object.
 * @returns {CanvasImageSource | null}
 */
export const getHistogramSourceElement = (image) =>
    image?._originalElement ||
    image?.getElement?.() ||
    image?._element ||
    image?._filteredEl ||
    image?._cacheCanvas ||
    null

/**
 * Compute a 256-bucket histogram for a Fabric image. Downsamples the
 * source to at most `HISTOGRAM_SAMPLE_SIZE` px on the longest side
 * to keep the work bounded on 4K inputs. Returns `null` if no image
 * is mounted or the source is unreadable (e.g. a tainted canvas).
 *
 * @param {any} image       Fabric image object (or anything with the
 *                          Fabric image's getter/setter conventions).
 * @returns {{ red: number[], green: number[], blue: number[], luma: number[], width: number, height: number } | null}
 */
export const computeImageHistogram = (image) => {
    if (typeof document === 'undefined' || !image) return null
    const source = getHistogramSourceElement(image)
    const sourceWidth = Math.round(source?.naturalWidth || source?.videoWidth || source?.width || image.width || 0)
    const sourceHeight = Math.round(source?.naturalHeight || source?.videoHeight || source?.height || image.height || 0)
    if (!source || !sourceWidth || !sourceHeight) return null

    const scale = Math.min(1, HISTOGRAM_SAMPLE_SIZE / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))
    const scratch = document.createElement('canvas')
    scratch.width = width
    scratch.height = height
    const ctx = scratch.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null

    try {
        ctx.drawImage(source, 0, 0, width, height)
        const { data } = ctx.getImageData(0, 0, width, height)
        const histogram = emptyHistogram()
        let pixels = 0

        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3]
            if (alpha < 16) continue
            const r = data[i]
            const g = data[i + 1]
            const b = data[i + 2]
            const luma = Math.max(0, Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)))
            histogram.red[r] += 1
            histogram.green[g] += 1
            histogram.blue[b] += 1
            histogram.luma[luma] += 1
            pixels += 1
        }

        if (!pixels) return null
        return { ...histogram, width, height, sourceWidth, sourceHeight }
    } catch (error) {
        console.warn('[histogram] unavailable:', error)
        return null
    }
}
