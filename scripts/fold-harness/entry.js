// Harness for scripts/verify-fold.mjs: exposes the megashader benchmarks on
// window so the verifier can drive them over CDP (or Playwright) in a real
// browser. Kept out of the app bundle.

import { megashaderBench, megashaderEditBench, megashaderFoldParity, megashaderParity } from '../../src/lib/megashader/bench.js'
import { getRenderMetrics, resetRenderMetrics } from '../../src/lib/megashader/megashader-renderer.js'

const gl = document.createElement('canvas').getContext('webgl2')
window.__fold = {
    ready: true,
    caps: gl
        ? {
            webgl2: true,
            floatTargets: Boolean(gl.getExtension('EXT_color_buffer_float')),
            textureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
            renderer: gl.getExtension('WEBGL_debug_renderer_info')
                ? gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL)
                : 'unknown',
        }
        : { webgl2: false },
    parity: megashaderParity,
    foldParity: megashaderFoldParity,
    editBench: megashaderEditBench,
    bench: megashaderBench,
    metrics: getRenderMetrics,
    resetMetrics: resetRenderMetrics,
}
