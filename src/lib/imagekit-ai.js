export const isImageKitUrl = (url) => typeof url === 'string' && url.includes('ik.imagekit.io')

export const normalizeImageKitUrl = (url) =>
    String(url || '').split('?')[0].split('#')[0]

export const getImageKitTransformChain = (url) => {
    if (!url || !String(url).includes('?')) return ''
    const query = String(url).split('?')[1]?.split('#')[0] || ''
    const match = query
        .split('&')
        .map((part) => {
            const index = part.indexOf('=')
            return index === -1 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)]
        })
        .find(([key]) => key === 'tr')
    return match?.[1] || ''
}

const getImageKitTransformSteps = (url) =>
    getImageKitTransformChain(url)
        .split(':')
        .map((step) => step.trim())
        .filter(Boolean)

export const buildImageKitChainedTransformUrl = (sourceUrl, transformSteps) => {
    const baseUrl = normalizeImageKitUrl(sourceUrl)
    const chain = transformSteps
        .flatMap((step) => String(step || '').split(':'))
        .map((step) => step.trim())
        .filter(Boolean)
        .join(':')

    if (!baseUrl || !chain) return baseUrl || ''
    return `${baseUrl}?tr=${chain}`
}

/**
 * Encode a genfill prompt for ImageKit URLs.
 * Uses Base64 + URL-encoding ('prompte').
 * Per the docs, the base64 value must be percent-encoded for URL safety:
 *   e.g. prompte-bWFrZSB0aGUgc2Vhd2F0ZXIgYmx1ZQo%3D
 *   (the %3D is the URL-encoded '=' base64 padding character)
 */
export const encodeImageKitPrompt = (prompt) => {
    const text = (prompt || '').trim()
    if (!text) return ''
    const base64 = typeof btoa === 'function'
        ? btoa(unescape(encodeURIComponent(text)))
        : Buffer.from(text, 'utf-8').toString('base64')
    // Percent-encode for URL safety (handles +, /, = in base64 output)
    return encodeURIComponent(base64)
}

/**
 * Build the genfill prompt segment. Uses 'prompte' (base64-encoded) for safety.
 * Per ImageKit docs, bg-genfill must appear FIRST in the comma-separated chain.
 */
const buildGenfillPromptSegment = (prompt) => {
    const encoded = encodeImageKitPrompt(prompt)
    if (!encoded) return 'bg-genfill'
    return `bg-genfill-prompte-${encoded}`
}

export const buildImageKitTransformUrl = (
    sourceUrl,
    transformations,
    { preserveExistingTransforms = false, existingPosition = 'after' } = {}
) => {
    const baseUrl = normalizeImageKitUrl(sourceUrl)
    const nextTransforms = transformations.filter(Boolean)
    const nextChain = nextTransforms.join(',')
    const existingSteps = preserveExistingTransforms ? getImageKitTransformSteps(sourceUrl) : []
    const steps = existingPosition === 'before'
        ? [...existingSteps, nextChain]
        : [nextChain, ...existingSteps]
    const chain = steps.filter(Boolean).join(':')

    if (!baseUrl || !chain) return baseUrl || ''

    return `${baseUrl}?tr=${chain}`
}

/**
 * Build a genfill URL. Per ImageKit docs, the order must be:
 *   w-N,h-N,cm-pad_resize,bg-genfill[-prompte-...]
 */
export const buildGenerativeFillUrl = ({ sourceUrl, prompt, width, height, padResize = true }) => {
    const promptSegment = buildGenfillPromptSegment(prompt)

    const transforms = [
        `w-${Math.max(1, Math.round(width))}`,
        `h-${Math.max(1, Math.round(height))}`,
    ]

    if (padResize) {
        transforms.push('cm-pad_resize')
    }

    // bg-genfill AFTER cm-pad_resize per docs
    transforms.push(promptSegment)

    return buildImageKitTransformUrl(sourceUrl, transforms)
}

