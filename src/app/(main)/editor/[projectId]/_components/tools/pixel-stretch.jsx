"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AudioLines, Check, ChevronDown, FlipHorizontal2, Layers, Loader2, RotateCcw, Sparkles, StretchHorizontal, StretchVertical, Wand2 } from 'lucide-react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { isTaintError } from '@/lib/canvas-snapshot'
import { clientSubjectMask } from '@/lib/client-ai'
import { adaptiveTextColor } from '@/lib/color-extraction'
import { traceContour } from '@/lib/contour-trace'
import { isSuperseded, runHeavy } from '@/lib/heavy-job-queue'
import { DEFAULT_SCANLINE, DEFAULT_STRETCH, PIXEL_STRETCH_PRESETS, addWarpSplit, analyzeStretchPlan, applyFlowPreset, applyWarpPreset, bestSeedInBand, buildSubjectCutout, clampStretchParams, createDefaultFlowPath, createDefaultWarpGrid, createFlowPathFromPoints, createStretchBuffer, getFlowPathCurve, getFlowPathHandles, getPolygonBBox, getStretchAnchors, getStretchPath, getWarpGridCurves, getWarpGridHandles, getWarpRest, insertFlowAnchor, matteToAlphaCanvas, removeFlowAnchor, renderPixelStretch, smoothFlowPath } from '@/lib/pixel-stretch'
import { MAX_BAKE_DIM, bakeStretchBuffer, encodeToPngBlob, getSourceElement, isSourceReady, placeStretchLayer, snapshotSource, uploadStretchBlob } from '@/lib/pixel-stretch-apply'
import { toUserMessage } from '@/lib/user-error'
import { useCanvas } from '../../../../../../../context/context'
import { canvasToScreen, getActiveImage, getImageCanvasBounds, isImageObject, polygonArea, simplifyPolygon } from './stretch/canvas-geometry'
import { DIM_BG, EASE, HANDLE, HANDLE_DEFS, MAX_PREVIEW_DIM, MIN_BAND, SETTLE_MS, SUBJECT_DETECT_MAX_DIM } from './stretch/constants'
import SelectionCard from './stretch/selection-card'
import PlacementCard from './stretch/placement-card'
import ModeCard from './stretch/mode-card'
import RibbonShapeSliders from './stretch/ribbon-shape-sliders'
import RefineSliders from './stretch/refine-sliders'

let uidCounter = 0

// ─── Tool ─────────────────────────────────────────────────────────────────────

