"use client"

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCanvas } from '../../../../../../../context/context'
import { FabricImage } from 'fabric'
import { toast } from 'sonner'
import {
  AudioLines, BrainCircuit, Check, ChevronDown, Columns3, FlipHorizontal2, Grid3X3, Lasso, Layers, Loader2,
  Minus, Pencil, Route, RotateCcw, Rows3, ScanSearch, Sparkles, Spline, Square, StretchHorizontal,
  StretchVertical, Wand2, Waypoints, X, Zap,
} from 'lucide-react'
import { ProRulerSlider } from '@/components/editor/ProRulerSlider'
import {
  DEFAULT_STRETCH,
  clampStretchParams,
  renderPixelStretch,
  getStretchAnchors,
  getStretchPath,
  getPolygonBBox,
  createStretchBuffer,
  createDefaultWarpGrid,
  getWarpRest,
  getWarpGridHandles,
  getWarpGridCurves,
  addWarpSplit,
  applyWarpPreset,
  analyzeStretchPlan,
  createDefaultFlowPath,
  createFlowPathFromPoints,
  getFlowPathCurve,
  getFlowPathHandles,
  insertFlowAnchor,
  removeFlowAnchor,
  smoothFlowPath,
  applyFlowPreset,
  matteToAlphaCanvas,
  applySubjectKnockout,
  buildSubjectCutout,
  FLOW_PRESETS,
  FLOW_MIN_ANCHORS,
  WARP_PRESETS,
  WARP_MAX_DIM,
  PIXEL_STRETCH_PRESETS,
} from '@/lib/pixel-stretch'
import { traceContour } from '@/lib/contour-trace'
import { clientSubjectMask } from '@/lib/client-ai'

// ─── Geometry helpers (shared conventions with the Crop tool) ─────────────────

const canvasToScreen = (canvas, cx, cy) => {
  const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0]
  return { x: cx * vpt[0] + vpt[4], y: cy * vpt[3] + vpt[5] }
}

const getImageCanvasBounds = (image) => {
  if (!image) return null
  const scaleX = Math.abs(image.scaleX || 1)
  const scaleY = Math.abs(image.scaleY || 1)
  const w = (image.width || 0) * scaleX
  const h = (image.height || 0) * scaleY
  const left = image.originX === 'center' ? (image.left || 0) - w / 2 : (image.left || 0)
  const top = image.originY === 'center' ? (image.top || 0) - h / 2 : (image.top || 0)
  return { left, top, width: w, height: h }
}

const isImageObject = (obj) => obj?.type?.toLowerCase() === 'image'

// ─── Lasso helpers ────────────────────────────────────────────────────────────

/** Twice the signed area of a normalized polygon (sign ignored by callers). */
const polygonArea = (pts) => {
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
const simplifyPolygon = (pts, minDist = 0.01) => {
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

const getActiveImage = (canvas) => {
  if (!canvas) return null
  const active = canvas.getActiveObject?.()
  if (isImageObject(active) && active.visible !== false) return active
  const images = (canvas.getObjects?.() || []).filter((o) => isImageObject(o) && o.visible !== false)
  return images.at(-1) || null
}

const getSourceElement = (img) => img?._originalElement || img?.getElement?.() || img?._element || null

const isSourceReady = (el) => {
  if (!el) return false
  if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth > 0
  return (el.naturalWidth || el.videoWidth || el.width || 0) > 0
}

/** Snapshot a source element into a W×H buffer, baking in the object's flip. */
const snapshotSource = (srcEl, W, H, flipX, flipY) => {
  const c = createStretchBuffer(W, H)
  const ctx = c.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.save()
  ctx.translate(flipX ? c.width : 0, flipY ? c.height : 0)
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1)
  ctx.drawImage(srcEl, 0, 0, c.width, c.height)
  ctx.restore()
  return c
}

const encodeToPngBlob = async (canvas) => {
  if (typeof canvas.convertToBlob === 'function') {
    // OffscreenCanvas — the PNG encode runs off the main thread.
    return canvas.convertToBlob({ type: 'image/png' })
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))), 'image/png')
  })
}

const uploadStretchBlob = async (blob, w, h) => {
  const fileName = `stretch-${Date.now()}.png`
  const formData = new FormData()
  formData.append('fileName', fileName)
  formData.append('rasterFile', blob, fileName)
  formData.append('rasterFileName', fileName)
  formData.append('rasterWidth', String(w))
  formData.append('rasterHeight', String(h))
  const response = await fetch('/api/imagekit/upload', { method: 'POST', body: formData })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.success || !data?.url) {
    throw new Error(data?.error || 'Could not upload stretched image')
  }
  return data.url
}

const MAX_PREVIEW_DIM = 1500
const MAX_BAKE_DIM = 4096
const HANDLE = 14
const MIN_BAND = 0.02
const SETTLE_MS = 150
const DIM_BG = 'rgba(4, 6, 10, 0.55)'
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

const HANDLE_DEFS = [
  { id: 'tl', cx: 0, cy: 0, cur: 'nwse-resize' },
  { id: 'tr', cx: 1, cy: 0, cur: 'nesw-resize' },
  { id: 'bl', cx: 0, cy: 1, cur: 'nesw-resize' },
  { id: 'br', cx: 1, cy: 1, cur: 'nwse-resize' },
  { id: 't', cx: 0.5, cy: 0, cur: 'ns-resize' },
  { id: 'b', cx: 0.5, cy: 1, cur: 'ns-resize' },
  { id: 'l', cx: 0, cy: 0.5, cur: 'ew-resize' },
  { id: 'r', cx: 1, cy: 0.5, cur: 'ew-resize' },
]

let uidCounter = 0

// ─── Tool ─────────────────────────────────────────────────────────────────────

