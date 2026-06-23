/**
 * contour-trace — extract a polygon boundary from an alpha matte canvas.
 *
 * Used by the Pixel Stretch tool to convert a SAM / RMBG-1.4 subject mask
 * into a lasso polygon. The pipeline:
 *   1. Read the alpha (or luma) channel from an HTMLCanvasElement
 *   2. March a threshold contour using marching squares
 *   3. Simplify with Douglas-Peucker to ~50-100 points
 *   4. Return normalised (0-1) coordinates
 *
 * Pure function — no React, no Fabric, no side effects.
 */

/**
 * Trace the largest foreground contour from an alpha/luma matte canvas.
 *
 * @param {HTMLCanvasElement} matteCanvas  Greyscale/alpha matte (white = subject)
 * @param {Object} [opts]
 * @param {number} [opts.threshold=0.5]  0-1 luma cut-off for foreground
 * @param {number} [opts.simplifyEpsilon=0.003]  Douglas-Peucker tolerance (normalised)
 * @param {number} [opts.minPoints=8]  Discard contours shorter than this
 * @returns {{ polygon: Array<{x: number, y: number}>, bbox: {x: number, y: number, w: number, h: number} } | null}
 */
export function traceContour(matteCanvas, opts = {}) {
  const threshold = opts.threshold ?? 0.5
  const epsilon = opts.simplifyEpsilon ?? 0.003
  const minPoints = opts.minPoints ?? 8

  const W = matteCanvas.width
  const H = matteCanvas.height
  if (W < 2 || H < 2) return null

  const ctx = matteCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const imgData = ctx.getImageData(0, 0, W, H)
  const px = imgData.data

  // Build a binary bitmap: 1 = foreground, 0 = background.
  // Use the red channel (greyscale matttes have R = G = B).
  const threshByte = Math.round(threshold * 255)
  const binary = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) {
    binary[i] = px[i * 4] >= threshByte ? 1 : 0
  }

  // ── Marching squares ──────────────────────────────────────────────────
  // Walk the edge of the largest connected foreground region.

  // Find a starting edge pixel (topmost, then leftmost foreground pixel
  // adjacent to a background pixel).
  let startX = -1, startY = -1
  outer:
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (binary[y * W + x] === 1) {
        // Check if it borders background (any 4-neighbour is 0 or edge)
        if (
          x === 0 || y === 0 || x === W - 1 || y === H - 1 ||
          binary[y * W + (x - 1)] === 0 ||
          binary[y * W + (x + 1)] === 0 ||
          binary[(y - 1) * W + x] === 0 ||
          binary[(y + 1) * W + x] === 0
        ) {
          startX = x
          startY = y
          break outer
        }
      }
    }
  }

  if (startX < 0) return null // no foreground found

  // Moore neighbourhood contour tracing
  const contour = mooreTrace(binary, W, H, startX, startY)
  if (!contour || contour.length < minPoints) return null

  // Normalise to 0-1
  const normContour = contour.map(p => ({ x: p.x / W, y: p.y / H }))

  // Simplify
  let simplified = douglasPeucker(normContour, epsilon)
  if (simplified.length < 3) simplified = normContour

  // Compute bounding box
  let minX = 1, minY = 1, maxX = 0, maxY = 0
  for (const p of simplified) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }

  return {
    polygon: simplified,
    bbox: { x: minX, y: minY, w: Math.max(0.01, maxX - minX), h: Math.max(0.01, maxY - minY) },
  }
}

// ─── Moore Neighbourhood Contour Tracing ──────────────────────────────────

/**
 * Trace the outer boundary of a binary blob starting from (sx, sy) using
 * Moore neighbourhood tracing (8-connected). Returns an array of {x, y}
 * pixel coordinates forming a closed contour.
 */
function mooreTrace(binary, W, H, sx, sy) {
  // 8-connected neighbours: right, down-right, down, down-left, left, up-left, up, up-right
  const dx = [1, 1, 0, -1, -1, -1, 0, 1]
  const dy = [0, 1, 1, 1, 0, -1, -1, -1]

  const isFg = (x, y) => x >= 0 && y >= 0 && x < W && y < H && binary[y * W + x] === 1

  const points = []
  let x = sx, y = sy
  // Start searching from the left neighbour (direction 4)
  let dir = 4
  const maxSteps = W * H * 2 // safety limit
  let steps = 0

  do {
    points.push({ x, y })
    // Search for next boundary pixel by rotating around current pixel
    // Start from (dir + 5) % 8 to look back and to the left
    let startDir = (dir + 5) % 8
    let found = false

    for (let i = 0; i < 8; i++) {
      const d = (startDir + i) % 8
      const nx = x + dx[d]
      const ny = y + dy[d]
      if (isFg(nx, ny)) {
        x = nx
        y = ny
        dir = d
        found = true
        break
      }
    }

    if (!found) break // isolated pixel
    if (++steps > maxSteps) break // safety
  } while (x !== sx || y !== sy || points.length < 3)

  // Close the contour
  if (points.length >= 3 && (points[0].x !== x || points[0].y !== y)) {
    points.push({ x: points[0].x, y: points[0].y })
  }

  return points.length >= 3 ? points : null
}

// ─── Douglas-Peucker Simplification ─────────────────────────────────────────

function perpendicularDistance(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x
  const dy = lineEnd.y - lineStart.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(point.x - lineStart.x, point.y - lineStart.y)
  const t = Math.max(0, Math.min(1, ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lenSq))
  const projX = lineStart.x + t * dx
  const projY = lineStart.y + t * dy
  return Math.hypot(point.x - projX, point.y - projY)
}

/**
 * Simplify a polyline using the Douglas-Peucker algorithm.
 * @param {Array<{x: number, y: number}>} points
 * @param {number} epsilon  Maximum allowed distance from the simplified line
 * @returns {Array<{x: number, y: number}>}
 */
function douglasPeucker(points, epsilon) {
  if (points.length <= 2) return points.slice()

  let maxDist = 0
  let maxIndex = 0
  const end = points.length - 1

  for (let i = 1; i < end; i++) {
    const d = perpendicularDistance(points[i], points[0], points[end])
    if (d > maxDist) {
      maxDist = d
      maxIndex = i
    }
  }

  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIndex + 1), epsilon)
    const right = douglasPeucker(points.slice(maxIndex), epsilon)
    return left.slice(0, -1).concat(right)
  }

  return [points[0], points[end]]
}
