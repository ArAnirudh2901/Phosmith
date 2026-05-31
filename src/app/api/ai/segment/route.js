import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import sharp from 'sharp'
import { enforceRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export const maxDuration = 120
export const runtime = 'nodejs'

const MAX_INPUT_BYTES = 24 * 1024 * 1024
const MAX_MODEL_SIDE = 1024

const HF_ENDPOINTS = [
  'https://router.huggingface.co/hf-inference/models',
  'https://api-inference.huggingface.co/models',
]

/**
 * Background removal models — return a PNG with the subject preserved on a
 * transparent background. These produce pixel-accurate masks with clean edges,
 * far superior to semantic segmentation for "Select Subject".
 */
const BG_REMOVAL_MODELS = [
  'briaai/RMBG-1.4',
  'schirrmacher/lraspp_mobilenet_v3_large',
]

/**
 * Fallback segmentation models (return JSON with per-category masks).
 * segformer → 150 ADE20K categories (wall, sky, person, tree…)
 * detr-panoptic → 133 COCO categories (LABEL_N format)
 */
const SEGMENTATION_MODELS = [
  'nvidia/segformer-b0-finetuned-ade-512-512',
  'facebook/detr-resnet-50-panoptic',
]

const fileToBuffer = async (file, label) => {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error(`${label} is required`)
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(`${label} is too large (max ${MAX_INPUT_BYTES / 1024 / 1024}MB)`)
  }
  return Buffer.from(await file.arrayBuffer())
}

const prepareImage = async (inputBuffer) => {
  const meta = await sharp(inputBuffer, { failOn: 'none' }).metadata()
  const origW = meta.width || 512
  const origH = meta.height || 512
  const scale = Math.min(1, MAX_MODEL_SIDE / Math.max(origW, origH))
  const w = Math.round(origW * scale)
  const h = Math.round(origH * scale)

  const buffer = await sharp(inputBuffer, { failOn: 'none' })
    .resize(w, h, { fit: 'fill' })
    .removeAlpha()
    .jpeg({ quality: 85 })
    .toBuffer()

  return { buffer, width: w, height: h, origWidth: origW, origHeight: origH }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * EDGE REFINEMENT PIPELINE
 *
 * Turns a raw model mask (at model resolution) into a clean, anti-aliased
 * mask at the original image resolution. Steps:
 *   1. Median(3)   — removes isolated noise pixels, preserves edges
 *   2. Lanczos3    — smooth upscale (replaces blocky nearest-neighbor)
 *   3. Blur(1.2)   — anti-aliases the transition zone
 *   4. Threshold    — re-binarises to a clean black/white mask
 * ═══════════════════════════════════════════════════════════════════════════ */
const refineMaskEdges = async (greyBuffer, modelW, modelH, origW, origH) => {
  // greyBuffer can be:
  //   • a raw 1-channel pixel buffer (from alpha extraction)
  //   • a PNG/JPEG buffer (from segmentation compositing)
  // We normalise to greyscale first, then refine.

  let pipeline

  // Detect if this is a raw pixel buffer (exactly w*h bytes) or an encoded image
  if (greyBuffer.length === modelW * modelH) {
    pipeline = sharp(greyBuffer, { raw: { width: modelW, height: modelH, channels: 1 } })
  } else {
    pipeline = sharp(greyBuffer, { failOn: 'none' }).greyscale()
  }

  return pipeline
    .median(3)                    // 3×3 median filter: remove noise, preserve edges
    .resize(origW, origH, {
      fit: 'fill',
      kernel: 'lanczos3',        // smooth interpolation (not blocky nearest-neighbor)
    })
    .blur(1.2)                   // slight Gaussian blur for anti-aliased edge transitions
    .threshold(128)              // re-binarise to clean black/white mask
    .png()
    .toBuffer()
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PRIMARY: BACKGROUND REMOVAL (RMBG)
 *
 * These models return a PNG image with the subject opaque and background
 * transparent. The alpha channel IS our subject mask.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Send image to a background-removal model. Returns the result PNG buffer,
 * or null if all models fail.
 */
const callBackgroundRemoval = async (imageBuffer) => {
  const token = process.env.HUGGINGFACE_API_TOKEN?.trim()
  if (!token) return null

  for (const model of BG_REMOVAL_MODELS) {
    for (const baseUrl of HF_ENDPOINTS) {
      const endpoint = `${baseUrl}/${model}`
      try {
        console.info('[ai-segment] trying bg-removal:', endpoint)
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
          },
          body: imageBuffer,
          signal: AbortSignal.timeout(90_000),
        })

        // Model loading — wait and retry once
        if (response.status === 503) {
          const body = await response.json().catch(() => ({}))
          const wait = Math.min(body.estimated_time || 20, 30)
          console.info(`[ai-segment] bg-removal model loading, waiting ${wait}s…`)
          await new Promise(r => setTimeout(r, wait * 1000))
          const retry = await fetch(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/octet-stream',
            },
            body: imageBuffer,
            signal: AbortSignal.timeout(90_000),
          })
          if (retry.ok) {
            const ct = retry.headers.get('content-type') || ''
            if (ct.includes('image')) {
              const buf = Buffer.from(await retry.arrayBuffer())
              console.info('[ai-segment] ✓ bg-removal from', model, '→', buf.length, 'bytes')
              return { buffer: buf, model }
            }
          }
          continue
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '')
          console.warn('[ai-segment] bg-removal HTTP', response.status, text.slice(0, 200))
          continue
        }

        const ct = response.headers.get('content-type') || ''
        if (ct.includes('image')) {
          const buf = Buffer.from(await response.arrayBuffer())
          console.info('[ai-segment] ✓ bg-removal from', model, '→', buf.length, 'bytes')
          return { buffer: buf, model }
        }

        // Some models return JSON with a mask — fall through to segmentation
        console.warn('[ai-segment] bg-removal returned non-image:', ct.slice(0, 80))
        continue
      } catch (error) {
        console.warn('[ai-segment] bg-removal failed:', model, error?.message)
        continue
      }
    }
  }

  return null
}

