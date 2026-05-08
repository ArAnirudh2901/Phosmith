export const isImageKitUrl = (url) => typeof url === 'string' && url.includes('ik.imagekit.io')

export const normalizeImageKitUrl = (url) => url?.split('?')[0] ?? ''

export const encodeImageKitPrompt = (prompt) => encodeURIComponent((prompt || '').trim())

export const buildImageKitTransformUrl = (sourceUrl, transformations) => {
    const baseUrl = normalizeImageKitUrl(sourceUrl)
    const chain = transformations.filter(Boolean).join(',')

    if (!baseUrl || !chain) return baseUrl || ''

    return `${baseUrl}?tr=${chain}`
}

export const buildGenerativeFillUrl = ({ sourceUrl, prompt, width, height }) => {
    const promptSegment = prompt?.trim()
        ? `bg-genfill-prompt-${encodeImageKitPrompt(prompt)}`
        : 'bg-genfill'

    return buildImageKitTransformUrl(sourceUrl, [
        promptSegment,
        `w-${Math.max(1, Math.round(width))}`,
        `h-${Math.max(1, Math.round(height))}`,
        'cm-pad_resize',
    ])
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
    { preserveDisplayedBounds = true, placement = 'fit' } = {}
) => {
    if (!canvasEditor || !sourceImage || !nextUrl) return null

    const { FabricImage } = await import('fabric')
    const nextImage = await FabricImage.fromURL(nextUrl, {
        crossOrigin: nextUrl.startsWith('data:') || nextUrl.startsWith('blob:') ? undefined : 'anonymous',
    })

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
