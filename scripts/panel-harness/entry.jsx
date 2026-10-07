// Mounts the real editor panels and CanvasEditor against a real Fabric canvas — no
// Next, Clerk or network. Driven by scripts/verify-panels.mjs.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas, FabricImage } from 'fabric'
import { CanvasContext } from '../../context/context'
import MaskControls from '../../src/app/(main)/editor/[projectId]/_components/tools/mask'
import PixelStretchControls from '../../src/app/(main)/editor/[projectId]/_components/tools/pixel-stretch'
import AdjustControls from '../../src/app/(main)/editor/[projectId]/_components/tools/adjust'
import CollageControls from '../../src/app/(main)/editor/[projectId]/_components/tools/collage'
import ImageKitAgent from '../../src/app/(main)/editor/[projectId]/_components/tools/imagekit-agent'
import CanvasEditor from '../../src/app/(main)/editor/[projectId]/_components/canvas'
import { saveLocalState } from '../../src/lib/canvas-sync'

window.__errors = []
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) {
    window.__errors.push(`${error.message} @ ${(info.componentStack || '').trim().split('\n').slice(0, 3).join(' | ')}`)
  }
  render() { return this.state.error ? <pre id="crash">{String(this.state.error.stack)}</pre> : this.props.children }
}

const noop = () => {}
const contextValue = (canvasEditor, activeTool, setCanvasEditor = noop) => ({
  canvasEditor, setCanvasEditor, activeTool, onToolChange: noop, processingMessage: null, setProcessingMessage: noop,
  setProcessingPhase: noop, cancelProcessing: noop, registerProcessingAbort: noop, expansionPreview: null, setExpansionPreview: noop,
})

// Deterministic test photo: gradient sky, ground, a red disc and a dark block.
function testImageUrl() {
  const c = document.createElement('canvas'); c.width = 1200; c.height = 800
  const g = c.getContext('2d')
  const sky = g.createLinearGradient(0, 0, 0, 500); sky.addColorStop(0, '#2b6cb0'); sky.addColorStop(1, '#bee3f8')
  g.fillStyle = sky; g.fillRect(0, 0, 1200, 500)
  g.fillStyle = '#556b2f'; g.fillRect(0, 500, 1200, 300)
  g.fillStyle = '#c53030'; g.beginPath(); g.arc(600, 420, 160, 0, Math.PI * 2); g.fill()
  g.fillStyle = '#1a202c'; g.fillRect(150, 560, 220, 180)
  return c.toDataURL('image/png')
}

const PANELS = { mask: MaskControls, stretch: PixelStretchControls, adjust: AdjustControls, collage: CollageControls, agent: ImageKitAgent }
let root, url
window.__setup = async () => {
  url = testImageUrl()
  const canvas = new Canvas(document.getElementById('fabric'), { width: 900, height: 600 })
  const img = await FabricImage.fromURL(url)
  img.scaleToWidth(800)
  canvas.add(img); canvas.setActiveObject(img); canvas.renderAll()
  window.__canvas = canvas
}
window.__mount = (name) => {
  const Panel = PANELS[name]
  const project = { _id: 'harness', id: 'harness', title: 'Harness', width: 1200, height: 800, originalImageUrl: url, currentImageUrl: url }
  root?.unmount()
  root = createRoot(document.getElementById('panel'))
  root.render(
    <CanvasContext.Provider value={contextValue(window.__canvas, name === 'stretch' ? 'pixel_stretch' : name)}>
      <Boundary><Panel project={project} dominantColor="#06B8D4" contrastingColor="#03050A" lighterColor="#7DE3F0" /></Boundary>
    </CanvasContext.Provider>
  )
}

// CanvasEditor with a chosen saved state (`saved` objects) and an optional newer,
// unsynced IndexedDB copy (`local` objects).
const rects = (n) => Array.from({ length: n }, (_, i) => ({ type: 'Rect', version: '7.2.0', left: 80 + i * 60, top: 80, width: 50, height: 50, fill: '#c53030' }))
const savedState = (n) => ({ canvas: { version: '7.2.0', objects: rects(n) }, history: [], historyIndex: -1 })
window.__runEditor = async ({ saved, local }) => {
  const projectId = 'harness-canvas'
  if (local !== null) {
    await saveLocalState(projectId, { fullState: savedState(local), currentImageUrl: null, hash: `h${local}`, updatedAt: Date.now() + 60_000, baseRevision: 5, dirty: true })
  }
  const project = { _id: projectId, id: projectId, title: 'Harness', width: 1200, height: 800, revision: 5,
    updatedAt: Date.now() - 60_000, canvasState: savedState(saved), originalImageUrl: null, currentImageUrl: null }
  createRoot(document.getElementById('editor')).render(
    <CanvasContext.Provider value={contextValue(null, null, (c) => { window.__editorCanvas = c })}>
      <Boundary><CanvasEditor project={project} /></Boundary>
    </CanvasContext.Provider>
  )
}