/**
 * Genfill on uploaded composite (already target size with transparent margins).
 * Per ImageKit docs, bg-genfill requires w, h, and cm-pad_resize or cm-pad_extract.
 * The composite already has the correct dimensions, so we use cm-pad_extract
 * to preserve the existing layout while filling transparent regions.
 */
export const buildGenfillFromCompositeUrl = ({ sourceUrl, prompt, width, height }) => {
    const promptSegment = buildGenfillPromptSegment(prompt)

    // Per docs: w,h,cm-pad_extract,bg-genfill (bg-genfill AFTER crop mode)
    const transforms = []

    if (width && height) {
        transforms.push(
            `w-${Math.max(1, Math.round(width))}`,
            `h-${Math.max(1, Math.round(height))}`,
            'cm-pad_extract'
        )
    }

    transforms.push(promptSegment)

    return buildImageKitTransformUrl(sourceUrl, transforms)
}

/** Full-resolution ImageKit file URL (strip prior transforms). */
export const getFullResolutionImageKitUrl = (url) => normalizeImageKitUrl(url)

/**
 * Single-axis extend with focus direction.
 * Per ImageKit docs, order: w-N,h-N,cm-pad_resize,fo-direction,bg-genfill[-prompte-...]
 */
export const buildFocusedGenfillUrl = ({ sourceUrl, prompt, width, height, focus = 'center' }) => {
    const focusMap = {
        left: 'fo-left',
        right: 'fo-right',
        top: 'fo-top',
        bottom: 'fo-bottom',
        center: 'fo-center',
    }
    const fo = focusMap[focus] || 'fo-center'
    const promptSegment = buildGenfillPromptSegment(prompt)

    // Per docs: w,h,cm-pad_resize,fo,bg-genfill
    const genfillStep = [
        `w-${Math.max(1, Math.round(width))}`,
        `h-${Math.max(1, Math.round(height))}`,
        'cm-pad_resize',
        fo,
        promptSegment,
    ].join(',')

    return buildImageKitChainedTransformUrl(sourceUrl, [
        ...getImageKitTransformSteps(sourceUrl),
        genfillStep,
    ])
}

export const buildSequentialGenfillUrl = ({ sourceUrl, prompt, expansion }) => {
    const { insets } = expansion || {}
    const promptSegment = buildGenfillPromptSegment(prompt)
    const steps = [...getImageKitTransformSteps(sourceUrl)]
    const left = Math.max(0, Math.round(insets?.left || 0))
    const right = Math.max(0, Math.round(insets?.right || 0))
    const top = Math.max(0, Math.round(insets?.top || 0))
    const bottom = Math.max(0, Math.round(insets?.bottom || 0))
    const fallbackSourceWidth = Number(expansion?.targetWidth) - left - right
    const fallbackSourceHeight = Number(expansion?.targetHeight) - top - bottom
    const initialWidth = Number(expansion?.sourceWidth) || fallbackSourceWidth
    const initialHeight = Number(expansion?.sourceHeight) || fallbackSourceHeight
    const targetWidth = Math.max(
        1,
        Math.round(Number(expansion?.targetWidth) || Number(initialWidth || 1) + left + right)
    )
    const targetHeight = Math.max(
        1,
        Math.round(Number(expansion?.targetHeight) || Number(initialHeight || 1) + top + bottom)
    )

    // Determine the best fo-* focus for cm-pad_resize.
    // The focus anchors the ORIGINAL image — genfill fills the padding on the opposite side(s).
    // ImageKit supports: center, left, right, top, bottom, top_left, top_right, bottom_left, bottom_right
    const focus = getMultiSideFocus({ left, right, top, bottom })

    if (left || right || top || bottom) {
        steps.push([
            `w-${targetWidth}`,
            `h-${targetHeight}`,
            'cm-pad_resize',
            `fo-${focus}`,
            promptSegment,
        ].join(','))
    }

    return buildImageKitChainedTransformUrl(sourceUrl, steps)
}

