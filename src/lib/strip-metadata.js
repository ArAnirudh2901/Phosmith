/**
 * strip-metadata.js
 *
 * Binary-level metadata stripping for images.
 * Removes EXIF, XMP, IPTC, GPS, camera info, comments, embedded thumbnails
 * — everything except the raw pixel data and the headers needed to decode it.
 *
 * No re-encoding, no quality loss, no external libraries.
 */

// ─── JPEG ────────────────────────────────────────────────────────────────────

/**
 * Strip all non-essential metadata from a JPEG ArrayBuffer.
 *
 * Keeps:  SOI, APP0 (JFIF), DQT, SOF, DHT, DRI, SOS + scan data, EOI
 * Strips: APP1 (EXIF / XMP), APP2-APP15 (ICC, Photoshop, IPTC …), COM
 */
const stripJpeg = (buffer) => {
    const view = new DataView(buffer)

    // Must start with SOI (0xFFD8)
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return buffer

    const chunks = []
    chunks.push(new Uint8Array(buffer, 0, 2))          // SOI
    let offset = 2

    while (offset + 1 < view.byteLength) {
        // Every marker starts with 0xFF
        if (view.getUint8(offset) !== 0xff) break

        const marker = view.getUint8(offset + 1)

        // Padding bytes (0xFF followed by 0xFF)
        if (marker === 0xff) { offset++; continue }

        // SOS (Start of Scan) — everything from here to EOI is image data
        if (marker === 0xda) {
            chunks.push(new Uint8Array(buffer, offset))
            break
        }

        // Stand-alone markers (no length field): RST0-7, SOI, EOI, TEM
        if (
            marker === 0xd8 || marker === 0xd9 ||
            (marker >= 0xd0 && marker <= 0xd7) ||
            marker === 0x01
        ) {
            chunks.push(new Uint8Array(buffer, offset, 2))
            offset += 2
            continue
        }

        // All other markers have a 2-byte big-endian length right after
        if (offset + 3 >= view.byteLength) break
        const segLen = view.getUint16(offset + 2)      // includes the 2 length bytes
        const totalSegSize = 2 + segLen                 // marker (2) + length-field-inclusive payload

        // Decide: keep or strip?
        //   APP0        (0xE0)      → keep   (JFIF — decoders may expect it)
        //   APP1        (0xE1)      → STRIP  (EXIF / XMP — biggest metadata payload)
        //   APP2        (0xE2)      → keep   (ICC colour profile — needed for correct
        //                                     rendering; some services/decoders fail without it)
        //   APP3–APP15  (0xE3–0xEF) → STRIP  (Photoshop, IPTC, misc)
        //   COM         (0xFE)      → STRIP  (comments)
        //   Everything else         → keep   (DQT, SOF, DHT, DRI, …)
        const isStrippable =
            marker === 0xe1 ||                           // APP1 (EXIF / XMP)
            (marker >= 0xe3 && marker <= 0xef) ||        // APP3–APP15
            marker === 0xfe                              // COM

        if (!isStrippable) {
            chunks.push(new Uint8Array(buffer, offset, totalSegSize))
        }

        offset += totalSegSize
    }

    // Reassemble
    const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0)
    const result = new Uint8Array(totalSize)
    let pos = 0
    for (const chunk of chunks) {
        result.set(chunk, pos)
        pos += chunk.byteLength
    }
    return result.buffer
}

// ─── PNG ─────────────────────────────────────────────────────────────────────

/**
 * Strip all non-essential chunks from a PNG ArrayBuffer.
 *
 * Keeps:  Signature, IHDR, PLTE, tRNS, IDAT, IEND, gAMA, cHRM, sRGB, iCCP,
 *         sBIT, pHYs  (needed for correct decoding / colour / DPI)
 * Strips: tEXt, zTXt, iTXt, eXIf, tIME, and any other ancillary chunks
 */
const ESSENTIAL_PNG_CHUNKS = new Set([
    "IHDR", "PLTE", "tRNS", "IDAT", "IEND",
    "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "pHYs",
])