const PixelStretchControls = ({ dominantColor, contrastingColor }) => {
  const { canvasEditor, activeTool } = useCanvas()
  const active = activeTool === 'pixel_stretch'
  const accent = dominantColor || '#00E5FF'
  const onAccent = contrastingColor || '#03050A'

  const [selectedImage, setSelectedImage] = useState(null)
  const [containerEl, setContainerEl] = useState(null)
  const [params, setParams] = useState(DEFAULT_STRETCH)
  const [applying, setApplying] = useState(false)
  const [activePresetId, setActivePresetId] = useState(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)

  // Two-phase workflow: pick a region (lasso / rectangle) → confirm → stretch it.
  const [phase, setPhase] = useState('select')          // 'select' | 'stretch'
  const [selectionMode, setSelectionMode] = useState('lasso') // 'lasso' | 'rect'
  const [regionReady, setRegionReady] = useState(false)  // a confirmable region exists
  const phaseRef = useRef(phase)
  const selModeRef = useRef(selectionMode)
  const lassoPtsRef = useRef([])        // freeform points being drawn (normalized)
  const lassoDrawingRef = useRef(false)
  useEffect(() => { phaseRef.current = phase }, [phase])
  useEffect(() => { selModeRef.current = selectionMode }, [selectionMode])

  // ── Warp mesh state (Advanced mode — Photoshop-style control grid) ──────────
  const [warpMode, setWarpMode] = useState(false)  // false = Simple sliders, true = Warp grid
  const [warpPresetId, setWarpPresetId] = useState(null) // last applied warp preset
  const [warpStrength, setWarpStrength] = useState(1)     // preset intensity (0..1.5)

  // ── Flow Path state (multi-anchor directional spline — the reference trend) ──
  const [flowMode, setFlowMode] = useState(false)
  const [flowPresetId, setFlowPresetId] = useState(null)
  const [flowAnchorCount, setFlowAnchorCount] = useState(0) // panel reflects the live anchor count

  // ── Layer placement: the stretch commits as its OWN layer over the photo, and
  // `coverage` controls how much of the detected subject sits OVER the ribbons —
  // 0 = ribbons fully on top ("above the subject"), 1 = subject fully on top
  // ("below the subject"), ~0.5 = "partially on the subject". Driven by the
  // on-device subject matte, so the layer reads as motion behind the subject.
  const [coverage, setCoverage] = useState(0)
  const [matteStatus, setMatteStatus] = useState('idle')   // 'idle'|'loading'|'ready'|'none'
  const [isEditingLayer, setIsEditingLayer] = useState(false) // re-editing an existing stretch layer
  // What stays IN FRONT of the streaks: 'auto' (on-device subject detect) or
  // 'manual' (a region the user traces). `subjectPicking` = currently tracing it.
  const [subjectMaskKind, setSubjectMaskKind] = useState('none') // 'none'|'auto'|'manual'
  const [subjectPicking, setSubjectPicking] = useState(false)
  useEffect(() => { coverageRef.current = coverage }, [coverage])

  // ── SAM auto-detect subject state ───────────────────────────────────────────
  const [samLoading, setSamLoading] = useState(false)

  // Live state lives in refs so dragging never triggers a React re-render.
  const paramsRef = useRef(params)
  const editorRef = useRef(canvasEditor)
  const selectedImageRef = useRef(null)
  const containerRef = useRef(null)
  const previewCanvasRef = useRef(null)
  const offscreenRef = useRef(null)
  const sampleRef = useRef(null)
  const sampleSigRef = useRef('')
  const lockRef = useRef(null)
  const draggingRef = useRef(null)
  const rafRef = useRef(0)
  const settleTimerRef = useRef(0)
  const interactingRef = useRef(false)
  const vptSigRef = useRef('')

  // Layer-placement refs (mutated live, read in render/bake without re-rendering).
  const coverageRef = useRef(0)
  const featherRef = useRef(0.006)   // subject-edge feather as a FRACTION of min(W,H)
  const sampleElRef = useRef(null)         // element to SAMPLE from (source); null → selected image's element
  const sampleFlipRef = useRef({ x: false, y: false })
  const editingLayerRef = useRef(null)     // existing stretch layer being re-edited (null = creating new)
  const sourceMetaRef = useRef(null)       // { src, w, h, flipX, flipY } describing the layer's source
  const subjectRawMatteRef = useRef(null)  // cached front-subject luminance matte (auto OR manual)
  const subjectMatteSigRef = useRef('')    // identity of the source the matte was built for
  const subjectCutoutRef = useRef(null)    // cached { key, canvas } subject cutout for preview compositing
  const matteIsManualRef = useRef(false)   // true when the matte is a user-traced region (don't auto-overwrite)
  const subjectPickRef = useRef(false)     // live mirror of subjectPicking for the pointer handlers
  // Latest scheduleFrame / ensureSubjectMatte, so the enter effect's async source
  // loader can trigger them WITHOUT taking them as deps (re-running the enter
  // effect would discard the active object and lose the re-edit target).
  const scheduleFrameRef = useRef(null)
  const ensureMatteRef = useRef(null)

  // Overlay DOM refs (positioned imperatively, never via React on drag/zoom).
  const drawSurfaceRef = useRef(null)
  const warpSurfaceRef = useRef(null)
  const flowSurfaceRef = useRef(null)
  const bandRef = useRef(null)
  const handleRefs = useRef([])
  const dimRefs = useRef([])
  const flowRef = useRef(null)
  const labelRef = useRef(null)

  useEffect(() => { editorRef.current = canvasEditor }, [canvasEditor])

  // ── Canvas container element ─────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasEditor) { containerRef.current = null; setContainerEl(null); return }
    const el = canvasEditor.lowerCanvasEl?.parentElement?.parentElement
    containerRef.current = el || null
    setContainerEl(el || null)
  }, [canvasEditor])

  // ── Image lock helpers (track current image via a ref → re-apply safe) ───────
  const lockImage = useCallback((img) => {
    if (!img) return
    lockRef.current = {
      img,
      props: {
        selectable: img.selectable, evented: img.evented,
        lockMovementX: img.lockMovementX, lockMovementY: img.lockMovementY,
        hasControls: img.hasControls, hasBorders: img.hasBorders,
      },
    }
    img.set({ selectable: false, evented: false, lockMovementX: true, lockMovementY: true, hasControls: false, hasBorders: false })
  }, [])

  const unlockImage = useCallback(() => {
    const l = lockRef.current
    if (l?.img) l.img.set(l.props)
    lockRef.current = null
  }, [])

  // ── Source snapshot (cached; rebuilt only on zoom-res or image change) ───────
  const getSample = useCallback(() => {
    const img = selectedImageRef.current
    const editor = editorRef.current
    if (!img || !editor) return null
    const bounds = getImageCanvasBounds(img)
    if (!bounds) return null
    const zX = editor.viewportTransform?.[0] || 1
    const zY = editor.viewportTransform?.[3] || 1
    const screenW = Math.max(1, bounds.width * zX)
    const screenH = Math.max(1, bounds.height * zY)
    const q = Math.min(1, MAX_PREVIEW_DIM / Math.max(screenW, screenH))
    const W = Math.max(1, Math.round(screenW * q))
    const H = Math.max(1, Math.round(screenH * q))
    const sig = `${W}x${H}:${img.__stretchUid || 0}`
    if (sampleRef.current && sampleSigRef.current === sig) return sampleRef.current
    // When re-editing a stretch layer, sample from the stored SOURCE element
    // (sampleElRef) — not the layer's ribbon pixels — with the source's own flip.
    const srcEl = sampleElRef.current || getSourceElement(img)
    if (!isSourceReady(srcEl)) return null
    const flipX = sampleElRef.current ? sampleFlipRef.current.x : img.flipX
    const flipY = sampleElRef.current ? sampleFlipRef.current.y : img.flipY
    sampleRef.current = { canvas: snapshotSource(srcEl, W, H, flipX, flipY), w: W, h: H }
    sampleSigRef.current = sig
    return sampleRef.current
  }, [])

  // ── Reusable offscreen ribbon buffer ─────────────────────────────────────────
  const getOffscreen = useCallback((w, h) => {
    let o = offscreenRef.current
    if (!o) {
      const c = createStretchBuffer(w, h)
      o = { canvas: c, ctx: c.getContext('2d') }
      offscreenRef.current = o
    } else if (o.canvas.width !== w || o.canvas.height !== h) {
      o.canvas.width = w
      o.canvas.height = h
    }
    return o
  }, [])

  // ── Subject cutout (cached) for preview compositing ──────────────────────────
  // Builds the detected-subject pixels (transparent elsewhere) at the sample
  // resolution, rebuilt only when the size / matte / feather change — so dragging
  // the Coverage slider stays cheap (only the draw alpha changes).
  const getSubjectCutout = useCallback((sampleCanvas, w, h) => {
    if (coverageRef.current <= 0 || !subjectRawMatteRef.current) return null
    const key = `${w}x${h}:${subjectMatteSigRef.current}:${featherRef.current}`
    if (subjectCutoutRef.current?.key === key) return subjectCutoutRef.current.canvas
    const alpha = matteToAlphaCanvas(subjectRawMatteRef.current, w, h, featherRef.current)
    const cutout = buildSubjectCutout(sampleCanvas, alpha, w, h)
    subjectCutoutRef.current = { key, canvas: cutout }
    return cutout
  }, [])

  // ── On-device subject matte (cached per source) — drives layer placement ─────
  const ensureSubjectMatte = useCallback(async () => {
    // A user-traced (manual) matte is authoritative — never replace it with auto-detect.
    if (matteIsManualRef.current && subjectRawMatteRef.current) return subjectRawMatteRef.current
    const srcEl = sampleElRef.current || getSourceElement(selectedImageRef.current)
    if (!isSourceReady(srcEl)) return null
    const sig = sourceMetaRef.current?.src || String(selectedImageRef.current?.__stretchUid ?? '')
    if (subjectRawMatteRef.current && subjectMatteSigRef.current === sig) return subjectRawMatteRef.current
    setMatteStatus('loading')
    try {
      const natW = srcEl.naturalWidth || srcEl.videoWidth || srcEl.width || 512
      const natH = srcEl.naturalHeight || srcEl.videoHeight || srcEl.height || 512
      const matte = await clientSubjectMask(srcEl, { width: natW, height: natH })
      if (!matte) throw new Error('No subject matte returned')
      subjectRawMatteRef.current = matte
      subjectMatteSigRef.current = sig
      matteIsManualRef.current = false
      subjectCutoutRef.current = null   // invalidate the cutout cache
      setMatteStatus('ready')
      setSubjectMaskKind('auto')
      return matte
    } catch (err) {
      console.warn('[PixelStretch] subject matte failed:', err?.message)
      subjectRawMatteRef.current = null
      setMatteStatus('none')
      return null
    }
  }, [])

  // ── Manual front-subject mask (the user traces the region that stays in front) ─
  const rasterizeSubjectMatte = useCallback((poly) => {
    if (!Array.isArray(poly) || poly.length < 3) return null
    const img = selectedImageRef.current
    const natW = Math.min(1600, Math.max(64, img?.width || 1024))
    const natH = Math.min(1600, Math.max(64, img?.height || 1024))
    const c = createStretchBuffer(natW, natH)
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, natW, natH)
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    poly.forEach((pt, i) => { const x = pt.x * natW, y = pt.y * natH; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) })
    ctx.closePath()
    ctx.fill()
    return c
  }, [])

  const finishSubjectPick = useCallback((poly) => {
    const matte = rasterizeSubjectMatte(poly)
    if (!matte) { toast.error('Trace a larger area around the subject'); return false }
    subjectRawMatteRef.current = matte
    subjectMatteSigRef.current = sourceMetaRef.current?.src || String(selectedImageRef.current?.__stretchUid ?? '')
    matteIsManualRef.current = true
    subjectCutoutRef.current = null
    setMatteStatus('ready')
    setSubjectMaskKind('manual')
    // Drawing a front-region implies the user wants it in front — default to Behind.
    if (coverageRef.current <= 0) { coverageRef.current = 1; setCoverage(1) }
    scheduleFrameRef.current?.()
    toast.success('Subject region set — streaks now sit behind it', { duration: 2200 })
    return true
  }, [rasterizeSubjectMatte])

  const beginSubjectPick = useCallback(() => {
    // The draw surface routes to a freeform lasso while subjectPickRef is set — no
    // need to touch selModeRef (that would desync the Selection Tool buttons).
    lassoPtsRef.current = []
    lassoDrawingRef.current = false
    subjectPickRef.current = true
    setSubjectPicking(true)
    scheduleFrameRef.current?.()
  }, [])

  const cancelSubjectPick = useCallback(() => {
    subjectPickRef.current = false
    setSubjectPicking(false)
    lassoPtsRef.current = []
    scheduleFrameRef.current?.()
  }, [])

  // Force a fresh on-device detect, discarding any manual trace (which ensureSubjectMatte
  // would otherwise keep as authoritative).
  const forceAutoDetect = useCallback(async () => {
    subjectPickRef.current = false
    setSubjectPicking(false)
    matteIsManualRef.current = false
    subjectRawMatteRef.current = null
    subjectMatteSigRef.current = ''
    subjectCutoutRef.current = null
    await ensureSubjectMatte()
    scheduleFrameRef.current?.()
  }, [ensureSubjectMatte])


  // ── Draw the live preview ────────────────────────────────────────────────────
  const renderPreview = useCallback(() => {
    const canvas = previewCanvasRef.current
    const img = selectedImageRef.current
    const editor = editorRef.current
    const container = containerRef.current
    if (!canvas || !img || !editor || !container) return
    const bounds = getImageCanvasBounds(img)
    if (!bounds) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cw = container.clientWidth
    const ch = container.clientHeight
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr)
      canvas.height = Math.round(ch * dpr)
      canvas.style.width = `${cw}px`
      canvas.style.height = `${ch}px`
    }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch)

    const toScreenN = (nx, ny) => canvasToScreen(editor, bounds.left + nx * bounds.width, bounds.top + ny * bounds.height)

    // Lasso outline — the freeform path being drawn, or the confirmed selection.
    const drawLasso = (pts, closed) => {
      if (!pts || pts.length < 2) return
      ctx.save()
      ctx.beginPath()
      pts.forEach((pt, i) => {
        const s = toScreenN(pt.x, pt.y)
        if (i === 0) ctx.moveTo(s.x, s.y)
        else ctx.lineTo(s.x, s.y)
      })
      if (closed) ctx.closePath()
      ctx.fillStyle = `${accent}1f`
      if (closed) ctx.fill()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = 'rgba(0,0,0,0.85)'
      ctx.setLineDash([6, 4])
      ctx.stroke()
      ctx.strokeStyle = accent
      ctx.lineDashOffset = 3
      ctx.stroke()
      ctx.restore()
    }

    // ── Selection phase: show the region picker, not the stretch ──
    if (phaseRef.current === 'select') {
      if (selModeRef.current === 'lasso') {
        drawLasso(lassoPtsRef.current, !lassoDrawingRef.current && lassoPtsRef.current.length >= 3)
      } else if (selModeRef.current === 'rect') {
        // Draw the current rect band as a dashed outline during selection
        const b = paramsRef.current.band
        const rTL = toScreenN(b.x, b.y)
        const rBR = toScreenN(b.x + b.w, b.y + b.h)
        const rW = rBR.x - rTL.x
        const rH = rBR.y - rTL.y
        if (rW > 2 && rH > 2) {
          // Dim outside the rectangle
          ctx.save()
          ctx.fillStyle = DIM_BG
          // Top
          ctx.fillRect(0, 0, cw, Math.max(0, rTL.y))
          // Bottom
          ctx.fillRect(0, rTL.y + rH, cw, ch - (rTL.y + rH))
          // Left
          ctx.fillRect(0, rTL.y, Math.max(0, rTL.x), rH)
          // Right
          ctx.fillRect(rTL.x + rW, rTL.y, cw - (rTL.x + rW), rH)
          ctx.restore()

          // Marching ants border
          ctx.save()
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 1.5
          ctx.setLineDash([6, 4])
          ctx.strokeRect(rTL.x, rTL.y, rW, rH)
          ctx.strokeStyle = accent
          ctx.lineDashOffset = 3
          ctx.strokeRect(rTL.x, rTL.y, rW, rH)
          ctx.restore()

          // Dimensions label
          const imgW = Math.round(b.w * (img.width || 0))
          const imgH = Math.round(b.h * (img.height || 0))
          const label = `${imgW} × ${imgH}`
          ctx.save()
          ctx.font = '600 11px ui-monospace, monospace'
          ctx.textAlign = 'center'
          const lx = rTL.x + rW / 2
          const ly = rTL.y + rH + 18
          const tw = ctx.measureText(label).width + 16
          ctx.fillStyle = 'rgba(4,6,10,0.82)'
          ctx.beginPath()
          const rx = lx - tw / 2, ry = ly - 8, rw2 = tw, rh2 = 18, rad = 4
          ctx.moveTo(rx + rad, ry)
          ctx.lineTo(rx + rw2 - rad, ry)
          ctx.quadraticCurveTo(rx + rw2, ry, rx + rw2, ry + rad)
          ctx.lineTo(rx + rw2, ry + rh2 - rad)
          ctx.quadraticCurveTo(rx + rw2, ry + rh2, rx + rw2 - rad, ry + rh2)
          ctx.lineTo(rx + rad, ry + rh2)
          ctx.quadraticCurveTo(rx, ry + rh2, rx, ry + rh2 - rad)
          ctx.lineTo(rx, ry + rad)
          ctx.quadraticCurveTo(rx, ry, rx + rad, ry)
          ctx.closePath()
          ctx.fill()
          ctx.fillStyle = accent
          ctx.fillText(label, lx, ly + 4)
          ctx.restore()
        }
      }
      return
    }

    const sample = getSample()
    if (!sample) return

    const o = getOffscreen(sample.w, sample.h)
    o.ctx.setTransform(1, 0, 0, 1, 0, 0)
    o.ctx.clearRect(0, 0, sample.w, sample.h)
    // Simulate the final LAYER STACK so the preview matches what's committed:
    //   base photo (the layer below)  →  stretch ribbons (the new layer)  →
    //   detected subject re-composited on top by `coverage` (so the streaks read
    //   as motion behind the subject for "partially / below the subject").
    o.ctx.drawImage(sample.canvas, 0, 0, sample.w, sample.h)
    const quality = interactingRef.current ? 'low' : 'high'
    const drew = renderPixelStretch(o.ctx, sample.canvas, paramsRef.current, sample.w, sample.h, { quality })
    if (drew && coverageRef.current > 0) {
      const cutout = getSubjectCutout(sample.canvas, sample.w, sample.h)
      if (cutout) {
        o.ctx.save()
        o.ctx.globalAlpha = Math.min(1, Math.max(0, coverageRef.current))
        o.ctx.drawImage(cutout, 0, 0, sample.w, sample.h)
        o.ctx.restore()
      }
    }
    if (!drew) return

    const tl = canvasToScreen(editor, bounds.left, bounds.top)
    const zX = editor.viewportTransform?.[0] || 1
    const zY = editor.viewportTransform?.[3] || 1
    const sW = bounds.width * zX
    const sH = bounds.height * zY
    ctx.save()
    ctx.beginPath()
    ctx.rect(tl.x, tl.y, sW, sH)
    ctx.clip()
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(o.canvas, 0, 0, sample.w, sample.h, tl.x, tl.y, sW, sH)
    ctx.restore()

    // ── Flow Path overlay — the spline + draggable anchors and tangent handles ──
    if (paramsRef.current.flowPath) {
      const sN = (nx, ny) => canvasToScreen(editor, bounds.left + nx, bounds.top + ny)
      const curve = getFlowPathCurve(paramsRef.current, bounds.width, bounds.height, interactingRef.current ? 16 : 30)
      if (curve && curve.length > 1) {
        ctx.save()
        ctx.lineJoin = 'round'; ctx.lineCap = 'round'
        ctx.beginPath()
        for (let i = 0; i < curve.length; i++) {
          const s = sN(curve[i].x, curve[i].y)
          if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y)
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 3.5; ctx.stroke()
        ctx.strokeStyle = 'rgba(90, 170, 255, 0.95)'; ctx.lineWidth = 1.75; ctx.stroke()
        ctx.restore()
      }
      const handles = getFlowPathHandles(paramsRef.current, bounds.width, bounds.height)
      if (handles) {
        const anchorAt = (idx) => handles.find((h) => h.idx === idx && h.kind === 'anchor')
        // Tangent lines: anchor → its in/out handles (the Pen-tool direction look).
        ctx.save()
        ctx.strokeStyle = 'rgba(120, 190, 255, 0.7)'; ctx.lineWidth = 1
        for (const h of handles) {
          if (h.kind === 'anchor') continue
          const a = anchorAt(h.idx); if (!a) continue
          const s1 = sN(h.x, h.y), s2 = sN(a.x, a.y)
          ctx.beginPath(); ctx.moveTo(s2.x, s2.y); ctx.lineTo(s1.x, s1.y); ctx.stroke()
        }
        ctx.restore()
        // Tangent handles = round dots; anchors = squares (drawn last, on top).
        for (const h of handles) {
          if (h.kind === 'anchor') continue
          const s = sN(h.x, h.y)
          ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill()
          ctx.beginPath(); ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(120, 190, 255, 0.98)'; ctx.fill()
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.25; ctx.stroke()
        }
        for (const h of handles) {
          if (h.kind !== 'anchor') continue
          const s = sN(h.x, h.y)
          const r = 6
          ctx.beginPath(); ctx.rect(s.x - r - 1, s.y - r - 1, (r + 1) * 2, (r + 1) * 2); ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill()
          ctx.beginPath(); ctx.rect(s.x - r, s.y - r, r * 2, r * 2); ctx.fillStyle = 'rgba(40, 130, 255, 1)'; ctx.fill()
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
        }
      }
    } else if (paramsRef.current.warpGrid) {
      const sN = (nx, ny) => canvasToScreen(editor, bounds.left + nx, bounds.top + ny)
      const curves = getWarpGridCurves(paramsRef.current, bounds.width, bounds.height, interactingRef.current ? 10 : 18)
      if (curves) {
        const drawPoly = (line) => {
          ctx.beginPath()
          for (let i = 0; i < line.length; i++) {
            const s = sN(line[i].x, line[i].y)
            if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y)
          }
          ctx.stroke()
        }
        ctx.save()
        ctx.lineJoin = 'round'
        // Dark underlay for contrast over bright pixels, then the blue mesh.
        ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 2.5
        curves.rows.forEach(drawPoly); curves.cols.forEach(drawPoly)
        ctx.strokeStyle = 'rgba(90, 170, 255, 0.85)'; ctx.lineWidth = 1.25
        curves.rows.forEach(drawPoly); curves.cols.forEach(drawPoly)
        ctx.restore()
      }

      const handles = getWarpGridHandles(paramsRef.current, bounds.width, bounds.height)
      if (handles) {
        const at = (row, col) => handles.find((h) => h.row === row && h.col === col)
        // Tangent lines: handle → its anchor (the Photoshop direction-handle look).
        ctx.save()
        ctx.strokeStyle = 'rgba(120, 190, 255, 0.7)'
        ctx.lineWidth = 1
        for (const h of handles) {
          if (h.kind !== 'handle') continue
          const a = at(h.anchorRow, h.anchorCol)
          if (!a) continue
          const s1 = sN(h.x, h.y), s2 = sN(a.x, a.y)
          ctx.beginPath(); ctx.moveTo(s2.x, s2.y); ctx.lineTo(s1.x, s1.y); ctx.stroke()
        }
        ctx.restore()

        // Control points: anchors = squares (move the sheet); handles = round
        // (bend the curve); interior = small dots (inner pull).
        for (const h of handles) {
          const s = sN(h.x, h.y)
          if (h.kind === 'interior') {
            ctx.beginPath(); ctx.arc(s.x, s.y, 4.5, 0, Math.PI * 2)
            ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill()
            ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, Math.PI * 2)
            ctx.fillStyle = 'rgba(165, 215, 255, 0.9)'; ctx.fill()
            ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1; ctx.stroke()
          } else if (h.kind === 'handle') {
            ctx.beginPath(); ctx.arc(s.x, s.y, 5.5, 0, Math.PI * 2)
            ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill()
            ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2)
            ctx.fillStyle = 'rgba(120, 190, 255, 0.98)'; ctx.fill()
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.25; ctx.stroke()
          } else {
            const r = 6
            ctx.beginPath(); ctx.rect(s.x - r - 1, s.y - r - 1, (r + 1) * 2, (r + 1) * 2)
            ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill()
            ctx.beginPath(); ctx.rect(s.x - r, s.y - r, r * 2, r * 2)
            ctx.fillStyle = 'rgba(40, 130, 255, 1)'; ctx.fill()
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
          }
        }
      }
    } else {
      // Simple guide curve along the ribbon centerline (original behavior).
      const pts = getStretchPath(paramsRef.current, bounds.width, bounds.height, 36)
      if (pts.length > 1) {
        ctx.save()
        ctx.beginPath()
        pts.forEach((pt, i) => {
          const s = canvasToScreen(editor, bounds.left + pt.x * bounds.width, bounds.top + pt.y * bounds.height)
          if (i === 0) ctx.moveTo(s.x, s.y)
          else ctx.lineTo(s.x, s.y)
        })
        ctx.strokeStyle = 'rgba(255,255,255,0.38)'
        ctx.lineWidth = 1.5
        ctx.setLineDash([5, 5])
        ctx.stroke()
        ctx.restore()
      }
    }

    // Outline the confirmed lasso so the user can see the region they're stretching.
    if (selModeRef.current === 'lasso' && paramsRef.current.polygon?.length >= 3) {
      drawLasso(paramsRef.current.polygon, true)
    }

    // While tracing the front-subject region (placement), show the live trace.
    if (subjectPickRef.current && lassoPtsRef.current.length >= 2) {
      drawLasso(lassoPtsRef.current, !lassoDrawingRef.current && lassoPtsRef.current.length >= 3)
    }
  }, [getSample, getOffscreen, getSubjectCutout, accent])

  // ── Position the overlay (draw surface, dim, band, handles) imperatively ─────
  const layoutOverlay = useCallback(() => {
    const img = selectedImageRef.current
    const editor = editorRef.current
    if (!img || !editor) return
    const bounds = getImageCanvasBounds(img)
    if (!bounds) return
    const p = paramsRef.current
    const phaseNow = phaseRef.current
    const mode = selModeRef.current
    // Rectangle chrome (band box, dim, resize handles) belongs to the STRETCH
    // phase only — during select, the draw surface must be the sole interactive
    // element so users can freely drag new rectangles without the band/handles
    // intercepting pointer events.
    const warpOn = !!p.warpGrid
    const flowOn = !!p.flowPath
    const showMarquee = mode === 'rect' && phaseNow === 'stretch' && !warpOn && !flowOn
    const showFlow = phaseNow === 'stretch' && !warpOn && !flowOn
    const showWarp = phaseNow === 'stretch' && warpOn
    const showFlowPath = phaseNow === 'stretch' && flowOn
    const showDraw = phaseNow === 'select' || subjectPickRef.current
    const toggle = (el, on) => { if (el) el.style.display = on ? 'block' : 'none' }
    const toS = (nx, ny) => canvasToScreen(editor, bounds.left + nx * bounds.width, bounds.top + ny * bounds.height)

    const imgTL = toS(0, 0)
    const imgBR = toS(1, 1)
    const b = p.band
    const tl = toS(b.x, b.y)
    const br = toS(b.x + b.w, b.y + b.h)
    const bw = br.x - tl.x
    const bh = br.y - tl.y

    // Draw surface — covers the whole image so a drag on empty area starts a selection
    toggle(drawSurfaceRef.current, showDraw)
    if (drawSurfaceRef.current) {
      const s = drawSurfaceRef.current.style
      s.cursor = 'crosshair'
      s.zIndex = '55'  // Above band/handles/dim so it captures all pointer events
      s.left = `${imgTL.x}px`; s.top = `${imgTL.y}px`
      s.width = `${imgBR.x - imgTL.x}px`; s.height = `${imgBR.y - imgTL.y}px`
    }

    // Warp surface — covers the image during Advanced warp so any of the R×C
    // control points can be grabbed directly (the small flow handle can't reach
    // points spread across the whole sheet).
    toggle(warpSurfaceRef.current, showWarp)
    if (warpSurfaceRef.current) {
      const s = warpSurfaceRef.current.style
      // Extend past the image so control points dragged off-canvas stay grabbable.
      const mw = (imgBR.x - imgTL.x) * 0.3, mh = (imgBR.y - imgTL.y) * 0.3
      s.cursor = 'grab'
      s.zIndex = '54'
      s.left = `${imgTL.x - mw}px`; s.top = `${imgTL.y - mh}px`
      s.width = `${imgBR.x - imgTL.x + mw * 2}px`; s.height = `${imgBR.y - imgTL.y + mh * 2}px`
    }

    // Flow surface — covers the image (with margin) so anchors dragged off-canvas
    // stay grabbable, and a click on the spline can insert a new anchor.
    toggle(flowSurfaceRef.current, showFlowPath)
    if (flowSurfaceRef.current) {
      const s = flowSurfaceRef.current.style
      const mw = (imgBR.x - imgTL.x) * 0.35, mh = (imgBR.y - imgTL.y) * 0.35
      s.cursor = 'crosshair'
      s.zIndex = '54'
      s.left = `${imgTL.x - mw}px`; s.top = `${imgTL.y - mh}px`
      s.width = `${imgBR.x - imgTL.x + mw * 2}px`; s.height = `${imgBR.y - imgTL.y + mh * 2}px`
    }

    // Dark overlay regions — dim everything outside the selected band (rect only)
    const dims = dimRefs.current
    dims.forEach((d) => toggle(d, showMarquee))
    if (showMarquee) {
      if (dims[0]) { const s = dims[0].style; s.left = '0'; s.top = '0'; s.right = '0'; s.height = `${Math.max(0, tl.y)}px` }
      if (dims[1]) { const s = dims[1].style; s.left = '0'; s.right = '0'; s.bottom = '0'; s.top = `${tl.y + bh}px` }
      if (dims[2]) { const s = dims[2].style; s.left = '0'; s.top = `${tl.y}px`; s.width = `${Math.max(0, tl.x)}px`; s.height = `${bh}px` }
      if (dims[3]) { const s = dims[3].style; s.left = `${tl.x + bw}px`; s.right = '0'; s.top = `${tl.y}px`; s.height = `${bh}px` }
    }

    toggle(bandRef.current, showMarquee)
    if (showMarquee && bandRef.current) {
      const s = bandRef.current.style
      s.left = `${tl.x}px`; s.top = `${tl.y}px`; s.width = `${bw}px`; s.height = `${bh}px`
    }

    HANDLE_DEFS.forEach((h, i) => {
      const el = handleRefs.current[i]
      if (!el) return
      toggle(el, showMarquee)
      el.style.left = `${tl.x + bw * h.cx - HANDLE / 2}px`
      el.style.top = `${tl.y + bh * h.cy - HANDLE / 2}px`
    })

    // Warp handle — sits on the ribbon centerline; pull to stretch, push to bend
    const anchors = getStretchAnchors(p, bounds.width, bounds.height)
    const f = toS(anchors.mid.x, anchors.mid.y)
    toggle(flowRef.current, showFlow)
    if (flowRef.current) {
      flowRef.current.style.left = `${f.x - 14}px`
      flowRef.current.style.top = `${f.y - 14}px`
    }

    toggle(labelRef.current, showFlow)
    if (labelRef.current) {
      const imgW = Math.round(b.w * (img.width || 0))
      const imgH = Math.round(b.h * (img.height || 0))
      labelRef.current.textContent = `${imgW} × ${imgH}px source`
      labelRef.current.style.left = `${tl.x + bw / 2}px`
      labelRef.current.style.top = `${tl.y + bh + 10}px`
    }
  }, [])

  const scheduleFrame = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      try { renderPreview(); layoutOverlay() } catch (e) { console.error('[PixelStretch] render error:', e) }
    })
  }, [renderPreview, layoutOverlay])

  const armSettle = useCallback(() => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = 0
      interactingRef.current = false
      scheduleFrame() // crisp, high-slice pass once the user stops moving
    }, SETTLE_MS)
  }, [scheduleFrame])

  // Keep the async-callable refs current (used by the enter effect's source loader).
  useEffect(() => { scheduleFrameRef.current = scheduleFrame; ensureMatteRef.current = ensureSubjectMatte })

  // Live (drag/slider-preview) mutation — refs only, then an rAF redraw.
  const livePatch = useCallback((next) => {
    paramsRef.current = clampStretchParams({ ...paramsRef.current, ...next })
    interactingRef.current = true
    scheduleFrame()
    armSettle()
  }, [scheduleFrame, armSettle])

  const liveBand = useCallback((nextBand) => {
    livePatch({ band: { ...paramsRef.current.band, ...nextBand } })
  }, [livePatch])

  // Discrete / committed change — updates React state (panel reflects it).
  const commit = useCallback((next) => {
    paramsRef.current = clampStretchParams({ ...paramsRef.current, ...next })
    interactingRef.current = false
    if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = 0 }
    setParams(paramsRef.current)
  }, [])

  const applyPreset = useCallback((preset) => {
    setActivePresetId(preset.id)
    commit(preset.params)
  }, [commit])

  const resetParams = useCallback(() => {
    setActivePresetId(null)
    const base = { ...DEFAULT_STRETCH, axis: paramsRef.current.axis, band: paramsRef.current.band, polygon: paramsRef.current.polygon }
    if (warpMode) {
      // In warp mode, reset the grid to default positions but keep warp active
      base.warpGrid = createDefaultWarpGrid({ ...base })
      base.warpRest = getWarpRest({ ...base })
      setWarpPresetId(null)
      setWarpStrength(1)
    } else if (flowMode) {
      // In flow mode, reset to a fresh default spline but stay in flow mode.
      base.flowPath = createDefaultFlowPath({ ...base })
      setFlowPresetId(null)
      setFlowAnchorCount(base.flowPath?.anchors.length || 0)
    }
    commit(base)
  }, [commit, warpMode, flowMode])

  // ── Region phase transitions ──────────────────────────────────────────────
  const confirmRegion = useCallback(() => {
    let regionPatch
    if (selModeRef.current === 'lasso') {
      const pts = simplifyPolygon(lassoPtsRef.current, 0.008)
      if (pts.length < 3 || polygonArea(pts) < 0.002) { toast.error('Draw a region to stretch first'); return }
      lassoPtsRef.current = pts
      regionPatch = { band: getPolygonBBox(pts), polygon: pts }
    } else {
      regionPatch = { polygon: null } // rectangle: the band already is the region
    }
    // Land in the Photoshop-style warp box by default: corner anchors + bezier
    // handles over an identity mesh. The buffer shows the ORIGINAL pixels at rest
    // (length 1), so streaks only appear as the user DRAGS a handle — the reference
    // "pixel stretch" technique. Reset any prior simple/flow shape first.
    const base = clampStretchParams({ ...paramsRef.current, ...regionPatch, length: 1, bend: 0, twist: 0, flowPath: null })
    setWarpMode(true)
    setFlowMode(false)
    setWarpPresetId(null)
    setWarpStrength(1)
    setFlowPresetId(null)
    setActivePresetId(null)
    commit({ ...regionPatch, length: 1, bend: 0, twist: 0, flowPath: null, warpGrid: createDefaultWarpGrid(base), warpRest: getWarpRest(base) })
    setPhase('stretch')
  }, [commit])

  const reselect = useCallback(() => {
    if (selModeRef.current === 'lasso') lassoPtsRef.current = []
    setRegionReady(selModeRef.current === 'rect')
    setActivePresetId(null)
    setAiLoading(false)
    setWarpMode(false)
    setWarpPresetId(null)
    setWarpStrength(1)
    setFlowMode(false)
    setFlowPresetId(null)
    setFlowAnchorCount(0)
    commit({ polygon: null, length: 1, bend: 0, twist: 0, warpGrid: null, warpRest: null, flowPath: null })
    setPhase('select')
  }, [commit])

  const changeMode = useCallback((nextMode) => {
    if (nextMode === selModeRef.current) return
    selModeRef.current = nextMode
    setSelectionMode(nextMode)
    lassoPtsRef.current = []
    setActivePresetId(null)
    setRegionReady(nextMode === 'rect') // rect starts with a usable default band
    commit({ polygon: null })
    scheduleFrame()
  }, [commit, scheduleFrame])

  // ── SAM Auto Detect Subject ─────────────────────────────────────────────────
  const autoDetectSubject = useCallback(async () => {
    const img = selectedImageRef.current
    if (!img) { toast.error('Select an image layer first'); return }
    const srcEl = getSourceElement(img)
    if (!isSourceReady(srcEl)) { toast.error('Image is still loading'); return }

    setSamLoading(true)
    const toastId = toast.loading('Detecting subject on-device…')
    try {
      const natW = srcEl.naturalWidth || srcEl.width || 512
      const natH = srcEl.naturalHeight || srcEl.height || 512

      // Run RMBG-1.4 on-device (no API call) to get subject mask
      const matteCanvas = await clientSubjectMask(srcEl, { width: natW, height: natH })
      if (!matteCanvas) throw new Error('Subject detection returned empty result')

      // Trace the contour from the matte
      const result = traceContour(matteCanvas, { threshold: 0.5, simplifyEpsilon: 0.004, minPoints: 8 })
      if (!result || !result.polygon || result.polygon.length < 3) {
        throw new Error('Could not trace a clean subject boundary')
      }

      // Set the polygon as the lasso selection and auto-confirm — into the warp
      // box (identity mesh, original pixels) so streaks only appear once dragged.
      selModeRef.current = 'lasso'
      setSelectionMode('lasso')
      const pts = result.polygon
      const base = clampStretchParams({ ...paramsRef.current, band: result.bbox, polygon: pts, length: 1, bend: 0, twist: 0, flowPath: null })
      setWarpMode(true)
      setFlowMode(false)
      setWarpPresetId(null)
      setWarpStrength(1)
      setFlowPresetId(null)
      commit({ band: result.bbox, polygon: pts, length: 1, bend: 0, twist: 0, flowPath: null, warpGrid: createDefaultWarpGrid(base), warpRest: getWarpRest(base) })
      setPhase('stretch')
      setActivePresetId(null)

      toast.success(`Subject detected (${result.polygon.length} boundary points)`, { id: toastId, duration: 3000 })
    } catch (error) {
      console.error('[PixelStretch] SAM auto-detect failed:', error)
      toast.error(error?.message || 'Subject detection failed', { id: toastId })
    } finally {
      setSamLoading(false)
    }
  }, [commit])

  // ── Warp mesh controls ──────────────────────────────────────────────────────
  const resetWarpGrid = useCallback(() => {
    setWarpPresetId(null)
    setWarpStrength(1)
    commit({ warpGrid: createDefaultWarpGrid(paramsRef.current), warpRest: getWarpRest(paramsRef.current) })
  }, [commit])

  // Split-warp: add a row/column of control points → more curves, anywhere.
  const splitWarp = useCallback((axis) => {
    const grid = paramsRef.current.warpGrid
    if (!grid) return
    setWarpPresetId(null)
    commit({ warpGrid: addWarpSplit(grid, axis) })
  }, [commit])

  // Apply a named warp preset at the given strength (re-applied live by the slider).
  const applyWarp = useCallback((presetId, amount) => {
    setWarpPresetId(presetId)
    setWarpStrength(amount)
    const { grid, rest } = applyWarpPreset(paramsRef.current, presetId, amount)
    commit({ warpGrid: grid, warpRest: rest })
  }, [commit])

  // ── Mode switching (Simple / Flow Path / Mesh — mutually exclusive) ──────────
  const setStretchMode = useCallback((mode) => {
    setWarpPresetId(null); setWarpStrength(1); setFlowPresetId(null); setActivePresetId(null)
    if (mode === 'mesh') {
      setWarpMode(true); setFlowMode(false)
      commit({ warpGrid: createDefaultWarpGrid(paramsRef.current), warpRest: getWarpRest(paramsRef.current), flowPath: null })
    } else if (mode === 'flow') {
      setFlowMode(true); setWarpMode(false)
      const fp = createDefaultFlowPath(paramsRef.current)
      setFlowAnchorCount(fp?.anchors.length || 0)
      commit({ flowPath: fp, warpGrid: null, warpRest: null })
    } else {
      setWarpMode(false); setFlowMode(false)
      commit({ warpGrid: null, warpRest: null, flowPath: null })
    }
  }, [commit])

  // ── Flow Path controls ───────────────────────────────────────────────────────
  const resetFlow = useCallback(() => {
    setFlowPresetId(null)
    const fp = createDefaultFlowPath(paramsRef.current)
    setFlowAnchorCount(fp?.anchors.length || 0)
    commit({ flowPath: fp })
  }, [commit])

  const applyFlowPresetUI = useCallback((presetId) => {
    setFlowPresetId(presetId)
    const fp = applyFlowPreset(paramsRef.current, presetId)
    if (fp) { setFlowAnchorCount(fp.anchors.length); commit({ flowPath: fp }) }
  }, [commit])

  const smoothFlow = useCallback(() => {
    const fp = paramsRef.current.flowPath
    if (!fp) return
    const sm = smoothFlowPath(fp)
    setFlowPresetId(null); setFlowAnchorCount(sm.anchors.length); commit({ flowPath: sm })
  }, [commit])

  const setFlowWidthLive = useCallback((w) => {
    const fp = paramsRef.current.flowPath
    if (fp) livePatch({ flowPath: { ...fp, width: w } })
  }, [livePatch])
  const setFlowWidthCommit = useCallback((w) => {
    const fp = paramsRef.current.flowPath
    if (fp) { setFlowPresetId(null); commit({ flowPath: { ...fp, width: w } }) }
  }, [commit])

  const removeFlowPointAt = useCallback((idx) => {
    const fp = paramsRef.current.flowPath
    if (!fp) return
    const next = removeFlowAnchor(fp, idx)
    setFlowPresetId(null); setFlowAnchorCount(next.anchors.length); commit({ flowPath: next })
  }, [commit])

  // Double-click an anchor on the canvas to delete it.
  const onFlowDoubleClick = useCallback((e) => {
    const img = selectedImageRef.current
    const editor = editorRef.current
    const fp = paramsRef.current.flowPath
    if (!img || !editor || !fp || !containerRef.current) return
    const bounds = getImageCanvasBounds(img)
    const zX = editor.viewportTransform?.[0] || 1
    const zY = editor.viewportTransform?.[3] || 1
    const rect = containerRef.current.getBoundingClientRect()
    const vpt = editor.viewportTransform || [1, 0, 0, 1, 0, 0]
    const px = (e.clientX - rect.left - vpt[4]) / (vpt[0] || 1) - bounds.left
    const py = (e.clientY - rect.top - vpt[5]) / (vpt[3] || 1) - bounds.top
    let ni = -1, nd = Infinity
    fp.anchors.forEach((a, i) => {
      const d = Math.hypot(a.x * bounds.width - px, a.y * bounds.height - py)
      if (d < nd) { nd = d; ni = i }
    })
    if (ni >= 0 && nd <= 16 / Math.min(zX, zY)) removeFlowPointAt(ni)
  }, [removeFlowPointAt])

  // ── Layer placement (how the streaks sit relative to the subject) ────────────
  // `coverage` 0→1: above the subject → partially on it → behind it. Anything > 0
  // needs the on-device subject matte, so kick it off (once) and re-render.
  const setCoverageMode = useCallback(async (c) => {
    const next = Math.min(1, Math.max(0, c))
    setCoverage(next)
    coverageRef.current = next
    scheduleFrame()
    // Only auto-detect when there's no matte yet (a manual trace is authoritative).
    if (next > 0 && !subjectRawMatteRef.current && matteStatus !== 'loading') {
      const toastId = toast.loading('Detecting subject on-device…')
      const m = await ensureSubjectMatte()
      subjectCutoutRef.current = null
      scheduleFrame()
      if (m) toast.success('Subject detected — placement ready', { id: toastId, duration: 2200 })
      // No hard error: fall back to letting the user trace the subject by hand.
      else toast('No subject auto-detected — tap “Draw subject” to mark it', { id: toastId, icon: '✏️', duration: 3200 })
    }
  }, [ensureSubjectMatte, scheduleFrame, matteStatus])

  // ── AI Auto Stretch ─────────────────────────────────────────────────────────
  const autoStretch = useCallback(async () => {
    const img = selectedImageRef.current
    const editor = editorRef.current
    if (!img || !editor) { toast.error('Select an image layer first'); return }
    const srcEl = getSourceElement(img)
    if (!isSourceReady(srcEl)) { toast.error('Image is still loading'); return }

    setAiLoading(true)
    const toastId = toast.loading('AI is analyzing the image…')
    try {
      // Capture a small snapshot for the API (512px max edge, JPEG)
      const natW = srcEl.naturalWidth || srcEl.videoWidth || srcEl.width || 512
      const natH = srcEl.naturalHeight || srcEl.videoHeight || srcEl.height || 512
      const scale = Math.min(1, 512 / Math.max(natW, natH))
      const snapW = Math.max(1, Math.round(natW * scale))
      const snapH = Math.max(1, Math.round(natH * scale))

      const snapCanvas = document.createElement('canvas')
      snapCanvas.width = snapW
      snapCanvas.height = snapH
      const sctx = snapCanvas.getContext('2d')
      sctx.drawImage(srcEl, 0, 0, snapW, snapH)

      let base64
      try {
        const dataUrl = snapCanvas.toDataURL('image/jpeg', 0.85)
        base64 = dataUrl.split(',')[1]
      } catch {
        throw new Error('Could not capture image snapshot (cross-origin?)')
      }

      // Try the AI planner; if the route/model is unavailable, fall back to the
      // on-device heuristic analyser so Auto Stretch always works.
      let plan = null
      let offline = false
      try {
        const response = await fetch('/api/ai/stretch-plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: base64, mimeType: 'image/jpeg', width: natW, height: natH }),
        })
        const data = await response.json().catch(() => null)
        if (response.ok && data?.success && data?.plan) plan = data.plan
        else throw new Error(data?.error || `stretch-plan ${response.status}`)
      } catch (apiErr) {
        console.warn('[PixelStretch] AI route unavailable — using on-device planner:', apiErr?.message)
        plan = analyzeStretchPlan(snapCanvas)
        offline = true
      }
      if (!plan) throw new Error('Could not analyze this image')

      // Prefer the AI/heuristic FLOW PATH when present (best-in-class control —
      // the streak follows a routed multi-anchor spline); otherwise fall back to
      // the classic simple sweep. Either way we land in the 'stretch' phase.
      const planPoints = Array.isArray(plan.flowPath) ? plan.flowPath : null
      const flow = planPoints && planPoints.length >= 2
        ? createFlowPathFromPoints(planPoints, plan.flowWidth ? { width: plan.flowWidth } : {})
        : null
      if (flow) {
        commit({
          band: plan.region, axis: plan.axis, direction: plan.direction,
          fade: plan.fade, taper: plan.taper, opacity: plan.opacity,
          polygon: null, warpGrid: null, warpRest: null, flowPath: flow,
        })
        setFlowMode(true)
        setFlowPresetId(null)
        setFlowAnchorCount(flow.anchors.length)
        setWarpMode(false)
      } else {
        commit({
          band: plan.region, axis: plan.axis, direction: plan.direction,
          length: plan.length, bend: plan.bend, twist: plan.twist,
          fade: plan.fade, taper: plan.taper, mirror: plan.mirror,
          seed: plan.seed, opacity: plan.opacity,
          polygon: null, warpGrid: null, warpRest: null, flowPath: null,
        })
        setWarpMode(false)
        setFlowMode(false)
      }
      setActivePresetId(null)
      setPhase('stretch')

      toast.success(`${offline ? 'On-device · ' : ''}${plan.reasoning || 'AI stretch plan applied'}`, { id: toastId, duration: 4500 })
    } catch (error) {
      console.error('[PixelStretch] AI auto-stretch failed:', error)
      toast.error(error?.message || 'AI analysis failed', { id: toastId })
    } finally {
      setAiLoading(false)
    }
  }, [commit])

  // ── Enter / exit the tool ────────────────────────────────────────────────────
  useEffect(() => {
    if (!active || !canvasEditor) return

    // Reset placement / matte / source caches for a fresh session.
    subjectRawMatteRef.current = null
    subjectMatteSigRef.current = ''
    subjectCutoutRef.current = null
    matteIsManualRef.current = false
    subjectPickRef.current = false
    setSubjectMaskKind('none')
    setSubjectPicking(false)
    sampleElRef.current = null
    sampleFlipRef.current = { x: false, y: false }
    editingLayerRef.current = null
    sourceMetaRef.current = null
    setMatteStatus('idle')
    setActivePresetId(null)
    setAiLoading(false)
    setWarpPresetId(null)
    setWarpStrength(1)
    setFlowPresetId(null)
    lassoPtsRef.current = []
    lassoDrawingRef.current = false

    // Re-edit when the selected object is an EXISTING stretch layer; else start a
    // new stretch on the selected photo.
    const activeObj = canvasEditor.getActiveObject?.()
    const editMeta = (activeObj && isImageObject(activeObj) && activeObj.visible !== false)
      ? activeObj.data?.pixelStretch : null

    let img
    if (editMeta) {
      img = activeObj
      editingLayerRef.current = activeObj
      sourceMetaRef.current = {
        src: editMeta.sourceSrc, w: editMeta.sourceW, h: editMeta.sourceH,
        flipX: !!editMeta.sourceFlipX, flipY: !!editMeta.sourceFlipY,
      }
      sampleFlipRef.current = { x: !!editMeta.sourceFlipX, y: !!editMeta.sourceFlipY }
      paramsRef.current = clampStretchParams(editMeta.params || DEFAULT_STRETCH)
      setParams(paramsRef.current)
      const cov = Math.min(1, Math.max(0, editMeta.coverage || 0))
      setCoverage(cov); coverageRef.current = cov
      featherRef.current = editMeta.feather || 0.006
      setIsEditingLayer(true)
      setWarpMode(!!paramsRef.current.warpGrid)
      setFlowMode(!!paramsRef.current.flowPath)
      setFlowAnchorCount(paramsRef.current.flowPath?.anchors.length || 0)
      setPhase('stretch')
      setRegionReady(true)
      // Load the ORIGINAL photo (stored URL) to sample the stretch from.
      if (editMeta.sourceSrc) {
        const el = new Image()
        el.crossOrigin = 'anonymous'
        el.onload = () => {
          if (selectedImageRef.current !== activeObj) return
          sampleElRef.current = el
          sampleRef.current = null; sampleSigRef.current = ''
          canvasEditor.requestRenderAll?.()
          scheduleFrameRef.current?.()
          if (coverageRef.current > 0) ensureMatteRef.current?.().then(() => scheduleFrameRef.current?.())
        }
        el.onerror = () => toast.error('Could not load the original photo for this stretch layer')
        el.src = editMeta.sourceSrc
      }
    } else {
      img = getActiveImage(canvasEditor)
      editingLayerRef.current = null
      paramsRef.current = clampStretchParams(DEFAULT_STRETCH)
      setParams(paramsRef.current)
      setCoverage(0); coverageRef.current = 0
      featherRef.current = 0.006
      setIsEditingLayer(false)
      setWarpMode(false)
      setFlowMode(false)
      setFlowAnchorCount(0)
      setPhase('select')
      setRegionReady(selModeRef.current === 'rect')
      if (img) {
        sourceMetaRef.current = {
          src: img.getSrc?.() || getSourceElement(img)?.src || null,
          w: img.width, h: img.height, flipX: !!img.flipX, flipY: !!img.flipY,
        }
      }
    }

    selectedImageRef.current = img || null
    setSelectedImage(img || null)
    if (!img) return

    img.__stretchUid = ++uidCounter
    lockImage(img)
    const prevSelection = canvasEditor.selection
    canvasEditor.selection = false
    canvasEditor.discardActiveObject?.()
    canvasEditor.requestRenderAll()

    sampleRef.current = null
    sampleSigRef.current = ''
    interactingRef.current = false

    return () => {
      unlockImage()
      canvasEditor.selection = prevSelection
      try { canvasEditor.requestRenderAll() } catch { /* canvas may already be disposed */ }
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
      if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = 0 }
      draggingRef.current = null
    }
  }, [active, canvasEditor, lockImage, unlockImage])

  // ── Track viewport (pan/zoom) + window resize → imperative redraw ────────────
  useEffect(() => {
    if (!active || !canvasEditor) return
    const onRender = () => {
      const sig = (canvasEditor.viewportTransform || []).join(',')
      if (sig !== vptSigRef.current) {
        vptSigRef.current = sig
        sampleSigRef.current = '' // zoom changed → rebuild sample at the new resolution
      }
      scheduleFrame()
    }
    canvasEditor.on('after:render', onRender)
    window.addEventListener('resize', onRender)
    scheduleFrame()
    return () => {
      canvasEditor.off('after:render', onRender)
      window.removeEventListener('resize', onRender)
    }
  }, [active, canvasEditor, scheduleFrame])

  // Reposition + redraw whenever committed params / selection change.
  useLayoutEffect(() => {
    if (active && selectedImage) { layoutOverlay(); scheduleFrame() }
  }, [params, phase, selectionMode, active, selectedImage, containerEl, layoutOverlay, scheduleFrame])

  // ── Pointer → normalized image coords (absolute) ─────────────────────────────
  const screenToNorm = useCallback((clientX, clientY) => {
    const editor = editorRef.current
    const img = selectedImageRef.current
    const container = containerRef.current
    const bounds = getImageCanvasBounds(img)
    if (!editor || !bounds || !container) return { x: 0, y: 0 }
    const rect = container.getBoundingClientRect()
    const vpt = editor.viewportTransform || [1, 0, 0, 1, 0, 0]
    const canvasX = (clientX - rect.left - vpt[4]) / (vpt[0] || 1)
    const canvasY = (clientY - rect.top - vpt[5]) / (vpt[3] || 1)
    return {
      x: Math.min(Math.max((canvasX - bounds.left) / bounds.width, 0), 1),
      y: Math.min(Math.max((canvasY - bounds.top) / bounds.height, 0), 1),
    }
  }, [])

  // ── Pointer interaction (draw marquee / move / resize / warp) ────────────────
  const onPointerDown = useCallback((e, type, handleId) => {
    const img = selectedImageRef.current
    const editor = editorRef.current
    if (!img || !editor) return
    e.preventDefault()
    e.stopPropagation()

    // ── Lasso: collect a freeform path, simplify + validate it on release ──
    if (type === 'lasso') {
      lassoDrawingRef.current = true
      lassoPtsRef.current = [screenToNorm(e.clientX, e.clientY)]
      setRegionReady(false)
      setActivePresetId(null)
      interactingRef.current = true
      const onMove = (ev) => {
        const pt = screenToNorm(ev.clientX, ev.clientY)
        const pts = lassoPtsRef.current
        const last = pts[pts.length - 1]
        if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) >= 0.004) {
          pts.push(pt)
          scheduleFrame()
        }
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        lassoDrawingRef.current = false
        interactingRef.current = false
        const simplified = simplifyPolygon(lassoPtsRef.current, 0.008)
        const ok = simplified.length >= 3 && polygonArea(simplified) >= 0.002
        // Tracing the front-subject region (placement) — not the source band.
        if (subjectPickRef.current) {
          subjectPickRef.current = false
          setSubjectPicking(false)
          lassoPtsRef.current = []
          if (ok) finishSubjectPick(simplified)
          else { toast.error('Trace a larger area around the subject'); scheduleFrame() }
          return
        }
        lassoPtsRef.current = ok ? simplified : []
        setRegionReady(ok)
        scheduleFrame()
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      return
    }

    // ── Warp: grab the nearest control point and drag it ──
    if (type === 'warp') {
      const wp = paramsRef.current
      if (!wp.warpGrid) return
      const bounds = getImageCanvasBounds(img)
      const zX = editor.viewportTransform?.[0] || 1
      const zY = editor.viewportTransform?.[3] || 1
      const handles = getWarpGridHandles(wp, bounds.width, bounds.height) || []
      // Unclamped click → image-relative canvas px (handles may sit off-image).
      const rect = containerRef.current.getBoundingClientRect()
      const vpt = editor.viewportTransform || [1, 0, 0, 1, 0, 0]
      const clickPx = {
        x: (e.clientX - rect.left - vpt[4]) / (vpt[0] || 1) - bounds.left,
        y: (e.clientY - rect.top - vpt[5]) / (vpt[3] || 1) - bounds.top,
      }
      let best = null, bestDist = Infinity
      for (const h of handles) {
        const dist = Math.hypot(h.x - clickPx.x, h.y - clickPx.y)
        if (dist < bestDist) { bestDist = dist; best = h }
      }
      // Generous hit radius (touch-friendly), in image-pixel space.
      if (!best || bestDist > 20 / Math.min(zX, zY)) return
      const { row, col } = best
      const origGrid = wp.warpGrid.map((r) => r.map((pt) => ({ ...pt })))
      const R = origGrid.length, C = origGrid[0].length
      // Dragging an ANCHOR carries its tangent handles (the 4-neighbours) so the
      // local shape translates rigidly — exactly how Photoshop moves a corner.
      const moves = [[row, col]]
      if (best.kind === 'anchor') {
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = row + dr, nc = col + dc
          if (nr >= 0 && nr < R && nc >= 0 && nc < C) moves.push([nr, nc])
        }
      }
      const startX = e.clientX, startY = e.clientY
      interactingRef.current = true
      setActivePresetId(null)
      setWarpPresetId(null) // hand-edited → no preset is "active" anymore
      const onMove = (ev) => {
        const dxN = (ev.clientX - startX) / zX / bounds.width
        const dyN = (ev.clientY - startY) / zY / bounds.height
        const newGrid = origGrid.map((r) => r.map((pt) => ({ ...pt })))
        for (const [mr, mc] of moves) {
          newGrid[mr][mc] = { x: origGrid[mr][mc].x + dxN, y: origGrid[mr][mc].y + dyN }
        }
        livePatch({ warpGrid: newGrid })
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        commit({})
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      return
    }

    // ── Flow Path: drag an anchor / tangent handle, or click the spline to add ──
    if (type === 'flowpath') {
      if (!paramsRef.current.flowPath) return
      const bounds = getImageCanvasBounds(img)
      const zX = editor.viewportTransform?.[0] || 1
      const zY = editor.viewportTransform?.[3] || 1
      const rect = containerRef.current.getBoundingClientRect()
      const vpt = editor.viewportTransform || [1, 0, 0, 1, 0, 0]
      const clickPx = {
        x: (e.clientX - rect.left - vpt[4]) / (vpt[0] || 1) - bounds.left,
        y: (e.clientY - rect.top - vpt[5]) / (vpt[3] || 1) - bounds.top,
      }
      const minZ = Math.min(zX, zY)
      const handles = getFlowPathHandles(paramsRef.current, bounds.width, bounds.height) || []
      let best = null, bestDist = Infinity
      for (const h of handles) {
        const d = Math.hypot(h.x - clickPx.x, h.y - clickPx.y)
        if (d < bestDist) { bestDist = d; best = h }
      }
      setFlowPresetId(null)

      // No control hit → if the click lands on the spline, insert an anchor there
      // and grab it; otherwise ignore the press.
      if (!best || bestDist > 16 / minZ) {
        const curve = getFlowPathCurve(paramsRef.current, bounds.width, bounds.height, 48) || []
        let cd = Infinity
        for (const c of curve) { const d = Math.hypot(c.x - clickPx.x, c.y - clickPx.y); if (d < cd) cd = d }
        if (cd > 14 / minZ) return
        const next = insertFlowAnchor(paramsRef.current.flowPath, clickPx.x / bounds.width, clickPx.y / bounds.height, bounds.width, bounds.height)
        commit({ flowPath: next })
        setFlowAnchorCount(next.anchors.length)
        let ni = 0, nd = Infinity
        next.anchors.forEach((a, i) => {
          const d = Math.hypot(a.x * bounds.width - clickPx.x, a.y * bounds.height - clickPx.y)
          if (d < nd) { nd = d; ni = i }
        })
        best = { idx: ni, kind: 'anchor' }
      }

      const idx = best.idx, kind = best.kind
      const origPath = { ...paramsRef.current.flowPath, anchors: paramsRef.current.flowPath.anchors.map((a) => ({ ...a })) }
      const startX = e.clientX, startY = e.clientY
      interactingRef.current = true
      const onMove = (ev) => {
        const dxN = (ev.clientX - startX) / zX / bounds.width
        const dyN = (ev.clientY - startY) / zY / bounds.height
        const anchors = origPath.anchors.map((a) => ({ ...a }))
        const a = anchors[idx], o = origPath.anchors[idx]
        if (kind === 'anchor') {
          a.x = o.x + dxN; a.y = o.y + dyN  // handles are relative offsets → ride along
        } else if (kind === 'out') {
          a.hox = o.hox + dxN; a.hoy = o.hoy + dyN
          if (idx > 0) { a.hix = -a.hox; a.hiy = -a.hoy }  // keep the anchor smooth (G1)
        } else {
          a.hix = o.hix + dxN; a.hiy = o.hiy + dyN
          if (idx < anchors.length - 1) { a.hox = -a.hix; a.hoy = -a.hiy }
        }
        livePatch({ flowPath: { ...origPath, anchors } })
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        commit({})
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      return
    }

    const bounds = getImageCanvasBounds(img)
    const p = paramsRef.current
    const d = {
      type, handleId,
      zX: editor.viewportTransform?.[0] || 1,
      zY: editor.viewportTransform?.[3] || 1,
      bounds,
      startX: e.clientX, startY: e.clientY,
      startBand: { ...p.band },
      startLength: p.length, startBend: p.bend,
      axis: p.axis, direction: p.direction,
      origin: type === 'draw' ? screenToNorm(e.clientX, e.clientY) : null,
      moved: false,
    }

    draggingRef.current = d
    interactingRef.current = true
    if (type === 'draw') setActivePresetId(null)

    const onMove = (ev) => {
      const drag = draggingRef.current
      if (!drag) return
      drag.moved = true
      const dxN = (ev.clientX - drag.startX) / drag.zX / drag.bounds.width
      const dyN = (ev.clientY - drag.startY) / drag.zY / drag.bounds.height

      if (drag.type === 'draw') {
        const cur = screenToNorm(ev.clientX, ev.clientY)
        liveBand({
          x: Math.min(drag.origin.x, cur.x),
          y: Math.min(drag.origin.y, cur.y),
          w: Math.max(Math.abs(cur.x - drag.origin.x), 0.001),
          h: Math.max(Math.abs(cur.y - drag.origin.y), 0.001),
        })
      } else if (drag.type === 'move') {
        const b = drag.startBand
        liveBand({
          x: Math.min(Math.max(b.x + dxN, 0), 1 - b.w),
          y: Math.min(Math.max(b.y + dyN, 0), 1 - b.h),
        })
      } else if (drag.type === 'resize') {
        let { x, y, w, h } = drag.startBand
        const hid = drag.handleId
        if (hid.includes('l')) { const nx = Math.min(Math.max(x + dxN, 0), x + w - MIN_BAND); w += x - nx; x = nx }
        if (hid.includes('r')) { w = Math.min(Math.max(w + dxN, MIN_BAND), 1 - x) }
        if (hid.includes('t')) { const ny = Math.min(Math.max(y + dyN, 0), y + h - MIN_BAND); h += y - ny; y = ny }
        if (hid.includes('b')) { h = Math.min(Math.max(h + dyN, MIN_BAND), 1 - y) }
        liveBand({ x, y, w, h })
      } else if (drag.type === 'flow') {
        // ── Simple mode: length + bend from drag ──
        const vertical = drag.axis === 'vertical'
        const dAxis = vertical ? ((ev.clientY - drag.startY) / drag.zY) * drag.direction : ((ev.clientX - drag.startX) / drag.zX) * drag.direction
        const dPerp = vertical ? (ev.clientX - drag.startX) / drag.zX : (ev.clientY - drag.startY) / drag.zY
        const axisExtent = Math.max(1, vertical ? drag.startBand.h * drag.bounds.height : drag.startBand.w * drag.bounds.width)
        setActivePresetId(null)
        livePatch({
          length: drag.startLength + dAxis / axisExtent,
          bend: drag.startBend + (dPerp / axisExtent) * 1.4,
        })
      }
    }
    const onUp = () => {
      const drag = draggingRef.current
      draggingRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      // A draw that never moved (a click) or is degenerate → revert to prior band.
      if (drag?.type === 'draw') {
        const nb = paramsRef.current.band
        if (!drag.moved || nb.w < MIN_BAND || nb.h < MIN_BAND) {
          commit({ band: drag.startBand })
          return
        }
      }
      commit({}) // sync React state + trigger the crisp settle pass
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [liveBand, livePatch, commit, screenToNorm, scheduleFrame, finishSubjectPick])

  // ── Commit: bake the stretch as its OWN layer over the photo (non-destructive) ─
  // Instead of replacing the photo, the ribbons are baked onto a TRANSPARENT layer
  // that sits just above the source. `coverage` knocks the detected subject out of
  // that layer so the photo's subject shows through ("partially / below" it). The
  // layer is a normal image — crop / colour-grade / move it with the other tools —
  // and re-selecting it re-enters this tool with the stored params (data.pixelStretch).
  const applyStretch = useCallback(async () => {
    const editor = editorRef.current
    const frameObj = selectedImageRef.current        // defines WHERE the stretch sits
    if (!editor || !frameObj) { toast.error('Select an image layer first'); return }
    const srcEl = sampleElRef.current || getSourceElement(frameObj)
    if (!isSourceReady(srcEl)) { toast.error('Image is still loading — try again in a moment'); return }

    setApplying(true)
    const wasEditing = !!editingLayerRef.current
    const toastId = toast.loading(wasEditing ? 'Updating stretch layer…' : 'Adding stretch layer…')
    try {
      const natW = srcEl.naturalWidth || srcEl.videoWidth || srcEl.width
      const natH = srcEl.naturalHeight || srcEl.videoHeight || srcEl.height
      if (!natW || !natH) throw new Error('Image has no dimensions')

      const sf = Math.min(1, MAX_BAKE_DIM / Math.max(natW, natH))
      const W = Math.max(1, Math.round(natW * sf))
      const H = Math.max(1, Math.round(natH * sf))
      const p = paramsRef.current
      const flipX = sampleElRef.current ? sampleFlipRef.current.x : frameObj.flipX
      const flipY = sampleElRef.current ? sampleFlipRef.current.y : frameObj.flipY
      const cov = coverageRef.current

      // Bake ONLY the ribbons onto a transparent buffer — the base photo remains its
      // own layer below. For partial/below placement, knock the subject out so the
      // photo's subject reads in front of the streaks.
      const sample = snapshotSource(srcEl, W, H, flipX, flipY)
      const out = createStretchBuffer(W, H)
      const octx = out.getContext('2d')
      const drew = renderPixelStretch(octx, sample, p, W, H, { quality: 'max' })
      if (!drew) throw new Error('Nothing to stretch yet — set a region or shape first')
      if (cov > 0) {
        const matte = await ensureSubjectMatte()
        if (matte) {
          const alpha = matteToAlphaCanvas(matte, W, H, featherRef.current * Math.min(W, H))
          applySubjectKnockout(octx, alpha, W, H, cov)
        }
      }

      let blob
      try { blob = await encodeToPngBlob(out) }
      catch (encodeErr) {
        if (encodeErr?.name === 'SecurityError') throw new Error('This image is cross-origin and can’t be exported. Re-import it into the project first.')
        throw encodeErr
      }
      const url = await uploadStretchBlob(blob, W, H)

      // Keep the stretch a fully INDEPENDENT entity from the photo: persist a
      // DURABLE copy of the source so the layer stays re-editable even after the
      // image is deleted. Remote (http) sources are already durable; a freshly
      // dropped-in image (blob:/data:) is snapshotted to ImageKit once (unflipped
      // — re-edit re-applies the stored flip).
      let durableSrc = sourceMetaRef.current?.src || frameObj.getSrc?.() || srcEl.src || null
      if (!(typeof durableSrc === 'string' && /^https?:\/\//i.test(durableSrc))) {
        const srcSnap = snapshotSource(srcEl, W, H, false, false)
        const srcBlob = await encodeToPngBlob(srcSnap)
        durableSrc = await uploadStretchBlob(srcBlob, W, H)
      }

      const meta = {
        version: 1,
        params: p,
        coverage: cov,
        feather: featherRef.current,
        sourceSrc: durableSrc,
        sourceW: natW, sourceH: natH,
        sourceFlipX: flipX, sourceFlipY: flipY,
      }
      // Cache the durable URL so re-applies this session don't re-upload it.
      sourceMetaRef.current = { src: durableSrc, w: natW, h: natH, flipX, flipY }

      if (editingLayerRef.current) {
        // Re-edit: swap the layer's pixels, keep its transforms / filters / crop.
        const layer = editingLayerRef.current
        const prevScaledW = (layer.width || W) * Math.abs(layer.scaleX || 1)
        const prevScaledH = (layer.height || H) * Math.abs(layer.scaleY || 1)
        await layer.setSrc(url, { crossOrigin: 'anonymous' })
        const newW = layer.width || W, newH = layer.height || H
        layer.set({ scaleX: prevScaledW / newW, scaleY: prevScaledH / newH, flipX: false, flipY: false })
        layer.data = { ...(layer.data || {}), pixelStretch: meta }
        if (layer.filters?.length) layer.applyFilters()
        layer.setCoords()
      } else {
        // New: add the stretch as its own layer, just above the source photo.
        const newImg = await FabricImage.fromURL(url, { crossOrigin: 'anonymous' })
        const srcScaledW = (frameObj.width || W) * Math.abs(frameObj.scaleX || 1)
        const srcScaledH = (frameObj.height || H) * Math.abs(frameObj.scaleY || 1)
        newImg.set({
          left: frameObj.left, top: frameObj.top,
          originX: frameObj.originX, originY: frameObj.originY,
          angle: frameObj.angle || 0,
          flipX: false, flipY: false,
          scaleX: srcScaledW / W, scaleY: srcScaledH / H,
          opacity: frameObj.opacity ?? 1,
          selectable: true, evented: true, hasControls: true, hasBorders: true,
          name: 'Pixel Stretch',
          data: { pixelStretch: meta },
        })
        newImg.__stretchUid = ++uidCounter
        const idx = editor.getObjects().indexOf(frameObj)
        if (idx >= 0) editor.insertAt(idx + 1, newImg)
        else editor.add(newImg)
        newImg.setCoords()
        editingLayerRef.current = newImg
      }

      setIsEditingLayer(true)
      interactingRef.current = false
      editor.requestRenderAll()
      editor.__pushHistoryState?.({ label: wasEditing ? 'Edit pixel stretch' : 'Pixel stretch layer', domain: 'pixel-stretch' })
      editor.__saveCanvasState?.()
      scheduleFrame()
      toast.success(wasEditing ? 'Stretch layer updated' : 'Pixel stretch added as a layer', { id: toastId })
    } catch (error) {
      console.error('[PixelStretch] apply failed:', error)
      toast.error(error?.message || 'Failed to apply pixel stretch', { id: toastId })
    } finally {
      setApplying(false)
    }
  }, [ensureSubjectMatte, scheduleFrame])

  // ── Keyboard: Enter = apply, Esc = reset (ignored while typing) ──────────────
  useEffect(() => {
    if (!active) return
    const onKey = (e) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (e.key === 'Enter') {
        e.preventDefault()
        if (phaseRef.current === 'select') confirmRegion()
        else applyStretch()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (phaseRef.current === 'stretch') reselect()
        else { lassoPtsRef.current = []; setRegionReady(selModeRef.current === 'rect'); scheduleFrame() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, applyStretch, resetParams, confirmRegion, reselect, scheduleFrame])

  // ── Overlay (portal) — marquee + dark mask + warp handle ────────────────────
  const overlay = (active && containerEl && selectedImage) ? createPortal(
    <div style={{ position: 'absolute', inset: 0, zIndex: 50, pointerEvents: 'none', overflow: 'hidden' }}>
      <style>{`
        @keyframes psMarch { to { background-position: 16px 0, -16px 100%, 0 -16px, 100% 16px; } }
      `}</style>

      {/* Draw surface — drag on the image to lasso a freeform region or marquee a rectangle */}
      <div
        ref={drawSurfaceRef}
        onPointerDown={(e) => onPointerDown(e, (subjectPickRef.current || selModeRef.current === 'lasso') ? 'lasso' : 'draw')}
        style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, zIndex: 55, cursor: 'crosshair', pointerEvents: 'auto', touchAction: 'none' }}
      />

      {/* Warp surface — grab any of the R×C control points during Advanced warp */}
      <div
        ref={warpSurfaceRef}
        onPointerDown={(e) => onPointerDown(e, 'warp')}
        style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, zIndex: 54, cursor: 'grab', pointerEvents: 'auto', touchAction: 'none', display: 'none' }}
      />

      {/* Flow surface — drag anchors/handles, click the spline to add, dbl-click an anchor to remove */}
      <div
        ref={flowSurfaceRef}
        onPointerDown={(e) => onPointerDown(e, 'flowpath')}
        onDoubleClick={onFlowDoubleClick}
        style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, zIndex: 54, cursor: 'crosshair', pointerEvents: 'auto', touchAction: 'none', display: 'none' }}
      />

      {/* Dark overlay — dims everything outside the selection */}
      {[0, 1, 2, 3].map((i) => (
        <div key={`dim-${i}`} ref={(el) => { dimRefs.current[i] = el }} style={{ position: 'absolute', background: DIM_BG, pointerEvents: 'none' }} />
      ))}

      {/* Preview canvas — the live stretch effect, drawn over the dim */}
      <canvas ref={previewCanvasRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />

      {/* Selection band — drag to move; marching-ants child shows it's the source */}
      <div
        ref={bandRef}
        onPointerDown={(e) => onPointerDown(e, 'move')}
        style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, cursor: 'move', pointerEvents: 'auto', boxSizing: 'border-box', boxShadow: `0 0 0 1px ${accent}99, 0 0 22px ${accent}55` }}
      >
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          backgroundImage: 'repeating-linear-gradient(90deg,#fff 0 8px,transparent 8px 16px),repeating-linear-gradient(90deg,#fff 0 8px,transparent 8px 16px),repeating-linear-gradient(0deg,#fff 0 8px,transparent 8px 16px),repeating-linear-gradient(0deg,#fff 0 8px,transparent 8px 16px)',
          backgroundSize: '16px 1.5px,16px 1.5px,1.5px 16px,1.5px 16px',
          backgroundRepeat: 'repeat-x,repeat-x,repeat-y,repeat-y',
          backgroundPosition: '0 0,0 100%,0 0,100% 0',
          animation: 'psMarch .5s linear infinite',
          filter: 'drop-shadow(0 0 1px rgba(0,0,0,.85))',
        }} />
      </div>

      {/* Resize handles */}
      {HANDLE_DEFS.map((h, i) => (
        <div
          key={h.id}
          ref={(el) => { handleRefs.current[i] = el }}
          onPointerDown={(e) => onPointerDown(e, 'resize', h.id)}
          style={{
            position: 'absolute', left: 0, top: 0, width: HANDLE, height: HANDLE,
            background: '#fff', border: `2px solid ${accent}`,
            borderRadius: h.id.length === 2 ? 3 : '50%',
            cursor: h.cur, pointerEvents: 'auto', zIndex: 52,
            boxShadow: '0 1px 5px rgba(0,0,0,0.5)', touchAction: 'none',
            transition: `transform 0.2s ${EASE}`,
          }}
        />
      ))}

      {/* Warp handle — pull to stretch, push sideways to bend the streaks */}
      <div
        ref={flowRef}
        onPointerDown={(e) => onPointerDown(e, 'flow')}
        title="Pull to stretch · push sideways to bend"
        style={{
          position: 'absolute', left: 0, top: 0, width: 28, height: 28, borderRadius: '50%',
          background: accent, border: '2.5px solid #fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'grab', pointerEvents: 'auto', zIndex: 53,
          boxShadow: `0 0 0 4px ${accent}33, 0 0 16px ${accent}88, 0 2px 10px rgba(0,0,0,0.55)`,
          touchAction: 'none', transition: `transform 0.2s ${EASE}`,
        }}
      >
        <Sparkles className="h-3.5 w-3.5" style={{ color: onAccent }} />
      </div>

      {/* Source-size label */}
      <div
        ref={labelRef}
        style={{
          position: 'absolute', transform: 'translateX(-50%)',
          background: 'rgba(4,6,10,0.82)', color: '#fff',
          fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em',
          padding: '3px 9px', borderRadius: 6, pointerEvents: 'none',
          whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace', zIndex: 52,
          border: `1px solid ${accent}55`, boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
        }}
      />
    </div>,
    containerEl,
  ) : null

  // ── Panel UI ────────────────────────────────────────────────────────────────
  if (!canvasEditor) {
    return <div className="p-4"><p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Canvas not ready</p></div>
  }

  if (!selectedImage) {
    return (
      <div className="panel-card flex flex-col items-center justify-center gap-3 text-center">
        <AudioLines className="h-6 w-6" style={{ color: accent }} />
        <div>
          <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>Select an image layer</p>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Add or click an image on the canvas to start stretching pixels.
          </p>
        </div>
      </div>
    )
  }

  const pct = (v) => Math.round(v * 100)
  const sliderVisual = { fill: `${accent}55`, accent, trackBg: 'rgba(18, 22, 30, 0.96)' }
  const sliderCommit = (key, raw, scale = 100) => { setActivePresetId(null); commit({ [key]: raw / scale }) }
  const cardStyle = { boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)' }
  const tapClass = 'active:scale-[0.98]'

  return (
    <div className="space-y-3.5">
      {overlay}

      {/* Region selection — pick a tool, draw, confirm */}
      <div className="panel-card" style={{ ...cardStyle, borderColor: `${accent}30` }}>
        <label className="panel-label">Selection Tool</label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {[
            { id: 'lasso', label: 'Lasso', Icon: Lasso },
            { id: 'rect', label: 'Rectangle', Icon: Square },
          ].map(({ id, label, Icon }) => {
            const on = selectionMode === id
            return (
              <button
                key={id}
                type="button"
                disabled={phase === 'stretch'}
                onClick={() => changeMode(id)}
                className={`flex h-9 items-center justify-center gap-2 rounded-lg text-xs font-medium editor-interactive disabled:opacity-40 ${tapClass}`}
                style={{ background: on ? accent : 'var(--bg-elevated)', color: on ? onAccent : 'var(--text-secondary)', border: on ? 'none' : '1px solid var(--border-subtle)', transition: `all 0.25s ${EASE}` }}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            )
          })}
        </div>

        {phase === 'select' ? (
          <>
            <p className="mt-2.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {selectionMode === 'lasso' ? (
                <><span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Draw a freeform shape</span> around the area you want to smear, then confirm to stretch it.</>
              ) : (
                <><span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Drag a rectangle</span> over the area you want to smear, then confirm to stretch it.</>
              )}
            </p>
            <div className="mt-2.5 flex gap-2">
              {selectionMode === 'lasso' && (
                <button
                  type="button"
                  onClick={() => { lassoPtsRef.current = []; setRegionReady(false); scheduleFrame() }}
                  className={`flex h-10 flex-1 items-center justify-center gap-2 rounded-xl text-xs font-semibold editor-interactive ${tapClass}`}
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={confirmRegion}
                disabled={!regionReady}
                className={`flex h-10 flex-[2] items-center justify-center gap-2 rounded-xl text-xs font-semibold editor-interactive disabled:opacity-40 ${tapClass}`}
                style={{ background: accent, color: onAccent, border: 'none', boxShadow: `0 0 28px ${accent}45`, transition: `all 0.25s ${EASE}` }}
              >
                <Check className="h-3.5 w-3.5" />
                Confirm Region
              </button>
            </div>

            {/* ── Use the subject's shape as the SOURCE region (on-device SAM) ── */}
            <div style={{
              marginTop: 12, padding: '10px 12px', borderRadius: 12,
              background: 'linear-gradient(135deg, rgba(16,185,129,0.12), rgba(6,182,212,0.12))',
              border: '1px solid rgba(16,185,129,0.25)',
            }}>
              <div className="flex items-center gap-2 mb-2">
                <ScanSearch className="h-3.5 w-3.5" style={{ color: '#34d399' }} />
                <span className="text-[11px] font-semibold" style={{ color: '#34d399' }}>Stretch the subject’s shape</span>
              </div>
              <p className="text-[10.5px] leading-relaxed mb-2.5" style={{ color: 'var(--text-muted)' }}>
                Detects the main subject on-device (no API calls) and uses its outline as the region to smear. To put streaks <em>behind</em> a subject instead, set that in <strong style={{ color: 'var(--text-secondary)' }}>Placement</strong> after confirming.
              </p>
              <button
                type="button"
                onClick={autoDetectSubject}
                disabled={samLoading || applying}
                className={`flex h-10 w-full items-center justify-center gap-2 rounded-xl text-xs font-semibold editor-interactive disabled:opacity-50 ${tapClass}`}
                style={{
                  background: samLoading ? 'rgba(16,185,129,0.2)' : 'linear-gradient(135deg, #10b981, #06b6d4)',
                  color: '#fff', border: 'none',
                  boxShadow: samLoading ? 'none' : '0 0 24px rgba(16,185,129,0.35), 0 2px 8px rgba(0,0,0,0.3)',
                  transition: `all 0.3s ${EASE}`,
                }}
              >
                {samLoading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Detecting…
                  </>
                ) : (
                  <>
                    <ScanSearch className="h-3.5 w-3.5" />
                    Detect Subject
                  </>
                )}
              </button>
            </div>

            {/* ── AI Auto Stretch ─────────────────────────────────────────── */}
            <div style={{
              marginTop: 12, padding: '10px 12px', borderRadius: 12,
              background: 'linear-gradient(135deg, rgba(139,92,246,0.12), rgba(59,130,246,0.12))',
              border: '1px solid rgba(139,92,246,0.25)',
            }}>
              <div className="flex items-center gap-2 mb-2">
                <BrainCircuit className="h-3.5 w-3.5" style={{ color: '#a78bfa' }} />
                <span className="text-[11px] font-semibold" style={{ color: '#a78bfa' }}>AI Auto Stretch</span>
              </div>
              <p className="text-[10.5px] leading-relaxed mb-2.5" style={{ color: 'var(--text-muted)' }}>
                Let AI analyze the image and automatically pick the best region, direction, and stretch parameters like a pro editor.
              </p>
              <button
                type="button"
                onClick={autoStretch}
                disabled={aiLoading || applying}
                className={`flex h-10 w-full items-center justify-center gap-2 rounded-xl text-xs font-semibold editor-interactive disabled:opacity-50 ${tapClass}`}
                style={{
                  background: aiLoading ? 'rgba(139,92,246,0.2)' : 'linear-gradient(135deg, #7c3aed, #3b82f6)',
                  color: '#fff', border: 'none',
                  boxShadow: aiLoading ? 'none' : '0 0 24px rgba(124,58,237,0.35), 0 2px 8px rgba(0,0,0,0.3)',
                  transition: `all 0.3s ${EASE}`,
                }}
              >
                {aiLoading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Analyzing…
                  </>
                ) : (
                  <>
                    <Zap className="h-3.5 w-3.5" />
                    Auto Stretch with AI
                  </>
                )}
              </button>
            </div>
          </>
        ) : (
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: accent }}>
              <Check className="h-3.5 w-3.5" /> Region confirmed
            </span>
            <button
              type="button"
              onClick={reselect}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium editor-interactive ${tapClass}`}
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
            >
              <Pencil className="h-3 w-3" /> Edit region
            </button>
          </div>
        )}
      </div>

      {phase === 'stretch' && (<>

      {/* ── Placement: the stretch is its OWN layer; choose how it sits vs. the subject ── */}
      <div className="panel-card" style={{ ...cardStyle, borderColor: `${accent}30` }}>
        <div className="flex items-center justify-between">
          <label className="panel-label inline-flex items-center gap-1.5"><Layers className="h-3 w-3" /> Placement</label>
          {isEditingLayer && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold" style={{ color: accent }}>
              <Check className="h-3 w-3" /> Editing layer
            </span>
          )}
        </div>
        <p className="mt-1.5 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          The stretch is its own layer — crop, colour-grade or move it like any image, and it stays even if you <strong style={{ color: 'var(--text-secondary)' }}>delete the photo</strong>. Pick how it sits relative to the subject:
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {[
            { id: 'above', label: 'Above', v: 0, hint: 'Streaks on top of the subject' },
            { id: 'partial', label: 'Partial', v: 0.5, hint: 'Streaks partly over the subject' },
            { id: 'below', label: 'Behind', v: 1, hint: 'Subject in front of the streaks' },
          ].map(({ id, label, v, hint }) => {
            const cur = coverage <= 0.05 ? 'above' : coverage >= 0.95 ? 'below' : 'partial'
            const on = cur === id
            return (
              <button
                key={id} type="button" title={hint} onClick={() => setCoverageMode(v)}
                className={`flex h-11 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium editor-interactive ${tapClass}`}
                style={{ background: on ? accent : 'var(--bg-elevated)', color: on ? onAccent : 'var(--text-secondary)', border: on ? 'none' : '1px solid var(--border-subtle)', transition: `all 0.25s ${EASE}` }}
              >
                {label}
              </button>
            )
          })}
        </div>
        {coverage > 0 && (
          <div className="mt-3 space-y-3">
            {/* What stays in front — auto-detect OR a region the user traces */}
            <div>
              <span className="panel-label">What stays in front?</span>
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={forceAutoDetect}
                  disabled={matteStatus === 'loading'}
                  className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive disabled:opacity-50 ${tapClass}`}
                  style={{ background: subjectMaskKind === 'auto' ? accent : 'var(--bg-elevated)', color: subjectMaskKind === 'auto' ? onAccent : 'var(--text-secondary)', border: subjectMaskKind === 'auto' ? 'none' : '1px solid var(--border-subtle)', transition: `all 0.25s ${EASE}` }}
                >
                  {matteStatus === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
                  Auto-detect
                </button>
                <button
                  type="button"
                  onClick={() => (subjectPicking ? cancelSubjectPick() : beginSubjectPick())}
                  className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive ${tapClass}`}
                  style={{ background: subjectPicking ? '#f59e0b' : subjectMaskKind === 'manual' ? accent : 'var(--bg-elevated)', color: subjectPicking || subjectMaskKind === 'manual' ? '#0b0e14' : 'var(--text-secondary)', border: subjectPicking || subjectMaskKind === 'manual' ? 'none' : '1px solid var(--border-subtle)', transition: `all 0.25s ${EASE}` }}
                >
                  {subjectPicking ? <X className="h-3.5 w-3.5" /> : <Lasso className="h-3.5 w-3.5" />}
                  {subjectPicking ? 'Cancel' : subjectMaskKind === 'manual' ? 'Re-draw subject' : 'Draw subject'}
                </button>
              </div>
              <div className="mt-2 text-[10px] leading-relaxed">
                {subjectPicking && <span style={{ color: '#f59e0b' }}>✏️ Trace around the subject on the photo, then release to set it.</span>}
                {!subjectPicking && matteStatus === 'loading' && <span className="inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}><Loader2 className="h-3 w-3 animate-spin" /> Detecting subject on-device…</span>}
                {!subjectPicking && subjectMaskKind === 'auto' && <span style={{ color: '#34d399' }}>✓ Subject auto-detected — streaks sit behind it.</span>}
                {!subjectPicking && subjectMaskKind === 'manual' && <span style={{ color: '#34d399' }}>✓ Using your traced region as the subject.</span>}
                {!subjectPicking && matteStatus === 'none' && subjectMaskKind === 'none' && <span style={{ color: '#f59e0b' }}>No subject auto-detected — tap “Draw subject” to mark it by hand.</span>}
              </div>
            </div>

            <ProRulerSlider
              variant="instrument" label="Subject Coverage" suffix="%"
              value={Math.round(coverage * 100)} min={0} max={100} step={1}
              onPreview={(v) => { coverageRef.current = v / 100; scheduleFrame() }}
              onCommit={(v) => setCoverageMode(v / 100)}
              visual={sliderVisual}
            />
            <ProRulerSlider
              variant="instrument" label="Edge Feather" suffix=""
              value={Math.round((featherRef.current || 0.006) * 1000)} min={0} max={30} step={1}
              onPreview={(v) => { featherRef.current = v / 1000; subjectCutoutRef.current = null; scheduleFrame() }}
              onCommit={(v) => { featherRef.current = v / 1000; subjectCutoutRef.current = null; scheduleFrame() }}
              visual={sliderVisual}
            />
          </div>
        )}
      </div>

      {/* Direction / axis — Simple mode only; Flow/Mesh own their own shape */}
      {!warpMode && !flowMode && (
      <div className="panel-card" style={cardStyle}>
        <label className="panel-label">Streak Direction</label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {[
            { id: 'vertical', label: 'Vertical', Icon: StretchVertical },
            { id: 'horizontal', label: 'Horizontal', Icon: StretchHorizontal },
          ].map(({ id, label, Icon }) => {
            const on = params.axis === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => commit({ axis: id })}
                className={`flex h-9 items-center justify-center gap-2 rounded-lg text-xs font-medium editor-interactive ${tapClass}`}
                style={{ background: on ? accent : 'var(--bg-elevated)', color: on ? onAccent : 'var(--text-secondary)', border: on ? 'none' : '1px solid var(--border-subtle)', transition: `all 0.25s ${EASE}` }}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => commit({ direction: params.direction * -1 })}
          className={`mt-2 flex w-full items-center justify-center gap-2 rounded-lg py-2 text-[11px] font-medium editor-interactive ${tapClass}`}
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
        >
          <FlipHorizontal2 className="h-3.5 w-3.5" />
          Flip stretch direction
        </button>
      </div>
      )}

      {/* ── Mode (Simple sliders · Flow Path spline · Warp mesh) ─────────── */}
      <div className="panel-card" style={cardStyle}>
        <label className="panel-label">Mode</label>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {[
            { id: 'mesh', label: 'Warp', Icon: Grid3X3 },
            { id: 'flow', label: 'Flow Path', Icon: Waypoints },
            { id: 'simple', label: 'Simple', Icon: Wand2 },
          ].map(({ id, label, Icon }) => {
            const curMode = warpMode ? 'mesh' : flowMode ? 'flow' : 'simple'
            const on = curMode === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setStretchMode(id)}
                className={`flex h-12 flex-col items-center justify-center gap-1 rounded-lg text-[10px] font-medium editor-interactive ${tapClass}`}
                style={{ background: on ? accent : 'var(--bg-elevated)', color: on ? onAccent : 'var(--text-secondary)', border: on ? 'none' : '1px solid var(--border-subtle)', transition: `all 0.25s ${EASE}` }}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            )
          })}
        </div>
        {warpMode && params.warpGrid && (
          <div className="mt-3 space-y-3">
            <p className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Drag a <strong style={{ color: 'rgba(90, 170, 255, 1)' }}>■ anchor</strong> to move the sheet, a <strong style={{ color: 'rgba(120, 190, 255, 1)' }}>● handle</strong> to bend the curve through it (the tangent line shows the direction), or an interior dot to push the patch. Split to sculpt more curves — exactly like the Photoshop Warp transform.
            </p>

            {/* Warp shape presets */}
            <div>
              <span className="panel-label inline-flex items-center gap-1.5"><Spline className="h-3 w-3" /> Warp Shape</span>
              <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                {WARP_PRESETS.map((wp) => {
                  const on = warpPresetId === wp.id
                  return (
                    <button
                      key={wp.id} type="button" title={wp.hint}
                      onClick={() => applyWarp(wp.id, wp.id === 'flat' ? 1 : warpStrength)}
                      className={`flex h-9 items-center justify-center rounded-lg text-[10px] font-medium editor-interactive ${tapClass}`}
                      style={{ background: on ? `${accent}22` : 'var(--bg-elevated)', border: on ? `1.5px solid ${accent}` : '1px solid var(--border-subtle)', color: on ? accent : 'var(--text-secondary)', transition: `all 0.2s ${EASE}` }}
                    >
                      {wp.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Preset strength — re-applies the active shape live */}
            {warpPresetId && warpPresetId !== 'flat' && (
              <ProRulerSlider
                variant="instrument" label="Warp Strength" suffix="%"
                value={Math.round(warpStrength * 100)} min={0} max={150} step={5}
                onPreview={(v) => { const r = applyWarpPreset(paramsRef.current, warpPresetId, v / 100); livePatch({ warpGrid: r.grid, warpRest: r.rest }) }}
                onCommit={(v) => applyWarp(warpPresetId, v / 100)}
                visual={sliderVisual}
              />
            )}

            {/* Grid density / split-warp */}
            <div>
              <div className="flex items-center justify-between">
                <span className="panel-label">Mesh Density</span>
                <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                  {(params.warpGrid.length - 1) / 3}×{(params.warpGrid[0].length - 1) / 3} patches
                </span>
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <button
                  type="button" onClick={() => splitWarp('row')} disabled={params.warpGrid.length >= WARP_MAX_DIM}
                  title="Split every patch horizontally (adds control points)"
                  className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive disabled:opacity-40 ${tapClass}`}
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
                >
                  <Rows3 className="h-3.5 w-3.5" /> Split Rows
                </button>
                <button
                  type="button" onClick={() => splitWarp('col')} disabled={params.warpGrid[0].length >= WARP_MAX_DIM}
                  title="Split every patch vertically (adds control points)"
                  className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive disabled:opacity-40 ${tapClass}`}
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
                >
                  <Columns3 className="h-3.5 w-3.5" /> Split Cols
                </button>
              </div>
            </div>

            <button
              type="button" onClick={resetWarpGrid}
              className={`flex w-full items-center justify-center gap-2 rounded-lg py-2 text-[11px] font-medium editor-interactive ${tapClass}`}
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
            >
              <RotateCcw className="h-3 w-3" />
              Reset Grid
            </button>
          </div>
        )}

        {flowMode && params.flowPath && (
          <div className="mt-3 space-y-3">
            <p className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Drag the <strong style={{ color: 'rgba(40, 130, 255, 1)' }}>■ anchors</strong> to route the smear and the <strong style={{ color: 'rgba(120, 190, 255, 1)' }}>● handles</strong> to bend each segment. <strong style={{ color: 'var(--text-secondary)' }}>Click the line</strong> to add a point · <strong style={{ color: 'var(--text-secondary)' }}>double-click</strong> a point to remove it.
            </p>

            {/* Flow shape presets */}
            <div>
              <span className="panel-label inline-flex items-center gap-1.5"><Route className="h-3 w-3" /> Flow Shape</span>
              <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                {FLOW_PRESETS.map((fpz) => {
                  const on = flowPresetId === fpz.id
                  return (
                    <button
                      key={fpz.id} type="button" title={fpz.hint}
                      onClick={() => applyFlowPresetUI(fpz.id)}
                      className={`flex h-9 items-center justify-center rounded-lg text-[10px] font-medium editor-interactive ${tapClass}`}
                      style={{ background: on ? `${accent}22` : 'var(--bg-elevated)', border: on ? `1.5px solid ${accent}` : '1px solid var(--border-subtle)', color: on ? accent : 'var(--text-secondary)', transition: `all 0.2s ${EASE}` }}
                    >
                      {fpz.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Ribbon width along the path */}
            <ProRulerSlider
              variant="instrument" label="Ribbon Width" suffix="%"
              value={Math.round((params.flowPath.width || 0.18) * 100)} min={2} max={80} step={1}
              onPreview={(v) => setFlowWidthLive(v / 100)}
              onCommit={(v) => setFlowWidthCommit(v / 100)}
              visual={sliderVisual}
            />

            {/* Anchor count + edit actions */}
            <div className="flex items-center justify-between">
              <span className="panel-label">Anchors</span>
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                {flowAnchorCount} points
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button" onClick={smoothFlow}
                title="Re-smooth every anchor (Catmull-Rom tangents)"
                className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive ${tapClass}`}
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
              >
                <Spline className="h-3.5 w-3.5" /> Smooth
              </button>
              <button
                type="button" onClick={() => removeFlowPointAt(params.flowPath.anchors.length - 1)}
                disabled={params.flowPath.anchors.length <= FLOW_MIN_ANCHORS}
                title="Remove the last anchor"
                className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-[11px] font-medium editor-interactive disabled:opacity-40 ${tapClass}`}
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
              >
                <Minus className="h-3.5 w-3.5" /> Remove Point
              </button>
            </div>

            <button
              type="button" onClick={resetFlow}
              className={`flex w-full items-center justify-center gap-2 rounded-lg py-2 text-[11px] font-medium editor-interactive ${tapClass}`}
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
            >
              <RotateCcw className="h-3 w-3" />
              Reset Path
            </button>
          </div>
        )}
      </div>

      {/* Presets + Length/Bend/Source — Simple mode only (Flow/Mesh have their own shape controls) */}
      {!warpMode && !flowMode && (<>
      <div className="panel-card" style={cardStyle}>
        <label className="panel-label">Looks</label>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {PIXEL_STRETCH_PRESETS.map((preset) => {
            const isActive = activePresetId === preset.id
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset)}
                title={preset.hint}
                className={`flex h-[52px] flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium editor-interactive ${tapClass}`}
                style={{
                  background: isActive ? `${accent}22` : 'var(--bg-elevated)',
                  border: isActive ? `1.5px solid ${accent}` : '1px solid var(--border-subtle)',
                  color: isActive ? accent : 'var(--text-secondary)',
                  transition: `all 0.25s ${EASE}`,
                }}
              >
                <Wand2 className="h-3.5 w-3.5" style={{ color: isActive ? accent : 'var(--text-muted)' }} />
                {preset.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Primary sliders */}
      <div className="space-y-3">
        <ProRulerSlider
          variant="instrument" label="Length" suffix="%"
          value={pct(params.length)} min={100} max={800} step={5}
          onPreview={(v) => livePatch({ length: v / 100 })}
          onCommit={(v) => sliderCommit('length', v)}
          visual={sliderVisual}
        />
        <ProRulerSlider
          variant="instrument" label="Bend" suffix="%"
          value={pct(params.bend)} min={-100} max={100} step={1}
          onPreview={(v) => livePatch({ bend: v / 100 })}
          onCommit={(v) => sliderCommit('bend', v)}
          visual={sliderVisual}
        />
        <ProRulerSlider
          variant="instrument" label="Seed Line" suffix="%"
          value={pct(params.seed)} min={0} max={100} step={1}
          onPreview={(v) => livePatch({ seed: v / 100 })}
          onCommit={(v) => sliderCommit('seed', v)}
          visual={sliderVisual}
        />
      </div>
      </>)}

      {/* Refine (collapsible) */}
      <button
        type="button"
        onClick={() => setShowAdvanced((s) => !s)}
        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-[11px] font-medium editor-interactive"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
      >
        Refine
        <ChevronDown className="h-3.5 w-3.5" style={{ transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: `transform 0.3s ${EASE}` }} />
      </button>
      {showAdvanced && (
        <div className="space-y-3">
          {!warpMode && !flowMode && (
            <ProRulerSlider
              variant="instrument" label="Twist (S-curve)" suffix="%"
              value={pct(params.twist)} min={-100} max={100} step={1}
              onPreview={(v) => livePatch({ twist: v / 100 })}
              onCommit={(v) => sliderCommit('twist', v)}
              visual={sliderVisual}
            />
          )}
          <ProRulerSlider
            variant="instrument" label="Fade" suffix="%"
            value={pct(params.fade)} min={0} max={100} step={1}
            onPreview={(v) => livePatch({ fade: v / 100 })}
            onCommit={(v) => sliderCommit('fade', v)}
            visual={sliderVisual}
          />
          <ProRulerSlider
            variant="instrument" label="Taper / Flare" suffix="%"
            value={pct(params.taper)} min={-100} max={100} step={1}
            onPreview={(v) => livePatch({ taper: v / 100 })}
            onCommit={(v) => sliderCommit('taper', v)}
            visual={sliderVisual}
          />
          <ProRulerSlider
            variant="instrument" label="Strength" suffix="%"
            value={pct(params.opacity)} min={0} max={100} step={1}
            onPreview={(v) => livePatch({ opacity: v / 100 })}
            onCommit={(v) => sliderCommit('opacity', v)}
            visual={sliderVisual}
          />
          {!flowMode && (
          <button
            type="button"
            onClick={() => { setActivePresetId(null); commit({ mirror: !params.mirror }) }}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-[11px] font-medium editor-interactive ${tapClass}`}
            style={{ background: params.mirror ? accent : 'var(--bg-elevated)', color: params.mirror ? onAccent : 'var(--text-secondary)', border: params.mirror ? 'none' : '1px solid var(--border-subtle)', transition: `all 0.25s ${EASE}` }}
          >
            Mirror (symmetric arc)
            <span>{params.mirror ? 'On' : 'Off'}</span>
          </button>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-0.5">
        <button
          type="button"
          onClick={resetParams}
          disabled={applying}
          className={`flex h-10 flex-1 items-center justify-center gap-2 rounded-xl text-xs font-semibold editor-interactive disabled:opacity-40 ${tapClass}`}
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </button>
        <button
          type="button"
          onClick={applyStretch}
          disabled={applying}
          className={`flex h-10 flex-[2] items-center justify-center gap-2 rounded-xl text-xs font-semibold editor-interactive disabled:opacity-50 ${tapClass}`}
          style={{ background: accent, color: onAccent, border: 'none', boxShadow: `0 0 28px ${accent}45`, transition: `all 0.25s ${EASE}` }}
        >
          {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : isEditingLayer ? <Check className="h-3.5 w-3.5" /> : <Layers className="h-3.5 w-3.5" />}
          {applying ? 'Applying…' : isEditingLayer ? 'Update Layer' : 'Add as Layer'}
        </button>
      </div>
      </>)}
    </div>
  )
}

export default PixelStretchControls
