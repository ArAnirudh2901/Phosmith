import { auth } from '@clerk/nextjs/server'
import ImageKit from 'imagekit'
import { NextResponse } from 'next/server'

export const maxDuration = 30
export const runtime = 'nodejs'

// Single-shot poll: one quick fetch per request. The client decides the
// retry cadence (5–10s) so server connections stay short.
const POLL_FETCH_TIMEOUT_MS = 15 * 1000

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

const isImageKitGenfillUrl = (url) => {
  if (typeof url !== 'string') return false
  if (!url.includes('ik.imagekit.io')) return false
  // Must contain a bg-genfill transform — protects against open redirect to arbitrary URLs.
  return /bg-genfill/i.test(url)
}

export async function POST(request) {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const pendingUrl = String(body?.pendingGenfillUrl || '').trim()
  if (!pendingUrl) {
    return NextResponse.json({ error: 'pendingGenfillUrl is required' }, { status: 400 })
  }
  if (!isImageKitGenfillUrl(pendingUrl)) {
    return NextResponse.json({ error: 'Invalid ImageKit genfill URL' }, { status: 400 })
  }

  const client = getImageKitClient()
  if (!client) {
    return NextResponse.json({ error: 'ImageKit is not configured' }, { status: 500 })
  }

  // Single fetch with a short timeout — client retries on its own cadence.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), POLL_FETCH_TIMEOUT_MS)

  let response
  try {
    response = await fetch(pendingUrl, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'image/*,*/*',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
      },
    })
  } catch (err) {
    clearTimeout(timer)
    return NextResponse.json({ ready: false, status: 'fetch-failed', detail: err?.message || 'fetch error' })
  }
  clearTimeout(timer)

  const contentType = response.headers.get('content-type') || ''
  const isIntermediate = response.headers.get('is-intermediate-response') === 'true'

  // Still preparing
  if (isIntermediate || contentType.includes('text/html')) {
    try { await response.body?.cancel?.() } catch { /* ignore */ }
    return NextResponse.json({ ready: false, status: 'preparing' })
  }

  if (!response.ok) {
    let detail = ''
    try { detail = (await response.text()).slice(0, 200) } catch { /* ignore */ }
    return NextResponse.json(
      { ready: false, status: 'error', httpStatus: response.status, detail },
      { status: 200 }
    )
  }

  if (!contentType.startsWith('image/')) {
    try { await response.body?.cancel?.() } catch { /* ignore */ }
    return NextResponse.json({ ready: false, status: 'preparing' })
  }

  // Got an image. Read bytes and re-upload as a clean static URL so the
  // client gets a direct image (no transform chain that might briefly
  // serve an intermediate HTML response from a different CDN edge).
  let imageBuffer
  try {
    imageBuffer = Buffer.from(await response.arrayBuffer())
  } catch (err) {
    return NextResponse.json({ ready: false, status: 'read-failed', detail: err?.message || 'read error' })
  }

  // Reject tiny payloads (likely an unprocessed placeholder).
  if (!imageBuffer || imageBuffer.length < 2048) {
    return NextResponse.json({ ready: false, status: 'too-small', size: imageBuffer?.length || 0 })
  }

  try {
    const finalUrl = await uploadBufferToImageKit(
      client,
      imageBuffer,
      `extend-result-${Date.now()}.${getExtension(contentType)}`,
      '/yt-projects/ai-extend/results'
    )
    return NextResponse.json({
      ready: true,
      url: finalUrl,
      contentType,
      size: imageBuffer.length,
    })
  } catch (err) {
    console.warn('[AI Extend Poll] Upload failed, returning original genfill URL:', err)
    // Fall back to original URL — it's still a valid image at this point.
    return NextResponse.json({
      ready: true,
      url: pendingUrl,
      contentType,
      size: imageBuffer.length,
      uploadFailed: true,
    })
  }
}