/**
 * Extract the alpha channel from a background-removed PNG as a subject mask.
 * Alpha 255 = subject (keep → white), Alpha 0 = background (erase → black).
 */
const buildMaskFromAlpha = async (pngBuffer, modelW, modelH, origW, origH) => {
  // Decode to raw RGBA at model resolution
  const { data } = await sharp(pngBuffer, { failOn: 'none' })
    .resize(modelW, modelH, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // Extract alpha channel as a 1-channel greyscale buffer
  const alphaBuffer = Buffer.alloc(modelW * modelH)
  for (let i = 0; i < modelW * modelH; i++) {
    alphaBuffer[i] = data[i * 4 + 3]
  }

  // Run through the edge refinement pipeline
  return refineMaskEdges(alphaBuffer, modelW, modelH, origW, origH)
}

/* ═══════════════════════════════════════════════════════════════════════════
 * FALLBACK: SEMANTIC SEGMENTATION (Segformer / DETR)
 *
 * Returns JSON with per-category masks. We composite subject segments and
 * run through the same edge refinement pipeline.
 * ═══════════════════════════════════════════════════════════════════════════ */

const callSegmentation = async (imageBuffer) => {
  const token = process.env.HUGGINGFACE_API_TOKEN?.trim()
  if (!token) {
    throw new Error('HUGGINGFACE_API_TOKEN is not configured')
  }

  let lastError = null

  for (const model of SEGMENTATION_MODELS) {
    for (const baseUrl of HF_ENDPOINTS) {
      const endpoint = `${baseUrl}/${model}`
      try {
        console.info('[ai-segment] trying segmentation:', endpoint)
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            Accept: 'application/json',
          },
          body: imageBuffer,
          signal: AbortSignal.timeout(90_000),
        })

        if (response.status === 503) {
          const body = await response.json().catch(() => ({}))
          const wait = Math.min(body.estimated_time || 20, 30)
          console.info(`[ai-segment] model loading, waiting ${wait}s…`)
          await new Promise(r => setTimeout(r, wait * 1000))
          const retry = await fetch(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/octet-stream',
              Accept: 'application/json',
            },
            body: imageBuffer,
            signal: AbortSignal.timeout(90_000),
          })
          if (retry.ok) {
            const result = await retry.json()
            if (Array.isArray(result) && result.length > 0) return result
          }
          continue
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '')
          console.warn('[ai-segment] HTTP', response.status, text.slice(0, 200))
          lastError = new Error(`HTTP ${response.status}`)
          continue
        }

        const result = await response.json()
        if (Array.isArray(result) && result.length > 0) {
          console.info('[ai-segment] got', result.length, 'segments from', model)
          result.forEach((s, i) =>
            console.info(`  [${i}] ${s.label} (${(s.score * 100).toFixed(0)}%) mask:${s.mask?.length || 0}b`))
          return result
        }

        console.warn('[ai-segment] empty result from', model)
        continue
      } catch (error) {
        console.warn('[ai-segment] failed:', endpoint, error?.message)
        lastError = error
        continue
      }
    }
  }

  throw lastError || new Error('All segmentation models failed')
}

