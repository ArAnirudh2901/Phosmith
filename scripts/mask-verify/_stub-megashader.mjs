// Test shim for @/lib/megashader (wired via this dir's tsconfig.json paths).
// growMaskCanvas — the only thing the cleanup path uses from @/lib/mask-grow —
// imports these four names at module top-level but NEVER calls them in the
// cleanup path (it only uses the pure growCoverage from ./mask-grow-core). So
// no-op exports are sound; the real algorithm under test runs unmodified, and
// we avoid dragging the WebGL/megashader barrel into a headless run.
export const applyMegashaderFilter = () => {}
export const getMaskTexture = () => null
export const sanitiseLayer = (l) => l
export const setMaskTexture = () => {}
export default {}