const stripPng = (buffer) => {
    const view = new DataView(buffer)

    // PNG signature: 8 bytes
    if (view.byteLength < 8 || view.getUint32(0) !== 0x89504e47) return buffer

    const chunks = []
    chunks.push(new Uint8Array(buffer, 0, 8))          // signature
    let offset = 8

    while (offset + 12 <= view.byteLength) {           // min chunk = 4 len + 4 type + 4 crc
        const dataLen = view.getUint32(offset)
        const typeBytes = new Uint8Array(buffer, offset + 4, 4)
        const type = String.fromCharCode(...typeBytes)
        const chunkTotalLen = 12 + dataLen              // length(4) + type(4) + data + CRC(4)

        if (offset + chunkTotalLen > view.byteLength) break

        if (ESSENTIAL_PNG_CHUNKS.has(type)) {
            chunks.push(new Uint8Array(buffer, offset, chunkTotalLen))
        }

        offset += chunkTotalLen
    }

    const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0)
    const result = new Uint8Array(totalSize)
    let pos = 0
    for (const chunk of chunks) {
        result.set(chunk, pos)
        pos += chunk.byteLength
    }
    return result.buffer
}

// ─── WebP ─────────────────────────────────────────────────────────────────────

/**
 * Strip EXIF and XMP metadata from a WebP ArrayBuffer.
 *
 * WebP is a RIFF container. Simple files (just a VP8 or VP8L chunk) never
 * carry metadata. Extended files (VP8X) may carry EXIF and/or XMP chunks;
 * we remove those and clear the corresponding bits in the VP8X flags word.
 *
 * Keeps:  RIFF header, VP8X (flags updated), VP8 / VP8L, ANIM, ANMF, ALPH,
 *         ICCP (needed for colour-accurate display)
 * Strips: EXIF, XMP
 */
const stripWebp = (buffer) => {
    const view = new DataView(buffer)

    // RIFF/WEBP header: "RIFF" (4) + fileSize (4, LE) + "WEBP" (4) = 12 bytes
    if (view.byteLength < 12) return buffer
    if (view.getUint32(0, false) !== 0x52494646) return buffer  // 'RIFF'
    if (view.getUint32(8, false) !== 0x57454250) return buffer  // 'WEBP'

    // First chunk starts at offset 12
    if (view.byteLength < 16) return buffer
    const firstFourCC = String.fromCharCode(
        view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15),
    )

    // Simple WebP (VP8 lossy or VP8L lossless): no extension chunks, nothing to strip
    if (firstFourCC === 'VP8 ' || firstFourCC === 'VP8L') return buffer

    // Extended WebP must start with a VP8X chunk
    if (firstFourCC !== 'VP8X') return buffer

    // VP8X chunk layout:
    //   offset 12: FourCC "VP8X" (4)
    //   offset 16: chunk size (4, LE) — must be 10
    //   offset 20: flags byte — bit1=ICC, bit2=ALPH, bit3=EXIF, bit4=XMP, bit5=ANIM
    //   offset 21: reserved (3)
    //   offset 24: canvas width  - 1 (3, LE 24-bit)
    //   offset 27: canvas height - 1 (3, LE 24-bit)
    if (view.byteLength < 30) return buffer
    const vp8xDataSize = view.getUint32(16, true)
    if (vp8xDataSize < 10) return buffer

    const flagsOffset = 20
    const flags = view.getUint8(flagsOffset)
    const hasExif = (flags >> 3) & 1
    const hasXmp  = (flags >> 4) & 1
    if (!hasExif && !hasXmp) return buffer  // nothing to strip

    // Walk all RIFF chunks and rebuild without EXIF / XMP
    const VP8X_CHUNK_TOTAL = 8 + vp8xDataSize + (vp8xDataSize & 1)   // FourCC+size+data+padding

    const chunks = []
    chunks.push(new Uint8Array(buffer, 0, 12))                        // RIFF/WEBP header

    // VP8X with EXIF and XMP flags cleared
    const vp8xCopy = new Uint8Array(new Uint8Array(buffer, 12, VP8X_CHUNK_TOTAL))
    vp8xCopy[8] = flags & ~(1 << 3) & ~(1 << 4)                      // clear EXIF+XMP bits
    chunks.push(vp8xCopy)

    let offset = 12 + VP8X_CHUNK_TOTAL
    while (offset + 8 <= view.byteLength) {
        const fourCC = String.fromCharCode(
            view.getUint8(offset),     view.getUint8(offset + 1),
            view.getUint8(offset + 2), view.getUint8(offset + 3),
        )
        const dataSize      = view.getUint32(offset + 4, true)
        const chunkTotal    = 8 + dataSize + (dataSize & 1)            // includes optional padding byte
        const actualEnd     = Math.min(offset + chunkTotal, view.byteLength)

        if (fourCC !== 'EXIF' && fourCC !== 'XMP ') {
            chunks.push(new Uint8Array(buffer, offset, actualEnd - offset))
        }

        offset += chunkTotal
        if (chunkTotal === 0) break                                    // guard against malformed input
    }

    // Reassemble and update RIFF file-size field
    const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0)
    const result = new Uint8Array(totalSize)
    let pos = 0
    for (const chunk of chunks) { result.set(chunk, pos); pos += chunk.byteLength }

    // Bytes 4-7 (LE) = total file size minus the first 8 bytes of the RIFF header
    new DataView(result.buffer).setUint32(4, totalSize - 8, true)

    return result.buffer
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Strip metadata from an image File.
 *
 * Returns a new File with the same name / MIME type but all non-essential
 * metadata removed.  AVIF and other unknown formats are returned unchanged.
 * No re-encoding ever happens — this is pure binary editing.
 *
 * @param {File} file
 * @returns {Promise<File>}
 */
