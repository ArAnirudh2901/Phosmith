import { auth } from '@clerk/nextjs/server'
import ImageKit from 'imagekit'
import { NextResponse } from 'next/server'
import sharp from 'sharp'
import {
  buildExtensionPrompt,
  validateExpansion,
} from '@/lib/expansion-pipeline'
import {
  isImageKitUrl,
  normalizeImageKitUrl,
  buildSequentialGenfillUrl,
} from '@/lib/imagekit-ai'

export const maxDuration = 120
export const runtime = 'nodejs'

const MIN_DIM = 64
const MAX_DIM = 4096
const MAX_SOURCE_UPLOAD_BYTES = 24 * 1024 * 1024
const GENFILL_READY_TIMEOUT_MS = 110 * 1000  // use most of the 120s maxDuration
const GENFILL_POLL_DELAY_MS = 5 * 1000       // check every 5s for faster detection

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))


const getImageKitClient = () => {
  const endpoint = process.env.NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT?.trim()?.replace(/\/+$/, '')
  const publicKey = process.env.NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY

  if (!privateKey || !publicKey || !endpoint) return null

  return new ImageKit({ publicKey, privateKey, urlEndpoint: endpoint })
}

const getExtension = (contentType = '') => {
  if (contentType.includes('webp')) return 'webp'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg'
  return 'png'
}

const uploadBufferToImageKit = async (client, buffer, fileName, folder) => {
  const uploadResponse = await client.upload({
    file: buffer.toString('base64'),
    fileName,
    folder,
    useUniqueFileName: true,
    isBase64: true,
  })

  return uploadResponse.url
}