/**
 * Background / "stuff" labels — EXCLUDED from the subject mask.
 */
const BACKGROUND_LABELS = new Set([
  // ADE20K stuff
  'wall', 'building', 'sky', 'floor', 'tree', 'ceiling', 'road',
  'grass', 'sidewalk', 'earth', 'mountain', 'plant', 'water', 'sea',
  'field', 'fence', 'sand', 'path', 'river', 'bridge', 'flower',
  'house', 'rock', 'hill', 'dirt', 'snow', 'stairway', 'runway',
  'swimming pool', 'lake', 'waterfall', 'land', 'curtain', 'pillow',
  'towel', 'rug', 'carpet', 'blanket', 'column', 'signboard',
  'streetlight', 'booth', 'stage', 'railing', 'escalator',
  'fountain', 'pool', 'screen', 'step', 'pier',
  // COCO panoptic stuff
  'sky-other', 'grass-merged', 'pavement', 'pavement-merged',
  'ground-other', 'wall-brick', 'wall-stone', 'wall-tile',
  'wall-wood', 'wall-other', 'wall-concrete', 'wall-panel',
  'floor-other', 'roof', 'door-stuff', 'window-blind', 'window-other',
  'fence-merged', 'railing-merged', 'tree-merged', 'bush',
  'building-other', 'tent', 'textile', 'structural',
])

const decodeMaskBuffer = (mask) => {
  if (!mask) return null
  if (typeof mask === 'string') {
    const base64 = mask.includes(',') ? mask.split(',').pop() : mask
    try { return Buffer.from(base64, 'base64') } catch { return null }
  }
  if (Buffer.isBuffer(mask)) return mask
  return null
}

/**
 * Decode a single segment mask PNG into an RGBA buffer at the target size.
 */
const processSegmentMask = async (maskBuf, width, height) => {
  return sharp(maskBuf, { failOn: 'none' })
    .resize(width, height, { fit: 'fill', kernel: 'nearest' })
    .ensureAlpha()
    .toColourspace('srgb')
    .png()
    .toBuffer()
}

/**
 * Build a subject mask from segmentation results, then run it through
 * the edge refinement pipeline.
 */