export async function stripImageMetadata(file) {
    if (!file?.size) return file

    const buffer = await file.arrayBuffer()
    let stripped

    const type = (file.type || "").toLowerCase()
    if (type === "image/jpeg" || type === "image/jpg") {
        stripped = stripJpeg(buffer)
    } else if (type === "image/png") {
        stripped = stripPng(buffer)
    } else if (type === "image/webp") {
        stripped = stripWebp(buffer)
    } else {
        // AVIF / others — pass through untouched
        return file
    }

    // Only create a new File if we actually shrank anything
    if (stripped.byteLength >= buffer.byteLength) return file

    // Safety: validate the stripped output still looks like a valid image.
    // If the parser produced garbage, fall back to the untouched original so
    // we never upload a corrupted file.
    if (!isValidStrippedImage(stripped, type)) {
        console.warn("[strip-metadata] Stripped output failed validation — using original file")
        return file
    }

    return new File([stripped], file.name, {
        type: file.type,
        lastModified: file.lastModified,
    })
}

/**
 * Quick structural sanity check on the stripped output.
 */
function isValidStrippedImage(buffer, type) {
    if (!buffer || buffer.byteLength < 8) return false
    const view = new DataView(buffer)

    if (type === "image/jpeg" || type === "image/jpg") {
        // Must start with SOI (0xFFD8)
        if (view.getUint16(0) !== 0xffd8) return false
        // Must end with EOI (0xFFD9)
        if (buffer.byteLength < 2) return false
        const lastTwo = new Uint8Array(buffer, buffer.byteLength - 2, 2)
        if (lastTwo[0] !== 0xff || lastTwo[1] !== 0xd9) return false
        // Must contain at least an SOS marker somewhere (otherwise no image data)
        const bytes = new Uint8Array(buffer)
        let hasSOS = false
        for (let i = 0; i < bytes.length - 1; i++) {
            if (bytes[i] === 0xff && bytes[i + 1] === 0xda) { hasSOS = true; break }
        }
        return hasSOS
    }

    if (type === "image/png") {
        // Must start with PNG signature
        return view.getUint32(0) === 0x89504e47
    }

    if (type === "image/webp") {
        // RIFF + WEBP signature
        if (buffer.byteLength < 12) return false
        return view.getUint32(0, false) === 0x52494646 &&   // 'RIFF'
               view.getUint32(8, false) === 0x57454250      // 'WEBP'
    }

    return true
}
