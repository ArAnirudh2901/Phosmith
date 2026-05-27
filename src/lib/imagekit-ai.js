export const isImageKitUrl = (url) => typeof url === 'string' && url.includes('ik.imagekit.io')

/**
 * Check if a URL belongs to the currently configured ImageKit endpoint.
 * Returns false for URLs belonging to a different ImageKit account.
 */
export const isCurrentImageKitEndpoint = (url) => {
    if (!isImageKitUrl(url)) return false
    const endpoint = (typeof window !== 'undefined'
        ? process.env.NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT
        : process.env.NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT) || ''
    if (!endpoint) return true // no endpoint configured, skip check
    // Extract the path segment after ik.imagekit.io/ (the ImageKit ID)
    const urlId = String(url).match(/ik\.imagekit\.io\/([^/]+)/)?.[1] || ''
    const endpointId = String(endpoint).match(/ik\.imagekit\.io\/([^/]+)/)?.[1] || ''
    return urlId && endpointId && urlId === endpointId
}

/**
 * If the image URL belongs to a different ImageKit account, re-upload it
 * to the current account. Returns the new URL (or the original if already current).
 * This is needed because AI extension units are charged to the account that
 * owns the URL endpoint, not the account making the API call.
 */
export const ensureCurrentImageKitEndpoint = async (url, { onStatus } = {}) => {
    if (!isImageKitUrl(url)) return url
    if (isCurrentImageKitEndpoint(url)) return url

    onStatus?.('Re-uploading image to current account...')
    console.log('[ImageKit] Re-uploading foreign image to current account', { url })

    // Fetch the image as a blob
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to fetch image for re-upload (${response.status})`)
    const blob = await response.blob()

    // Extract a filename from the URL
    const urlPath = new URL(url).pathname
    const fileName = urlPath.split('/').pop() || `reupload-${Date.now()}.jpg`

    // Upload to current account via the existing upload API
    const formData = new FormData()
    formData.append('file', blob, fileName)
    formData.append('fileName', fileName)

    const uploadResponse = await fetch('/api/imagekit/upload', {
        method: 'POST',
        body: formData,
    })
    const data = await uploadResponse.json()

    if (!uploadResponse.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to re-upload image to current ImageKit account')
    }

    console.log('[ImageKit] Re-upload complete', { oldUrl: url, newUrl: data.url })
    return data.url
}

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

const CHAINED_AI_TRANSFORM_PREFIXES = [
    'e-bgremove',
    'e-removedotbg',
    'e-changebg',
    'e-dropshadow',
    'e-edit',
    'e-genvar',
    'e-retouch',
    'e-upscale',
]

export const isImageKitAiTransform = (token) => {
    const value = String(token || '').trim()
    return CHAINED_AI_TRANSFORM_PREFIXES.some((prefix) =>
        value === prefix ||
        value.startsWith(`${prefix}-`) ||
        value.startsWith(`${prefix}_`)
    )
}

export const buildImageKitAiTransformSteps = (transformations = []) => {
    const steps = []

    for (const step of transformations.flatMap((item) => String(item || '').split(':'))) {
        const regularTokens = []
        const tokens = step
            .split(',')
            .map((token) => token.trim())
            .filter(Boolean)

        for (const token of tokens) {
            if (isImageKitAiTransform(token)) {
                if (regularTokens.length) {
                    steps.push(regularTokens.splice(0).join(','))
                }
                steps.push(token)
            } else {
                regularTokens.push(token)
            }
        }

        if (regularTokens.length) {
            steps.push(regularTokens.join(','))
        }
    }

    return steps
}

export const hasImageKitAiTransform = (transformations = []) =>
    transformations
        .flatMap((item) => {
            const value = String(item || '')
            const chain = value.includes('?') ? getImageKitTransformChain(value) : ''
            return (chain || value).split(/[,:]/)
        })
        .some((token) => isImageKitAiTransform(token))

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

export const buildImageKitAiTransformUrl = (
    sourceUrl,
    transformations,
    { preserveExistingTransforms = false, existingPosition = 'after' } = {}
) => {
    const nextSteps = buildImageKitAiTransformSteps(transformations)
    const existingSteps = preserveExistingTransforms ? getImageKitTransformSteps(sourceUrl) : []
    const steps = existingPosition === 'before'
        ? [...existingSteps, ...nextSteps]
        : [...nextSteps, ...existingSteps]

    return buildImageKitChainedTransformUrl(sourceUrl, steps)
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

    const hasH = left >= 1 || right >= 1   // horizontal extension
    const hasV = top >= 1 || bottom >= 1   // vertical extension

    // ── Single-axis only: one step is enough ──
    if ((hasH && !hasV) || (hasV && !hasH)) {
        const targetWidth = Math.max(1, Math.round(
            Number(expansion?.targetWidth) || initialWidth + left + right
        ))
        const targetHeight = Math.max(1, Math.round(
            Number(expansion?.targetHeight) || initialHeight + top + bottom
        ))
        const focus = getMultiSideFocus({ left, right, top, bottom })
        steps.push([
            `w-${targetWidth}`,
            `h-${targetHeight}`,
            'cm-pad_resize',
            `fo-${focus}`,
            promptSegment,
        ].join(','))
        return buildImageKitChainedTransformUrl(sourceUrl, steps)
    }

    // ── Multi-axis (2+ sides on both axes): split into TWO sequential steps ──
    // Step 1: extend horizontally (left/right) first
    // Step 2: extend vertically (top/bottom) on the intermediate result
    // This gives genfill a clear single-axis anchor each time.

    if (hasH) {
        const hWidth = Math.max(1, Math.round(initialWidth + left + right))
        const hHeight = Math.max(1, Math.round(initialHeight)) // keep original height
        const hFocus = getMultiSideFocus({ left, right, top: 0, bottom: 0 })
        steps.push([
            `w-${hWidth}`,
            `h-${hHeight}`,
            'cm-pad_resize',
            `fo-${hFocus}`,
            promptSegment,
        ].join(','))

        // Step 2: extend vertically on the now-wider intermediate image
        if (hasV) {
            const vWidth = hWidth // same as step 1 output
            const vHeight = Math.max(1, Math.round(hHeight + top + bottom))
            const vFocus = getMultiSideFocus({ left: 0, right: 0, top, bottom })
            steps.push([
                `w-${vWidth}`,
                `h-${vHeight}`,
                'cm-pad_resize',
                `fo-${vFocus}`,
                promptSegment,
            ].join(','))
        }
    } else if (hasV) {
        // Only vertical — shouldn't reach here (caught by single-axis branch above)
        const targetWidth = Math.max(1, Math.round(initialWidth))
        const targetHeight = Math.max(1, Math.round(initialHeight + top + bottom))
        const focus = getMultiSideFocus({ left: 0, right: 0, top, bottom })
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
 * Three sides:   anchor to the ONE side NOT being extended
 * Four sides:    fo-center
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
        return 'center'
    }

    // Three sides — anchor to the ONE side that is NOT being extended.
    // E.g., extending left+right+bottom → image at top → fo-top
    if (activeSides === 3) {
        if (!hasTop) return 'top'       // extending left+right+bottom → anchor top
        if (!hasBottom) return 'bottom'  // extending left+right+top → anchor bottom
        if (!hasLeft) return 'left'      // extending right+top+bottom → anchor left
        if (!hasRight) return 'right'    // extending left+top+bottom → anchor right
    }

    // Four sides → center
    return 'center'
}

/**
 * Build AI edit preset URL using chained transform steps.
 * 
 * IMPORTANT: AI transforms (e-retouch, e-upscale, etc.) must each be a separate
 * chained step (colon-separated), not comma-separated in a single step.
 * Each AI transform processes the output of the previous one.
 * 
 * e-upscale has a 16MP input limit — skip it for images that are already large
 * (e.g. post-extension results). The function detects this from the source URL
 * or an explicit sourceDims parameter.
 */
export const buildAiEditPresetUrl = (sourceUrl, preset, { sourceDims } = {}) => {
    const presetMap = {
        retouch: ['e-retouch'],
        upscale: ['e-upscale'],
        enhanceSharpen: ['e-contrast', 'e-sharpen-10'],
        premiumQuality: ['e-retouch', 'e-upscale', 'e-contrast', 'e-sharpen-10'],
    }

    let transforms = [...(presetMap[preset] || [])]

    // e-upscale fails on images > 16MP (ImageKit limit).
    // Skip it if source dimensions are known and exceed the threshold,
    // or if the source is an extend-result (already large).
    const isLikelyLarge =
        (sourceDims?.width && sourceDims?.height && sourceDims.width * sourceDims.height > 14_000_000) ||
        /extend-result/i.test(sourceUrl)

    if (isLikelyLarge) {
        transforms = transforms.filter((t) => t !== 'e-upscale')
    }

    if (!transforms.length) return normalizeImageKitUrl(sourceUrl)

    return buildImageKitAiTransformUrl(sourceUrl, transforms)
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
export async function waitForImageKitUrl(url, { maxAttempts = 8, retryDelayMs = 4000, onStatus, minBytes = 2048, signal } = {}) {
    const totalAttempts = Math.max(1, Math.min(Number(maxAttempts) || 8, 20))
    const delay = Math.max(1000, Math.min(Number(retryDelayMs) || 4000, 30000))
    // Keep full URL including ?tr= — normalizeImageKitUrl is for source assets only, not genfill results.
    const base = url
    const startedAt = Date.now()

    console.log('[ImageKit] wait start', {
        url: base,
        totalAttempts,
        retryDelayMs: delay,
        minBytes,
    })

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        if (signal?.aborted) {
            console.warn('[ImageKit] wait aborted', { url: base, attempt })
            throw new DOMException('Extension cancelled', 'AbortError')
        }

        onStatus?.(attempt, totalAttempts)

        try {
            console.log('[ImageKit] wait attempt', {
                url: base,
                attempt,
                totalAttempts,
                elapsedMs: Date.now() - startedAt,
            })
            const response = await fetch(base, {
                mode: 'cors',
                cache: 'no-store',
                signal,
            })
            const contentType = response.headers.get('content-type') || ''
            const isIntermediate = response.headers.get('is-intermediate-response') === 'true'
            const length = Number(response.headers.get('content-length') || 0)
            const ikError = response.headers.get('ik-error') || ''

            console.log('[ImageKit] wait response', {
                url: base,
                attempt,
                status: response.status,
                ok: response.ok,
                contentType,
                contentLength: length,
                isIntermediate,
                ikError,
                elapsedMs: Date.now() - startedAt,
            })

            if (
                response.ok &&
                contentType.startsWith('image/') &&
                !isIntermediate &&
                (length === 0 || length >= minBytes)
            ) {
                console.log('[ImageKit] wait ready', {
                    url: base,
                    attempt,
                    elapsedMs: Date.now() - startedAt,
                })
                return base
            }

            if (!response.ok && response.status >= 400 && !isIntermediate) {
                let detail = ''
                try {
                    const ikError = response.headers.get('ik-error') || ''
                    const body = (await response.text()).slice(0, 180).trim()
                    detail = [ikError, body].filter(Boolean).join(': ')
                } catch {
                    /* ignore response body read failures */
                }

                // Specific user-friendly message for extension unit exhaustion
                if (response.status === 403 && /extension.?limit|limit.?exceeded/i.test(detail)) {
                    throw new Error(
                        'ImageKit AI extension units exhausted for this month. ' +
                        'Free plans include 650 units/month (each AI Extend costs 90, Retouch costs 5, Upscale costs 5). ' +
                        'Upgrade your ImageKit plan or wait for the monthly reset. ' +
                        'Non-AI transforms (contrast, sharpen, crop) still work.'
                    )
                }

                throw new Error(
                    `ImageKit rejected the transform URL (${response.status})${detail ? `: ${detail}` : ''}`
                )
            }
        } catch (err) {
            if (err?.name === 'AbortError') throw err
            if (String(err?.message || '').includes('ImageKit rejected')) throw err
            console.warn('[ImageKit] wait request failed; retrying if attempts remain', {
                url: base,
                attempt,
                message: err?.message || String(err),
            })
            /* retry on network errors */
        }

        if (attempt < totalAttempts) {
            console.log('[ImageKit] wait sleep', {
                url: base,
                nextAttempt: attempt + 1,
                delayMs: delay,
            })
            await sleep(delay)
        }
    }

    console.warn('[ImageKit] wait timed out', {
        url: base,
        attempts: totalAttempts,
        elapsedMs: Date.now() - startedAt,
    })
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
    { preserveDisplayedBounds = true, placement = 'fit', maxRetries = 4 } = {}
) => {
    if (!canvasEditor || !sourceImage || !nextUrl) return null

    const { FabricImage } = await import('fabric')

    // Retry logic — ImageKit AI transforms can take 10-30s for the first request
    let nextImage = null
    let lastError = null

    const totalRetries = Math.max(1, Math.min(Number(maxRetries) || 4, 10))

    console.log('[ImageKit] canvas replace start', {
        nextUrl,
        preserveDisplayedBounds,
        placement,
        totalRetries,
        source: {
            width: sourceImage.width,
            height: sourceImage.height,
            scaledWidth: sourceImage.getScaledWidth?.(),
            scaledHeight: sourceImage.getScaledHeight?.(),
            left: sourceImage.left,
            top: sourceImage.top,
        },
    })

    // ImageKit AI transforms (e-upscale, e-retouch, e-bgremove, e-genfill,
    // etc.) cache the result against the *exact URL*. Appending a fresh
    // cache-bust on each retry would defeat that cache and trigger a brand-new
    // 20–60s server-side run every time — which is exactly the bug we shipped
    // earlier (every retry waited ~30s and failed because Fabric got back the
    // intermediate HTML response). For these URLs the canonical form MUST be
    // used unchanged so we hit the cached processed image.
    //
    // For plain CDN URLs (no `?tr=`) we still want a cache-bust to avoid stale
    // intermediate responses from prior failures.
    const hasImageKitTransform = /[?&]tr=/.test(nextUrl)
    const isImageKitAiUrl = hasImageKitTransform && /\be-(upscale|retouch|bgremove|genfill|removedotbg|changebg|dropshadow)/.test(nextUrl)

    for (let attempt = 1; attempt <= totalRetries; attempt++) {
        try {
            const requestUrl = isImageKitAiUrl
                ? nextUrl
                : nextUrl.includes('?')
                    ? `${nextUrl}&_t=${Date.now()}`
                    : `${nextUrl}?_t=${Date.now()}`

            console.log('[ImageKit] canvas load attempt', {
                attempt,
                totalRetries,
                requestUrl,
                cacheBusted: !isImageKitAiUrl,
            })
            nextImage = await FabricImage.fromURL(requestUrl, {
                crossOrigin: nextUrl.startsWith('data:') || nextUrl.startsWith('blob:') ? undefined : 'anonymous',
            })
            console.log('[ImageKit] canvas load success', {
                attempt,
                width: nextImage.width,
                height: nextImage.height,
                requestUrl,
            })
            break // Success
        } catch (err) {
            lastError = err
            console.warn(`[ImageKit] Load attempt ${attempt}/${totalRetries} failed:`, err?.message || err)

            if (attempt < totalRetries) {
                // AI transforms genuinely need 10–30s per run; back off longer
                // so the upstream processing has a chance to finish populating
                // the canonical cache key.
                const delay = isImageKitAiUrl ? 6000 : 4000
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

    console.log('[ImageKit] canvas replace complete', {
        nextUrl,
        width: nextImage.width,
        height: nextImage.height,
        scaleX: nextImage.scaleX,
        scaleY: nextImage.scaleY,
        left: nextImage.left,
        top: nextImage.top,
        placement,
    })

    return nextImage
}
