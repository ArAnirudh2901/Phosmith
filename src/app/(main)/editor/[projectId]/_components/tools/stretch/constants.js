// Subject detection never needs more than this on its long edge.
export const SUBJECT_DETECT_MAX_DIM = 1024

export const MAX_PREVIEW_DIM = 1500

export const HANDLE = 14

export const MIN_BAND = 0.02

export const SETTLE_MS = 150

export const DIM_BG = 'rgba(4, 6, 10, 0.55)'

export const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

export const HANDLE_DEFS = [
  { id: 'tl', cx: 0, cy: 0, cur: 'nwse-resize' },
  { id: 'tr', cx: 1, cy: 0, cur: 'nesw-resize' },
  { id: 'bl', cx: 0, cy: 1, cur: 'nesw-resize' },
  { id: 'br', cx: 1, cy: 1, cur: 'nwse-resize' },
  { id: 't', cx: 0.5, cy: 0, cur: 'ns-resize' },
  { id: 'b', cx: 0.5, cy: 1, cur: 'ns-resize' },
  { id: 'l', cx: 0, cy: 0.5, cur: 'ew-resize' },
  { id: 'r', cx: 1, cy: 0.5, cur: 'ew-resize' },
]