const buildSubjectMask = async (segments, width, height, origWidth, origHeight) => {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('No segments detected. Try a different image with a clearer subject.')
  }

  // Strategy 1: Exclude known background labels, composite the rest
  const subjectSegs = segments.filter(seg => {
    const label = (seg.label || '').toLowerCase()
    return !BACKGROUND_LABELS.has(label) && decodeMaskBuffer(seg.mask) !== null
  })

  // Strategy 2: If all segments are "background" or LABEL_N format,
  // use the LARGEST segment as background and invert
  const useInversion = subjectSegs.length === 0 || (
    subjectSegs.length === segments.length && segments.every(s => /^LABEL_/i.test(s.label || ''))
  )

  if (useInversion && segments.length > 0) {
    console.info('[ai-segment] using inversion strategy (largest seg = background)')
    let largestSeg = null
    let largestSize = 0

    for (const seg of segments) {
      const buf = decodeMaskBuffer(seg.mask)
      if (buf && buf.length > largestSize) {
        largestSize = buf.length
        largestSeg = seg
      }
    }

    if (largestSeg) {
      const buf = decodeMaskBuffer(largestSeg.mask)
      const processed = await processSegmentMask(buf, width, height)

      // White canvas + background overlay → negate = subject=white, bg=black
      const rawMask = await sharp({
        create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
      })
        .composite([{ input: processed, blend: 'over' }])
        .negate()
        .greyscale()
        .raw()
        .toBuffer()

      // Apply edge refinement pipeline (replaces old nearest-neighbor upscale)
      return refineMaskEdges(rawMask, width, height, origWidth, origHeight)
    }
  }

  // Normal path: composite subject segments onto a black canvas
  console.info('[ai-segment] using label-based strategy, subject segments:', subjectSegs.length)
  const composites = []

  for (const seg of (subjectSegs.length > 0 ? subjectSegs : segments)) {
    const buf = decodeMaskBuffer(seg.mask)
    if (!buf) continue
    try {
      const processed = await processSegmentMask(buf, width, height)
      composites.push({ input: processed, blend: 'over' })
    } catch (err) {
      console.warn('[ai-segment] mask decode failed for:', seg.label, err?.message)
    }
  }

  if (composites.length === 0) {
    throw new Error('Could not process segment masks. Try a different image.')
  }

  const rawMask = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .composite(composites)
    .greyscale()
    .raw()
    .toBuffer()

  // Apply edge refinement pipeline (replaces old nearest-neighbor upscale)
  return refineMaskEdges(rawMask, width, height, origWidth, origHeight)
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ROUTE HANDLER
 * ═══════════════════════════════════════════════════════════════════════════ */

export async function POST(request) {
  try {
    const { userId } = await auth()
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limited = rateLimitResponse(await enforceRateLimit('ai-segment', userId))
    if (limited) return limited

    const formData = await request.formData()
    const imageBuffer = await fileToBuffer(formData.get('image'), 'image')

    const prepared = await prepareImage(imageBuffer)
    console.info('[ai-segment] image:', prepared.width, 'x', prepared.height,
      '→ orig:', prepared.origWidth, 'x', prepared.origHeight)

    let maskBuffer = null

    // ── 1. Try background removal (RMBG) — pixel-accurate alpha masks ──
    const bgResult = await callBackgroundRemoval(prepared.buffer)
    if (bgResult) {
      console.info('[ai-segment] building mask from', bgResult.model, 'alpha channel')
      try {
        maskBuffer = await buildMaskFromAlpha(
          bgResult.buffer,
          prepared.width,
          prepared.height,
          prepared.origWidth,
          prepared.origHeight,
        )
      } catch (err) {
        console.warn('[ai-segment] alpha extraction failed, falling back:', err?.message)
      }
    }

    // ── 2. Fallback: semantic segmentation (segformer / detr) ──
    if (!maskBuffer) {
      console.info('[ai-segment] falling back to semantic segmentation')
      const segments = await callSegmentation(prepared.buffer)
      maskBuffer = await buildSubjectMask(
        segments,
        prepared.width,
        prepared.height,
        prepared.origWidth,
        prepared.origHeight,
      )
    }

    console.info('[ai-segment] ✓ mask:', maskBuffer.length, 'bytes')

    return new NextResponse(maskBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    console.error('[ai-segment] ✗', error?.message)
    return NextResponse.json(
      { error: error?.message || 'Segmentation failed' },
      { status: /not configured/i.test(error?.message || '') ? 501 : 500 }
    )
  }
}
