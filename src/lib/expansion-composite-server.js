import sharp from 'sharp'

/**
 * Build a transparent PNG composite on the server (full image at native size + margins).
 */
export async function buildExpansionCompositeBuffer(sourceUrl, expansion) {
  const {
    targetWidth,
    targetHeight,
    offsetX,
    offsetY,
    sourceWidth,
    sourceHeight,
  } = expansion

  const response = await fetch(sourceUrl, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Failed to fetch source image (${response.status})`)
  }

  const inputBuffer = Buffer.from(await response.arrayBuffer())
  const meta = await sharp(inputBuffer).metadata()
  const srcW = meta.width || sourceWidth
  const srcH = meta.height || sourceHeight

  const resized = await sharp(inputBuffer)
    .resize(sourceWidth || srcW, sourceHeight || srcH, {
      fit: 'fill',
      withoutEnlargement: false,
    })
    .png()
    .toBuffer()

  return sharp({
    create: {
      width: targetWidth,
      height: targetHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: resized,
        left: Math.max(0, Math.round(offsetX)),
        top: Math.max(0, Math.round(offsetY)),
      },
    ])
    .png()
    .toBuffer()
}
