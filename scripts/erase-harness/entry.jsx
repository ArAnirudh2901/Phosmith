// Mounts the real CanvasEditor with the real Erase panel on a large photo — no
// Next, Clerk or network. Driven by scripts/verify-erase.mjs.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { CanvasContext } from '../../context/context'
import CanvasEditor from '../../src/app/(main)/editor/[projectId]/_components/canvas'
import EraseControls from '../../src/app/(main)/editor/[projectId]/_components/tools/erase'
import { serializeCanvasState } from '../../src/lib/canvas-state'
import { buildMaskClipCanvas, decodeMaskCanvas, encodeMaskCanvas, encodeMaskCanvasCached, isMaskCanvasEmpty } from '../../src/lib/canvas-mask'

window.__lib = { serializeCanvasState, encodeMaskCanvas, encodeMaskCanvasCached, decodeMaskCanvas, isMaskCanvasEmpty, buildMaskClipCanvas }

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

function Host({ project }) {
  const [canvasEditor, setCanvasEditor] = React.useState(null)
  const [processingMessage, setProcessingMessage] = React.useState(null)
  React.useEffect(() => { window.__canvas = canvasEditor }, [canvasEditor])
  const [panel, setPanel] = React.useState(false)
  React.useEffect(() => { window.__showPanel = setPanel }, [])
  const value = {
    canvasEditor, setCanvasEditor, activeTool: panel ? 'erase' : null, onToolChange: noop,
    processingMessage, setProcessingMessage, setProcessingPhase: noop, cancelProcessing: noop,
    registerProcessingAbort: noop, expansionPreview: null, setExpansionPreview: noop,
  }
  return (
    <CanvasContext.Provider value={value}>
      <div style={{ display: 'flex' }}>
        <div id="panel" style={{ width: 340, height: 1000, overflow: 'auto' }}>
          {panel && canvasEditor && <Boundary><EraseControls project={project} dominantColor="#06B8D4" /></Boundary>}
        </div>
        <div id="editor" style={{ width: 1100, height: 760, position: 'relative', overflow: 'hidden', display: 'flex' }}>
          <Boundary><CanvasEditor project={project} /></Boundary>
        </div>
      </div>
      <Toaster />
    </CanvasContext.Provider>
  )
}

window.__run = ({ width, height, src }) => {
  const image = { type: 'Image', version: '7.2.0', left: 0, top: 0, width, height, scaleX: 1, scaleY: 1, src, crossOrigin: 'anonymous', originX: 'left', originY: 'top' }
  const project = { _id: 'erase-harness', id: 'erase-harness', title: 'Erase', width, height, revision: 1,
    updatedAt: Date.now() - 60_000, canvasState: { canvas: { version: '7.2.0', objects: [image] }, history: [], historyIndex: -1 },
    originalImageUrl: src, currentImageUrl: src }
  createRoot(document.getElementById('root')).render(<Host project={project} />)
}