const PixelStretchControls = ({ dominantColor, contrastingColor }) => {
  const { canvasEditor, activeTool } = useCanvas()
  const active = activeTool === 'pixel_stretch'
  const accent = dominantColor || '#00E5FF'
  // `accent` is the photo's dominant colour, so on a dark or muted image it can
  // fall below AA against the panel. Text uses the contrast-checked variant.
  const accentText = useMemo(
    () => adaptiveTextColor(accent, 'rgb(14,17,24)', 1, { min: 4.5 }).color,
    [accent],
  )
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
  const [scanMode, setScanMode] = useState(false)  // whole-frame scanline smear (no selection)
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
  const [subjectMaskKind, setSubjectMaskKind] = useState('selection') // 'selection'|'auto'|'manual'
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
  const subjectMaskKindRef = useRef('selection')
  const rasterizeSelectionMatteRef = useRef(null)

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
  useEffect(() => { subjectMaskKindRef.current = subjectMaskKind }, [subjectMaskKind])

  // ── Canvas container element ─────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasEditor) { containerRef.current = null; setContainerEl(null); return }
    const el = canvasEditor.lowerCanvasEl?.parentElement?.parentElement
    containerRef.current = el || null
    setContainerEl(el || null)
  }, [canvasEditor])

  // ── Image lock helpers ───────────────────────────────────────────────────────
  //
  // EVERY image on the canvas is frozen while the tool is open, not just the one
  // being edited. The selection is drawn by dragging on the canvas, and any drag
  // the tool's own surface does not catch falls through to Fabric — which moved
  // the photo out from under the stretch. Re-editing a committed layer made that
  // certain: the layer was locked and the photo underneath was left live.
  const lockImage = useCallback((img) => {
    const canvas = editorRef.current
    const targets = canvas?.getObjects?.().filter((o) => o?.type?.toLowerCase?.() === 'image') || []
    if (img && !targets.includes(img)) targets.push(img)
    if (!targets.length) return
    lockRef.current = targets.map((o) => ({
      img: o,
      props: {
        selectable: o.selectable, evented: o.evented,
        lockMovementX: o.lockMovementX, lockMovementY: o.lockMovementY,
        hasControls: o.hasControls, hasBorders: o.hasBorders,
      },
    }))
    for (const o of targets) {
      o.set({ selectable: false, evented: false, lockMovementX: true, lockMovementY: true, hasControls: false, hasBorders: false })
    }
  }, [])

  const unlockImage = useCallback(() => {
    const entries = lockRef.current
    if (Array.isArray(entries)) for (const l of entries) l.img?.set?.(l.props)
    else if (entries?.img) entries.img.set(entries.props)   // pre-existing single-image shape
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
    // Selection mode is the default and is recomputed every time, because the
    // band or lasso may have moved since the last bake.
    if (subjectMaskKindRef.current === 'selection') {
      const sel = rasterizeSelectionMatteRef.current?.()
      if (sel) {
        subjectRawMatteRef.current = sel
        subjectCutoutRef.current = null
        setMatteStatus('ready')
        return sel
      }
    }
    const srcEl = sampleElRef.current || getSourceElement(selectedImageRef.current)
    if (!isSourceReady(srcEl)) return null
    const sig = sourceMetaRef.current?.src || String(selectedImageRef.current?.__stretchUid ?? '')
    if (subjectRawMatteRef.current && subjectMatteSigRef.current === sig) return subjectRawMatteRef.current
    setMatteStatus('loading')
    try {
      // SlimSAM works from a small image, and the matte is scaled back up when it
      // is composited, so detection runs on a bounded copy. At native size a
      // 45MP frame would have the model allocating one full RGBA mask per seed.
      const natW = srcEl.naturalWidth || srcEl.videoWidth || srcEl.width || 512
      const natH = srcEl.naturalHeight || srcEl.videoHeight || srcEl.height || 512
      const scale = Math.min(1, SUBJECT_DETECT_MAX_DIM / Math.max(natW, natH))
      const dw = Math.max(64, Math.round(natW * scale))
      const dh = Math.max(64, Math.round(natH * scale))
      const small = scale < 1 ? snapshotSource(srcEl, dw, dh, false, false) : srcEl
      let matte
      try {
        matte = await clientSubjectMask(small, { width: dw, height: dh })
      } finally {
        if (small !== srcEl) { small.width = 1; small.height = 1 }
        // Give the ~40MB model and its runtime back rather than holding them for
        // the session — this tool needs it once, not continuously.
        import('@/lib/client-ai').then((m) => m.releaseClientModels?.()).catch(() => {})
      }
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

  /**
   * The front mask built from the CURRENT SELECTION — the lasso polygon if there
   * is one, otherwise the band rectangle.
   *
   * This is what "Behind" means by default: the streaks pass behind the area you
   * selected. It needs no model, no download and no extra memory, which matters
   * because subject detection loads SlimSAM and can cost hundreds of MB on a
   * large photo. Auto-detect stays available for the cases it genuinely suits.
   */
  const rasterizeSelectionMatte = useCallback(() => {
    const p = paramsRef.current
    const img = selectedImageRef.current
    const natW = Math.min(1600, Math.max(64, img?.width || 1024))
    const natH = Math.min(1600, Math.max(64, img?.height || 1024))
    const c = createStretchBuffer(natW, natH)
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, natW, natH)
    ctx.fillStyle = '#fff'
    if (Array.isArray(p.polygon) && p.polygon.length >= 3) {
      ctx.beginPath()
      p.polygon.forEach((pt, i) => { const x = pt.x * natW, y = pt.y * natH; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) })
      ctx.closePath()
      ctx.fill()
    } else {
      const b = p.band
      ctx.fillRect(b.x * natW, b.y * natH, b.w * natW, b.h * natH)
    }
    return c
  }, [])

  useEffect(() => { rasterizeSelectionMatteRef.current = rasterizeSelectionMatte }, [rasterizeSelectionMatte])

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
    subjectMaskKindRef.current = 'auto'
    setSubjectMaskKind('auto')
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
    // The scanline smear has no band and no path, so none of the chrome applies.
    const scanOn = !!p.scan
    const showMarquee = mode === 'rect' && phaseNow === 'stretch' && !warpOn && !flowOn && !scanOn
    const showFlow = phaseNow === 'stretch' && !warpOn && !flowOn && !scanOn
    const showWarp = phaseNow === 'stretch' && warpOn && !scanOn
    const showFlowPath = phaseNow === 'stretch' && flowOn && !scanOn
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
    // Preset lengths are multiples of the SLICE, which means "Tall Smear" on a
    // 2%-tall slice would not even clear the slice. Re-express each preset's
    // length as the fraction of the frame it was written for (it assumed a
    // roughly quarter-height band) and convert back through the real slice.
    const p = paramsRef.current
    const extent = Math.max(0.005, p.axis === 'vertical' ? (p.band?.h || 0.25) : (p.band?.w || 0.25))
    const next = { ...preset.params }
    if (typeof next.length === 'number') {
      const frameTravel = Math.min(2.5, next.length * 0.25)
      next.length = Math.max(1, Math.min(200, frameTravel / extent))
    }
    commit(next)
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
    // Seed the slice on its most colourful line rather than its first row. The
    // ribbon IS that one line repeated, so a line through a plain area can only
    // ever make a plain slab — the difference between the reference look and a
    // flat smear.
    const sampled = getSample()
    const bandNow = regionPatch.band || paramsRef.current.band
    const best = sampled?.canvas ? bestSeedInBand(sampled.canvas, bandNow, paramsRef.current.axis) : null
    if (best) regionPatch = { ...regionPatch, seed: best.seed }
    const base = clampStretchParams({ ...paramsRef.current, ...regionPatch, length: 1, bend: 0, twist: 0, flowPath: null })
    setWarpMode(true)
    setFlowMode(false)
    setWarpPresetId(null)
    setWarpStrength(1)
    setFlowPresetId(null)
    setActivePresetId(null)
    commit({ ...regionPatch, length: 1, bend: 0, twist: 0, flowPath: null, warpGrid: createDefaultWarpGrid(base), warpRest: getWarpRest(base) })
    setPhase('stretch')
  }, [commit, getSample])

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
      toast.error(toUserMessage(error, 'Subject detection failed'), { id: toastId })
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
      setWarpMode(true); setFlowMode(false); setScanMode(false)
      commit({ scan: null, warpGrid: createDefaultWarpGrid(paramsRef.current), warpRest: getWarpRest(paramsRef.current), flowPath: null })
    } else if (mode === 'flow') {
      setFlowMode(true); setWarpMode(false); setScanMode(false)
      const fp = createDefaultFlowPath(paramsRef.current)
      setFlowAnchorCount(fp?.anchors.length || 0)
      commit({ scan: null, flowPath: fp, warpGrid: null, warpRest: null })
    } else if (mode === 'scan') {
      // The scanline smear reads the WHOLE frame, so it drops the selection modes
      // rather than sitting on top of them.
      setScanMode(true); setWarpMode(false); setFlowMode(false)
      commit({ scan: { ...DEFAULT_SCANLINE }, warpGrid: null, warpRest: null, flowPath: null })
    } else {
      setWarpMode(false); setFlowMode(false); setScanMode(false)
      commit({ scan: null, warpGrid: null, warpRest: null, flowPath: null })
    }
  }, [commit])

  /** Patch one field of the scanline config, keeping the rest. */
  const patchScan = useCallback((patch, live) => {
    const next = { ...(paramsRef.current.scan || DEFAULT_SCANLINE), ...patch }
    if (live) livePatch({ scan: next })
    else commit({ scan: next })
  }, [commit, livePatch])

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
    if (next <= 0) return
    // The default front mask is the SELECTION — instant, no model, no download.
    // Subject detection only runs when the user explicitly asks for it.
    if (subjectMaskKindRef.current === 'selection') {
      subjectRawMatteRef.current = null
      subjectCutoutRef.current = null
      await ensureSubjectMatte()
      scheduleFrame()
      return
    }
    if (!subjectRawMatteRef.current && matteStatus !== 'loading') {
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
      toast.error(toUserMessage(error, 'AI analysis failed'), { id: toastId })
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
      // The matte is fetched BEFORE taking the heavy slot: subject detection is
      // queued itself, so asking for it from inside a queued job would deadlock.
      const matte = cov > 0 ? await ensureSubjectMatte() : null
      const url = await runHeavy('pixel stretch commit', async () => {
        // Same bake the agent runs, including handing the full-size scratch
        // canvases back afterwards.
        const out = bakeStretchBuffer({
          srcEl, params: p, W, H, flipX, flipY,
          matte, coverage: cov, feather: featherRef.current,
        })
        if (!out) throw new Error('Nothing to stretch yet — set a region or shape first')

        let blob
        try { blob = await encodeToPngBlob(out) }
        catch (encodeErr) {
          // Same taint test the export path uses, so both agree on what a tainted
          // canvas looks like across engines.
          if (isTaintError(encodeErr)) throw new Error('This image is cross-origin and can’t be exported. Re-import it into the project first.')
          throw encodeErr
        }
        return await uploadStretchBlob(blob, W, H)
      }, { key: 'stretch-commit-button' })

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

      const placed = await placeStretchLayer({
        editor, frameObj, url, W, H, meta,
        existingLayer: editingLayerRef.current || null,
      })
      if (!editingLayerRef.current) placed.__stretchUid = ++uidCounter
      editingLayerRef.current = placed
      // The new layer joins the frozen set; without this the very next drag on
      // the canvas picks it up and slides it off the photo.
      lockImage(placed)

      setIsEditingLayer(true)
      interactingRef.current = false
      editor.requestRenderAll()
      editor.__pushHistoryState?.({ label: wasEditing ? 'Edit pixel stretch' : 'Pixel stretch layer', domain: 'pixel-stretch' })
      editor.__saveCanvasState?.()
      scheduleFrame()
      toast.success(wasEditing ? 'Stretch layer updated' : 'Pixel stretch added as a layer', { id: toastId })
    } catch (error) {
      // A second click replaced this run — that is the button working, not a
      // failure, so it must not surface as one.
      if (isSuperseded(error)) { toast.dismiss(toastId); return }
      console.error('[PixelStretch] apply failed:', error)
      toast.error(toUserMessage(error, 'Failed to apply pixel stretch'), { id: toastId })
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
        <AudioLines className="h-6 w-6" style={{ color: accentText }} />
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

  // How much of the frame the slice already covers along the stretch axis — the
  // Length slider converts between "travel across the frame" and the stored
  // multiple-of-the-slice through this.
  const bandExtent = Math.max(0.005, params.axis === 'vertical' ? (params.band?.h || 0.1) : (params.band?.w || 0.1))
  const sliderVisual = { fill: `${accent}55`, accent, trackBg: 'rgba(18, 22, 30, 0.96)' }
  const sliderCommit = (key, raw, scale = 100) => { setActivePresetId(null); commit({ [key]: raw / scale }) }
  const cardStyle = { boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)' }
  const tapClass = 'active:scale-[0.98]'

  return (
    <div className="space-y-3.5">
      {overlay}

      {/* Region selection — pick a tool, draw, confirm */}
      <SelectionCard
          accent={accent}
          accentText={accentText}
          aiLoading={aiLoading}
          applying={applying}
          autoDetectSubject={autoDetectSubject}
          autoStretch={autoStretch}
          cardStyle={cardStyle}
          changeMode={changeMode}
          confirmRegion={confirmRegion}
          lassoPtsRef={lassoPtsRef}
          onAccent={onAccent}
          phase={phase}
          regionReady={regionReady}
          reselect={reselect}
          samLoading={samLoading}
          scheduleFrame={scheduleFrame}
          selectionMode={selectionMode}
          setPhase={setPhase}
          setRegionReady={setRegionReady}
          setStretchMode={setStretchMode}
          tapClass={tapClass}
      />

      {phase === 'stretch' && (<>

      {/* ── Placement: the stretch is its OWN layer; choose how it sits vs. the subject ── */}
      <PlacementCard
          accent={accent}
          accentText={accentText}
          beginSubjectPick={beginSubjectPick}
          cancelSubjectPick={cancelSubjectPick}
          cardStyle={cardStyle}
          coverage={coverage}
          coverageRef={coverageRef}
          ensureMatteRef={ensureMatteRef}
          featherRef={featherRef}
          forceAutoDetect={forceAutoDetect}
          isEditingLayer={isEditingLayer}
          matteIsManualRef={matteIsManualRef}
          matteStatus={matteStatus}
          onAccent={onAccent}
          scheduleFrame={scheduleFrame}
          scheduleFrameRef={scheduleFrameRef}
          setCoverageMode={setCoverageMode}
          setSubjectMaskKind={setSubjectMaskKind}
          sliderVisual={sliderVisual}
          subjectCutoutRef={subjectCutoutRef}
          subjectMaskKind={subjectMaskKind}
          subjectMaskKindRef={subjectMaskKindRef}
          subjectPicking={subjectPicking}
          subjectRawMatteRef={subjectRawMatteRef}
          tapClass={tapClass}
      />

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
      <ModeCard
          accent={accent}
          applyFlowPresetUI={applyFlowPresetUI}
          applyWarp={applyWarp}
          cardStyle={cardStyle}
          flowAnchorCount={flowAnchorCount}
          flowMode={flowMode}
          flowPresetId={flowPresetId}
          livePatch={livePatch}
          onAccent={onAccent}
          params={params}
          paramsRef={paramsRef}
          patchScan={patchScan}
          removeFlowPointAt={removeFlowPointAt}
          resetFlow={resetFlow}
          resetWarpGrid={resetWarpGrid}
          scanMode={scanMode}
          setFlowWidthCommit={setFlowWidthCommit}
          setFlowWidthLive={setFlowWidthLive}
          setStretchMode={setStretchMode}
          sliderVisual={sliderVisual}
          smoothFlow={smoothFlow}
          splitWarp={splitWarp}
          tapClass={tapClass}
          warpMode={warpMode}
          warpPresetId={warpPresetId}
          warpStrength={warpStrength}
      />

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
      <RibbonShapeSliders
          bandExtent={bandExtent}
          commit={commit}
          getSample={getSample}
          livePatch={livePatch}
          params={params}
          paramsRef={paramsRef}
          pct={pct}
          setActivePresetId={setActivePresetId}
          sliderCommit={sliderCommit}
          sliderVisual={sliderVisual}
          tapClass={tapClass}
      />
      </>)}

      {/* Refine (collapsible) */}
      <button
        type="button"
        onClick={() => setShowAdvanced((s) => !s)}
        aria-expanded={showAdvanced}
        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-[11px] font-medium editor-interactive"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', transition: `all 0.25s ${EASE}` }}
      >
        Refine
        <ChevronDown className="h-3.5 w-3.5" style={{ transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: `transform 0.3s ${EASE}` }} />
      </button>
      {showAdvanced && (
        <RefineSliders
            accent={accent}
            commit={commit}
            flowMode={flowMode}
            livePatch={livePatch}
            onAccent={onAccent}
            params={params}
            pct={pct}
            setActivePresetId={setActivePresetId}
            sliderCommit={sliderCommit}
            sliderVisual={sliderVisual}
            tapClass={tapClass}
            warpMode={warpMode}
        />
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
          className={`flex h-10 flex-[2] items-center justify-center whitespace-nowrap gap-2 rounded-xl text-xs font-semibold editor-interactive disabled:opacity-50 ${tapClass}`}
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
