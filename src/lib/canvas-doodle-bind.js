import { Point, util } from 'fabric'

/* ═══════════════════════════════════════════════════════════════════════════
 * DOODLE ↔ IMAGE BINDING
 *
 * Strokes drawn with the Draw tool are plain Fabric Path objects living as
 * siblings of the image on the canvas. On their own they'd move/scale
 * independently of the photo underneath — but a doodle drawn *on* a photo
 * should behave as part of it: drag the photo and the scribble goes with it,
 * resize the photo and the scribble resizes too.
 *
 * Rather than grouping (which would break the Resize/Mask/Erase tools that
 * locate the image by type, plus the layer model + serialization), we keep the
 * paths independent but make them FOLLOW the image's transform via Fabric's
 * standard parent→child matrix recipe:
 *
 *   relationship = inv(parentMatrix) · childMatrix          (snapshot, "bind")
 *   childMatrix' = parentMatrix' · relationship             (replay,  "follow")
 *
 * Association is geometric — a path whose centre sits over an image is "drawn
 * on" it (topmost image wins when several overlap). That means the link is
 * recomputed from live positions every time a transform starts, so it needs no
 * persisted state and survives save/reload for free: on reload the paths are at
 * their saved absolute coords (already correct relative to the saved image),
 * and the next drag re-binds by geometry.
 * ═══════════════════════════════════════════════════════════════════════════ */

const isImage = (obj) => obj?.type?.toLowerCase() === 'image'

const isPath = (obj) => {
    const type = obj?.type?.toLowerCase()
    return type === 'path' || type === 'pathgroup'
}

const rectContains = (rect, point) =>
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height

/**
 * Path objects considered "drawn on" `image`: their centre lies within the
 * image's current bounding rect AND `image` is the topmost image under that
 * centre (so a doodle on the front photo doesn't also bind to one behind it).
 */
export const getDoodlesForImage = (canvas, image) => {
    if (!canvas || !image) return []
    const objects = canvas.getObjects?.() || []
    const images = objects.filter(isImage)

    return objects.filter((obj) => {
        if (!isPath(obj)) return false
        const center = obj.getCenterPoint()
        const topImageUnder = images
            .filter((im) => rectContains(im.getBoundingRect(), center))
            .sort((a, b) => objects.indexOf(b) - objects.indexOf(a))[0]
        return topImageUnder === image
    })
}

/**
 * Snapshot the transform of every doodle currently on `image`, relative to the
 * image. Call this at the START of a move/scale/rotate (before the image
 * transform changes), then call followDoodles after each change.
 */
export const bindDoodlesToImage = (canvas, image) => {
    if (!canvas || !image) return []
    const doodles = getDoodlesForImage(canvas, image)
    const inverseParent = util.invertTransform(image.calcTransformMatrix())
    doodles.forEach((path) => {
        path.__doodleRel = util.multiplyTransformMatrices(
            inverseParent,
            path.calcTransformMatrix(),
        )
    })
    image.__boundDoodles = doodles
    return doodles
}

/**
 * Re-apply each bound doodle's transform from the image's CURRENT matrix, so
 * the strokes track the photo through translation, scaling and rotation.
 */
export const followDoodles = (canvas, image) => {
    const doodles = image?.__boundDoodles
    if (!doodles?.length) return
    const parentMatrix = image.calcTransformMatrix()
    doodles.forEach((path) => {
        if (!path.__doodleRel) return
        const next = util.multiplyTransformMatrices(parentMatrix, path.__doodleRel)
        const decomposed = util.qrDecompose(next)
        path.set({ flipX: false, flipY: false })
        path.setPositionByOrigin(
            new Point(decomposed.translateX, decomposed.translateY),
            'center',
            'center',
        )
        path.set({
            angle: decomposed.angle,
            scaleX: decomposed.scaleX,
            scaleY: decomposed.scaleY,
            skewX: decomposed.skewX,
            skewY: decomposed.skewY,
        })
        path.setCoords()
    })
}
