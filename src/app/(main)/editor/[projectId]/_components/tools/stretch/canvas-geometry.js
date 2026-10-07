// ─── Geometry helpers (shared conventions with the Crop tool) ─────────────────

export const canvasToScreen = (canvas, cx, cy) => {
  const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0]
  return { x: cx * vpt[0] + vpt[4], y: cy * vpt[3] + vpt[5] }
}

export const getImageCanvasBounds = (image) => {
  if (!image) return null
  const scaleX = Math.abs(image.scaleX || 1)
  const scaleY = Math.abs(image.scaleY || 1)
  const w = (image.width || 0) * scaleX
  const h = (image.height || 0) * scaleY
  const left = image.originX === 'center' ? (image.left || 0) - w / 2 : (image.left || 0)
  const top = image.originY === 'center' ? (image.top || 0) - h / 2 : (image.top || 0)
  return { left, top, width: w, height: h }
}

export const isImageObject = (obj) => obj?.type?.toLowerCase() === 'image'

// ─── Lasso helpers ────────────────────────────────────────────────────────────

/** Twice the signed area of a normalized polygon (sign ignored by callers). */
export const polygonArea = (pts) => {
  let a = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x - pts[i].x) * (pts[j].y + pts[i].y)
  }
  return Math.abs(a) / 2
}

/**
 * Drop points closer than `minDist` (normalized) to the previously kept one, so
 * a high-frequency pointer trail becomes a compact polygon the clip can sweep
 * cheaply. The first and last points are always kept.
 */
export const simplifyPolygon = (pts, minDist = 0.01) => {
  if (pts.length <= 3) return pts.slice()
  const out = [pts[0]]
  const minSq = minDist * minDist
  for (let i = 1; i < pts.length - 1; i++) {
    const last = out[out.length - 1]
    const dx = pts[i].x - last.x
    const dy = pts[i].y - last.y
    if (dx * dx + dy * dy >= minSq) out.push(pts[i])
  }
  out.push(pts[pts.length - 1])
  return out
}

export const getActiveImage = (canvas) => {
  if (!canvas) return null
  const active = canvas.getActiveObject?.()
  if (isImageObject(active) && active.visible !== false) return active
  const images = (canvas.getObjects?.() || []).filter((o) => isImageObject(o) && o.visible !== false)
  return images.at(-1) || null
}