/**
 * Determine the best ImageKit focus value for multi-side pad_resize.
 * 
 * Single side:   extend right → anchor left (fo-left)
 * Two adjacent:  extend right+bottom → anchor top-left (fo-top_left)
 * Two opposing:  extend left+right → anchor center (fo-center)
 * Three+ sides:  fo-center
 */
function getMultiSideFocus({ left, right, top, bottom }) {
    const hasLeft = left >= 1
    const hasRight = right >= 1
    const hasTop = top >= 1
    const hasBottom = bottom >= 1

    const activeSides = [hasLeft, hasRight, hasTop, hasBottom].filter(Boolean).length

    if (activeSides === 0) return 'center'

    // Single side — anchor to the opposite
    if (activeSides === 1) {
        if (hasLeft) return 'right'
        if (hasRight) return 'left'
        if (hasTop) return 'bottom'
        if (hasBottom) return 'top'
    }

    // Two sides — check if adjacent or opposing
    if (activeSides === 2) {
        // Adjacent pairs → use diagonal focus (anchor to opposite corner)
        if (hasRight && hasBottom) return 'top_left'
        if (hasRight && hasTop) return 'bottom_left'
        if (hasLeft && hasBottom) return 'top_right'
        if (hasLeft && hasTop) return 'bottom_right'

        // Opposing pairs (left+right or top+bottom) — center is the best we can do
        // cm-pad_resize with fo-center distributes padding equally on both sides
        return 'center'
    }

    // Three or four sides → center (distributes padding as evenly as possible)
    return 'center'
}

export const buildAiEditPresetUrl = (sourceUrl, preset) => {
    const presetMap = {
        retouch: ['e-retouch'],
        upscale: ['e-upscale'],
        enhanceSharpen: ['e-retouch', 'e-contrast', 'e-sharpen-10'],
        premiumQuality: ['e-retouch', 'e-upscale', 'e-contrast', 'e-sharpen-10'],
    }

    return buildImageKitTransformUrl(sourceUrl, presetMap[preset] || [])
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll ImageKit until the transformed asset returns image bytes (not HTML placeholder).
 * IMPORTANT: The full URL (including ?tr=... transformations) must be preserved
 * for both polling and the returned value — stripping transforms would poll
 * the original image instead of the genfill result.
 *
 * @param {string} url - Full ImageKit URL with transformations
 * @param {object} opts
 * @param {number} opts.maxAttempts - Max poll attempts (default 20)
 * @param {number} opts.retryDelayMs - Delay before the second poll
 * @param {function} opts.onStatus - Progress callback (attempt, maxAttempts)
 * @param {number} opts.minBytes - Minimum content-length to accept (default 2048)
 * @param {AbortSignal} opts.signal - Optional AbortController signal for cancellation
 */
export async function waitForImageKitUrl(url, { maxAttempts = 2, retryDelayMs = 4000, onStatus, minBytes = 2048, signal } = {}) {
    const totalAttempts = Math.max(1, Math.min(Number(maxAttempts) || 2, 2))
    const delay = Math.max(1000, Math.min(Number(retryDelayMs) || 4000, 30000))
    const base = url

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        if (signal?.aborted) {
            throw new DOMException('Extension cancelled', 'AbortError')
        }

        onStatus?.(attempt, totalAttempts)

        try {
            const response = await fetch(base, {
                mode: 'cors',
                cache: 'no-store',
                signal,
            })
            const contentType = response.headers.get('content-type') || ''
            const isIntermediate = response.headers.get('is-intermediate-response') === 'true'
            const length = Number(response.headers.get('content-length') || 0)

            if (
                response.ok &&
                contentType.startsWith('image/') &&
                !isIntermediate &&
                (length === 0 || length >= minBytes)
            ) {
                return base
            }

            if (!response.ok && response.status >= 400 && !isIntermediate) {
                let detail = ''
                try {
                    detail = (await response.text()).slice(0, 180).trim()
                } catch {
                    /* ignore response body read failures */
                }
                throw new Error(
                    `ImageKit rejected the extension URL (${response.status})${detail ? `: ${detail}` : ''}`
                )
            }
        } catch (err) {
            if (err?.name === 'AbortError') throw err
            if (String(err?.message || '').includes('ImageKit rejected')) throw err
            /* retry on network errors */
        }

        if (attempt < totalAttempts) {
            await sleep(delay)
        }
    }

    throw new Error('ImageKit is still processing this generated image. Try again in a few seconds.')
}

