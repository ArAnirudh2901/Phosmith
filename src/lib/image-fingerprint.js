// Stable content hash of an image. We downscale to 32×32 RGBA and hash the raw
// pixel buffer with FNV-1a. Same pixels in → same hash out, regardless of which
// session, browser, or device. Used as the cache key for AI edit plans so that
// "edit the same image multiple times with the same prompt" gives the same result.

const FINGERPRINT_SIZE = 32

const fnv1a = (bytes) => {
    let hash = 0x811c9dc5
    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i]
        // FNV-1a 32-bit prime multiplication (kept in 32-bit by | 0)
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) | 0
    }
    // Convert to unsigned hex
    return (hash >>> 0).toString(16).padStart(8, "0")
}

const getSourceElement = (input) => {
    if (!input) return null
    // Fabric image: prefer the immutable original element (filters don't affect the hash)
    if (input._originalElement) return input._originalElement
    if (typeof input.getElement === "function") return input.getElement()
    if (input._element) return input._element
    // Raw HTMLImageElement / HTMLCanvasElement
    return input
}

export const computeImageFingerprint = (input) => {
    if (typeof document === "undefined") return null
    const source = getSourceElement(input)
    if (!source) return null

    const naturalW = source.naturalWidth || source.videoWidth || source.width || 0
    const naturalH = source.naturalHeight || source.videoHeight || source.height || 0
    if (!naturalW || !naturalH) return null

    const canvas = document.createElement("canvas")
    canvas.width = FINGERPRINT_SIZE
    canvas.height = FINGERPRINT_SIZE
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return null

    try {
        ctx.drawImage(source, 0, 0, FINGERPRINT_SIZE, FINGERPRINT_SIZE)
        const { data } = ctx.getImageData(0, 0, FINGERPRINT_SIZE, FINGERPRINT_SIZE)
        const hash = fnv1a(data)
        return {
            hash: `fnv1a-${FINGERPRINT_SIZE}-${hash}`,
            sourceWidth: naturalW,
            sourceHeight: naturalH,
        }
    } catch (error) {
        // Cross-origin image without CORS will throw on getImageData.
        // The caller should fall back to a uuid-style ID in that case.
        console.warn("[image-fingerprint] hash unavailable:", error?.message || error)
        return null
    }
}

export const normalizePromptKey = (prompt) =>
    String(prompt || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