const fetchSourceImageBuffer = async (sourceUrl) => {
  const response = await fetch(sourceUrl, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Failed to fetch source image (${response.status})`)
  }

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.startsWith('image/')) {
    throw new Error('Source URL did not return an image')
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType,
  }
}

const uploadSourceImage = async (client, sourceUrl) => {
  const { buffer, contentType } = await fetchSourceImageBuffer(sourceUrl)
  const extension = getExtension(contentType)
  return uploadBufferToImageKit(
    client,
    buffer,
    `extend-source-${Date.now()}.${extension}`,
    '/yt-projects/ai-extend/source'
  )
}

const readSourceFile = async (file) => {
  if (!file || typeof file.arrayBuffer !== 'function') return null

  const contentType = file.type || 'image/png'
  if (!contentType.startsWith('image/')) {
    throw new Error('Uploaded source must be an image')
  }

  if (file.size > MAX_SOURCE_UPLOAD_BYTES) {
    throw new Error('Edited source image is too large to extend. Try a smaller export.')
  }

  return {
    buffer: Buffer.from(await file.arrayBuffer()),
    contentType,
  }
}

const getCompositePlacement = (expansion) => ({
  left: Math.max(0, Math.round(expansion?.offsetX ?? expansion?.insets?.left ?? 0)),
  top: Math.max(0, Math.round(expansion?.offsetY ?? expansion?.insets?.top ?? 0)),
})

const createTransparentCompositeBuffer = async (sourceBuffer, expansion, width, height) => {
  const sourceWidth = Math.max(1, Math.round(expansion?.sourceWidth || width))
  const sourceHeight = Math.max(1, Math.round(expansion?.sourceHeight || height))
  const { left, top } = getCompositePlacement(expansion)

  const normalizedSource = await sharp(sourceBuffer, { failOn: 'none' })
    .rotate()
    .resize(sourceWidth, sourceHeight, { fit: 'fill' })
    .webp({ quality: 96, alphaQuality: 100, effort: 4 })
    .toBuffer()

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: normalizedSource, left, top }])
    .webp({ quality: 96, alphaQuality: 100, effort: 4 })
    .toBuffer()
}

const createSoftExtendFallbackBuffer = async (sourceBuffer, expansion, width, height) => {
  const sourceWidth = Math.max(1, Math.round(expansion?.sourceWidth || width))
  const sourceHeight = Math.max(1, Math.round(expansion?.sourceHeight || height))
  const { left, top } = getCompositePlacement(expansion)

  const softBackground = await sharp(sourceBuffer, { failOn: 'none' })
    .rotate()
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .blur(Math.max(22, Math.round(Math.min(width, height) / 70)))
    .modulate({ brightness: 0.96, saturation: 0.9 })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer()

  const normalizedSource = await sharp(sourceBuffer, { failOn: 'none' })
    .rotate()
    .resize(sourceWidth, sourceHeight, { fit: 'fill' })
    .jpeg({ quality: 94, mozjpeg: true })
    .toBuffer()

  return sharp(softBackground, { failOn: 'none' })
    .composite([{ input: normalizedSource, left, top }])
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer()
}

const getReadableResponseText = async (response) => {
  try {
    return (await response.text()).slice(0, 220).trim()
  } catch {
    return ''
  }
}

const waitForGeneratedImage = async (url, timeoutMs = GENFILL_READY_TIMEOUT_MS) => {
  const startedAt = Date.now()
  let attempt = 0
  let firstImageSize = null
  const MIN_WAIT_BEFORE_ACCEPT_MS = 10_000 // genfill needs at least ~10s

  // Wait 4s before first poll
  console.log('[AI Extend] Waiting 4s before first poll...')
  await sleep(4000)

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1
    const elapsed = Date.now() - startedAt

    let response
    try {
      response = await fetch(url, {
        cache: 'no-store',
        headers: {
          Accept: 'image/*,*/*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
        },
      })
    } catch (fetchErr) {
      console.warn(`[AI Extend] Poll ${attempt} fetch failed:`, fetchErr.message)
      await sleep(GENFILL_POLL_DELAY_MS)
      continue
    }

    const contentType = response.headers.get('content-type') || ''
    const isIntermediate = response.headers.get('is-intermediate-response') === 'true'
    const contentLength = Number(response.headers.get('content-length') || 0)
    const waitedLongEnough = elapsed >= MIN_WAIT_BEFORE_ACCEPT_MS

    console.log(`[AI Extend] Poll ${attempt}:`, {
      elapsed: `${Math.round(elapsed / 1000)}s`,
      status: response.status,
      contentType: contentType.slice(0, 40),
      contentLength,
      isIntermediate,
      firstImageSize,
      waitedLongEnough,
    })

    // Case 1: Still preparing (HTML or intermediate response)
    if (isIntermediate || contentType.includes('text/html')) {
      const txt = await getReadableResponseText(response)
      console.log('[AI Extend] Still preparing:', txt.slice(0, 80))
      await sleep(GENFILL_POLL_DELAY_MS)
      continue
    }

    // Case 2: Non-OK response
    if (!response.ok) {
      const txt = await getReadableResponseText(response)
      throw new Error(
        txt
          ? `ImageKit rejected the generated image: ${txt}`
          : `ImageKit returned ${response.status}`
      )
    }

    // Case 3: Got an image response
    if (contentType.startsWith('image/')) {
      // Track first image size
      if (firstImageSize === null && contentLength > 0) {
        firstImageSize = contentLength
      }

      const sizeChanged = firstImageSize !== null &&
        contentLength > 0 &&
        Math.abs(contentLength - firstImageSize) > 512

      // Accept if: waited long enough, OR content size changed from first response
      if (waitedLongEnough || sizeChanged) {
        // Read the image bytes NOW — don't rely on a second fetch which may hit
        // a different CDN edge and return an intermediate HTML response.
        let imageBuffer = null
        try {
          imageBuffer = Buffer.from(await response.arrayBuffer())
        } catch (readErr) {
          console.warn('[AI Extend] Could not read image bytes, will re-fetch:', readErr.message)
          await response.body?.cancel?.()
        }
        console.log('[AI Extend] Accepting image:', {
          reason: sizeChanged ? 'size-changed' : 'waited-long-enough',
          firstImageSize,
          currentSize: imageBuffer?.length || contentLength,
          elapsed: `${Math.round(elapsed / 1000)}s`,
        })
        return { url, attempt, contentType, contentLength, imageBuffer }
      }

      // Too early — might be the unprocessed pad_resize placeholder
      await response.body?.cancel?.()
      console.log('[AI Extend] Skipping early image (likely unprocessed pad_resize)')
    } else {
      // Unknown content type — check if it's an error
      const txt = await getReadableResponseText(response)
      if (txt.toLowerCase().includes('currently being prepared')) {
        console.log('[AI Extend] Still preparing (text response)')
      } else {
        console.warn('[AI Extend] Unexpected response:', contentType, txt.slice(0, 80))
      }
    }

    await sleep(GENFILL_POLL_DELAY_MS)
  }

  throw new Error('ImageKit generation did not finish in time')
}

async function parseRequestBody(request) {
  const contentType = request.headers.get('content-type') || ''

  if (contentType.includes('multipart/form-data')) {
    try {
      const formData = await request.formData()
      const expansionRaw = formData.get('expansion')
      const expansion = typeof expansionRaw === 'string' ? JSON.parse(expansionRaw) : null

      return {
        sourceFile: formData.get('sourceFile'),
        sourceUrl: formData.get('sourceUrl'),
        expansion,
        prompt: formData.get('prompt') || '',
        targetWidth: formData.get('targetWidth'),
        targetHeight: formData.get('targetHeight'),
      }
    } catch {
      return { error: 'Invalid multipart body' }
    }
  }

  try {
    return await request.json()
  } catch {
    return { error: 'Invalid JSON body' }
  }
}

export async function POST(request) {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await parseRequestBody(request)
  if (body.error) {
    return NextResponse.json({ error: body.error }, { status: 400 })
  }

  const {
    sourceFile,
    sourceUrl: rawSourceUrl,
    expansion,
    prompt = '',
    targetWidth: rawW,
    targetHeight: rawH,
  } = body

  const sourceUrl = String(rawSourceUrl || '').trim()
  const sourceBaseUrl = normalizeImageKitUrl(sourceUrl)
  const hasSourceFile = Boolean(sourceFile && typeof sourceFile.arrayBuffer === 'function')

  console.log('[AI Extend] Request:', {
    rawSourceUrl: sourceUrl || undefined,
    normalizedSourceUrl: sourceBaseUrl || undefined,
    isImageKit: isImageKitUrl(sourceUrl),
    hasSourceFile,
    sourceFile: hasSourceFile
      ? { size: sourceFile.size, type: sourceFile.type, name: sourceFile.name }
      : undefined,
    targetW: rawW,
    targetH: rawH,
    sourceW: expansion?.sourceWidth,
    sourceH: expansion?.sourceHeight,
    insets: expansion?.insets,
  })

  if (!hasSourceFile && !sourceBaseUrl) {
    return NextResponse.json({ error: 'sourceUrl is required' }, { status: 400 })
  }

  const validation = validateExpansion(expansion)
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 })
  }

  const w = parseInt(rawW ?? expansion?.targetWidth, 10)
  const h = parseInt(rawH ?? expansion?.targetHeight, 10)
  if (!w || !h || w < MIN_DIM || h < MIN_DIM || w > MAX_DIM || h > MAX_DIM) {
    return NextResponse.json(
      { error: `Dimensions must be between ${MIN_DIM} and ${MAX_DIM} pixels` },
      { status: 400 }
    )
  }

  const client = getImageKitClient()
  if (!client) {
    return NextResponse.json({ error: 'ImageKit is not configured' }, { status: 500 })
  }

  const promptText = buildExtensionPrompt(prompt)

  try {
    const sourceFileInfo = hasSourceFile ? await readSourceFile(sourceFile) : null
    let localFallbackBuffer = sourceFileInfo?.buffer || null
    let transformSourceUrl = ''
    let sourceMode = hasSourceFile ? 'visible-composite-upload' : 'remote-url'

    const normalizedExpansion = {
      ...expansion,
      targetWidth: w,
      targetHeight: h,
    }

    if (sourceFileInfo?.buffer) {
      // Upload the SOURCE image at its original dimensions — NOT a pre-composited image.
      // bg-genfill only fills areas ADDED by cm-pad_resize. If we upload a composite
      // that's already at the target size, cm-pad_resize adds no padding → nothing to fill → black borders.
      transformSourceUrl = await uploadBufferToImageKit(
        client,
        sourceFileInfo.buffer,
        `extend-source-${Date.now()}.${getExtension(sourceFileInfo.contentType)}`,
        '/yt-projects/ai-extend/source'
      )
    } else if (isImageKitUrl(sourceUrl)) {
      transformSourceUrl = sourceUrl
    } else {
      const remoteSource = await fetchSourceImageBuffer(sourceUrl)
      localFallbackBuffer = remoteSource.buffer
      transformSourceUrl = await uploadSourceImage(client, sourceUrl)
      sourceMode = 'remote-upload'
    }

    if (!transformSourceUrl) {
      throw new Error('Could not prepare source image for extension')
    }

    // Always use cm-pad_resize + fo-* with bg-genfill.
    // buildSequentialGenfillUrl now uses getMultiSideFocus() which picks diagonal
    // focus values (fo-top_left, etc.) for multi-side extensions.
    const genfillUrl = buildSequentialGenfillUrl({
      sourceUrl: transformSourceUrl,
      prompt: promptText,
      expansion: normalizedExpansion,
    })

    const activeSides = ['left', 'right', 'top', 'bottom']
      .filter((side) => (normalizedExpansion.insets?.[side] || 0) >= 1)

    console.log('[AI Extend] Genfill URL:', {
      url: genfillUrl,
      activeSides,
      uploadedSource: hasSourceFile,
      sourceMode,
      sourceWidth: normalizedExpansion.sourceWidth,
      sourceHeight: normalizedExpansion.sourceHeight,
      targetWidth: w,
      targetHeight: h,
      insets: normalizedExpansion.insets,
    })

    try {
      const readyResult = await waitForGeneratedImage(genfillUrl)

      console.log('[AI Extend] Genfill ready:', {
        attempts: readyResult.attempt,
        contentType: readyResult.contentType,
        contentLength: readyResult.contentLength,
        hasBuffer: !!readyResult.imageBuffer,
      })

      // Re-upload as a clean static file so the browser gets a direct image URL
      // (no transform params that could return intermediate HTML on a different CDN edge).
      // Use the image bytes captured during polling — no second fetch needed!
      let finalUrl = genfillUrl
      try {
        let imgBuffer = readyResult.imageBuffer
        let imgType = readyResult.contentType || 'image/jpeg'

        // Fallback: re-fetch only if polling didn't capture the bytes
        if (!imgBuffer || imgBuffer.length < 2048) {
          console.log('[AI Extend] No buffer from poll, re-fetching...')
          const imgRes = await fetch(genfillUrl, { cache: 'no-store' })
          imgType = imgRes.headers.get('content-type') || 'image/jpeg'
          if (imgRes.ok && imgType.startsWith('image/')) {
            imgBuffer = Buffer.from(await imgRes.arrayBuffer())
          }
        }

        if (imgBuffer && imgBuffer.length > 2048) {
          finalUrl = await uploadBufferToImageKit(
            client,
            imgBuffer,
            `extend-result-${Date.now()}.${getExtension(imgType)}`,
            '/yt-projects/ai-extend/results'
          )
          console.log('[AI Extend] Uploaded clean result:', finalUrl)
        }
      } catch (uploadErr) {
        console.warn('[AI Extend] Could not re-upload genfill result, using transform URL:', uploadErr)
      }

      return NextResponse.json({
        success: true,
        url: finalUrl,
        uploadedUrl: transformSourceUrl === sourceUrl ? undefined : transformSourceUrl,
        method: sourceFileInfo?.buffer ? 'genfill-uploaded' : 'genfill',
        ready: true,
        width: w,
        height: h,
      })
    } catch (readyError) {
      if (!localFallbackBuffer) {
        throw readyError
      }

      console.warn('[AI Extend] Genfill not ready; using soft local extension:', readyError)
      const fallbackBuffer = await createSoftExtendFallbackBuffer(
        localFallbackBuffer,
        normalizedExpansion,
        w,
        h
      )
      const fallbackUrl = await uploadBufferToImageKit(
        client,
        fallbackBuffer,
        `extend-soft-fallback-${Date.now()}.jpg`,
        '/yt-projects/ai-extend/fallback'
      )

      return NextResponse.json({
        success: true,
        url: fallbackUrl,
        uploadedUrl: transformSourceUrl === sourceUrl ? undefined : transformSourceUrl,
        pendingGenfillUrl: genfillUrl,
        method: 'local-soft-extend',
        ready: true,
        fallbackReason: readyError?.message || 'ImageKit generation did not finish in time',
        width: w,
        height: h,
      })
    }
  } catch (error) {
    console.error('[AI Extend] Error:', error)
    return NextResponse.json(
      { error: error?.message || 'Failed to process extension' },
      { status: 500 }
    )
  }
}
