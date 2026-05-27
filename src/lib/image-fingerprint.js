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

// ── Perceptual hashing (dHash) ───────────────────────────────────────────
//
// FNV-1a over raw pixels is bit-exact: re-encoding a JPEG at a different
// quality, slight crop, or resize → different hash → cache miss. For
// "slightly different image but visually the same scene" cases we also
// compute a *perceptual* hash. Similar images get similar hashes; lookup
// uses Hamming-distance matching against bucketed prefixes.
//
// Algorithm: dHash (difference hash) — downsample to 9×8 grayscale, then
// emit 64 bits where each bit is 1 iff pixel[r,c] > pixel[r,c+1]. Robust
// to compression, resizing, brightness shifts, and minor crops.

const DHASH_WIDTH = 9
const DHASH_HEIGHT = 8

export const computePerceptualHash = (input) => {
    if (typeof document === "undefined") return null
    const source = input?._originalElement
        || (typeof input?.getElement === "function" ? input.getElement() : null)
        || input?._element
        || input
    if (!source) return null
    const sw = source.naturalWidth || source.width || 0
    const sh = source.naturalHeight || source.height || 0
    if (!sw || !sh) return null

    const canvas = document.createElement("canvas")
    canvas.width = DHASH_WIDTH
    canvas.height = DHASH_HEIGHT
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return null

    try {
        ctx.drawImage(source, 0, 0, DHASH_WIDTH, DHASH_HEIGHT)
        const { data } = ctx.getImageData(0, 0, DHASH_WIDTH, DHASH_HEIGHT)
        // Convert to luminance grid (Rec. 709)
        const gray = new Float32Array(DHASH_WIDTH * DHASH_HEIGHT)
        for (let i = 0; i < DHASH_WIDTH * DHASH_HEIGHT; i++) {
            const r = data[i * 4]
            const g = data[i * 4 + 1]
            const b = data[i * 4 + 2]
            gray[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        // 64-bit hash → 16 hex chars
        let bits = 0n
        let bitIndex = 63n
        for (let row = 0; row < DHASH_HEIGHT; row++) {
            for (let col = 0; col < DHASH_WIDTH - 1; col++) {
                const left = gray[row * DHASH_WIDTH + col]
                const right = gray[row * DHASH_WIDTH + col + 1]
                if (left > right) bits |= 1n << bitIndex
                bitIndex -= 1n
            }
        }
        // Normalize to 16 lowercase hex chars (zero-padded)
        const hex = bits.toString(16).padStart(16, "0").toLowerCase()
        return hex
    } catch (error) {
        console.warn("[image-fingerprint] perceptual hash unavailable:", error?.message || error)
        return null
    }
}

// Hamming distance between two 16-char hex strings (64-bit hashes).
// Returns -1 if either hash is invalid; otherwise the number of differing bits (0..64).
export const hammingDistance = (a, b) => {
    if (!a || !b || a.length !== 16 || b.length !== 16) return -1
    try {
        const x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
        // popcount via SWAR
        let n = x
        let count = 0
        while (n !== 0n) {
            n &= n - 1n
            count++
        }
        return count
    } catch {
        return -1
    }
}

// Threshold for "this is the same image content". 8 bits differ ≈ 12.5% of
// the perceptual hash — typical for JPEG quality 80 vs 100 of the same source.
// Higher numbers risk false positives (different photos with similar comp).
export const PHASH_MATCH_THRESHOLD = 8

// Produce a small JPEG data URL of an image — used to send layer previews to
// Gemini for multi-image targeting. 256px keeps the upload tiny (~10-15 KB
// after base64) while still letting the model recognize content.
export const computeLayerThumbnail = (input, maxDim = 256) => {
    if (typeof document === "undefined") return null
    const source = input?._originalElement || (typeof input?.getElement === "function" ? input.getElement() : null) || input?._element || input
    if (!source) return null
    const w = source.naturalWidth || source.width || 0
    const h = source.naturalHeight || source.height || 0
    if (!w || !h) return null
    const scale = Math.min(1, maxDim / Math.max(w, h))
    const outW = Math.max(1, Math.round(w * scale))
    const outH = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement("canvas")
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return null
    try {
        ctx.drawImage(source, 0, 0, outW, outH)
        // Strip the "data:image/jpeg;base64," prefix so the server can hand the
        // base64 directly to Gemini's inlineData payload.
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7)
        const commaIdx = dataUrl.indexOf(",")
        if (commaIdx < 0) return null
        return {
            mime: "image/jpeg",
            base64: dataUrl.slice(commaIdx + 1),
            width: outW,
            height: outH,
        }
    } catch (error) {
        console.warn("[image-fingerprint] thumbnail failed:", error?.message || error)
        return null
    }
}