export const getCanvasActiveImage = (canvasEditor) => {
    if (!canvasEditor) return null

    const activeObject = canvasEditor.getActiveObject?.()
    if (activeObject?.type?.toLowerCase() === 'image') {
        return activeObject
    }

    return canvasEditor
        .getObjects?.()
        ?.find((object) => object?.type?.toLowerCase() === 'image') ?? null
}

export const replaceCanvasImageFromUrl = async (
    canvasEditor,
    sourceImage,
    nextUrl,
    { preserveDisplayedBounds = true, placement = 'fit', maxRetries = 2 } = {}
) => {
    if (!canvasEditor || !sourceImage || !nextUrl) return null

    const { FabricImage } = await import('fabric')

    // Retry logic — ImageKit genfill can take 10-30s for the first request
    let nextImage = null
    let lastError = null

    const totalRetries = Math.max(1, Math.min(Number(maxRetries) || 2, 2))

    for (let attempt = 1; attempt <= totalRetries; attempt++) {
        try {
            nextImage = await FabricImage.fromURL(nextUrl, {
                crossOrigin: nextUrl.startsWith('data:') || nextUrl.startsWith('blob:') ? undefined : 'anonymous',
            })
            break // Success
        } catch (err) {
            lastError = err
            console.warn(`[ImageKit] Load attempt ${attempt}/${totalRetries} failed:`, err?.message || err)

            if (attempt < totalRetries) {
                const delay = 2500
                console.log(`[ImageKit] Retrying in ${delay / 1000}s...`)
                await new Promise(resolve => setTimeout(resolve, delay))
            }
        }
    }

    if (!nextImage) {
        throw new Error(
            `Failed to load image after ${totalRetries} attempts. ` +
            `This may be a CORS issue or the image is too large for server-side processing. ` +
            `Try reducing the extension percentage or using fewer directions. ` +
            `(${lastError?.message || 'Unknown error'})`
        )
    }

    const renderedWidth = sourceImage.getScaledWidth?.() || sourceImage.width || nextImage.width
    const renderedHeight = sourceImage.getScaledHeight?.() || sourceImage.height || nextImage.height
    const sourceScaleX = sourceImage.scaleX || 1
    const sourceScaleY = sourceImage.scaleY || 1

    if (placement === 'native') {
        nextImage.set({
            left: 0,
            top: 0,
            angle: sourceImage.angle,
            originX: 'left',
            originY: 'top',
            scaleX: 1,
            scaleY: 1,
            selectable: sourceImage.selectable,
            evented: sourceImage.evented,
        })
    } else {
        const nextScale = preserveDisplayedBounds
            ? Math.min(
                renderedWidth / (nextImage.width || 1),
                renderedHeight / (nextImage.height || 1)
            )
            : null

        nextImage.set({
            left: sourceImage.left,
            top: sourceImage.top,
            angle: sourceImage.angle,
            originX: sourceImage.originX || 'center',
            originY: sourceImage.originY || 'center',
            scaleX: preserveDisplayedBounds ? nextScale : sourceScaleX,
            scaleY: preserveDisplayedBounds ? nextScale : sourceScaleY,
            selectable: sourceImage.selectable,
            evented: sourceImage.evented,
        })
    }

    canvasEditor.remove(sourceImage)
    canvasEditor.add(nextImage)
    canvasEditor.setActiveObject(nextImage)
    nextImage.setCoords()
    canvasEditor.requestRenderAll()

    return nextImage
}
