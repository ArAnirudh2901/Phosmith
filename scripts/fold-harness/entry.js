// Harness for scripts/verify-fold.mjs: exposes the megashader benchmarks on
// window so the verifier can drive them over CDP (or Playwright) in a real
// browser. Kept out of the app bundle.

import { megashaderBench, megashaderBlurBench, megashaderEditBench, megashaderFoldParity, megashaderParity } from '../../src/lib/megashader/bench.js'
import { disposeRenderer, getRenderMetrics, resetRenderMetrics } from '../../src/lib/megashader/megashader-renderer.js'

/**
 * Pretend the GPU is less capable than it is, so the verifier can prove the
 * fold DEGRADES instead of composing through a target the driver refused.
 *
 *   noFloat        — EXT_color_buffer_float is missing, as on older drivers.
 *   refuseFloatFbo — the extension is there but a half-float attachment is not
 *                    framebuffer-complete, which is the silent-corruption case.
 *
 * Patches live on WebGL2RenderingContext.prototype, and disposeRenderer() drops
 * the renderer's context and its cached caps so they are probed again.
 */
const proto = typeof WebGL2RenderingContext === 'function' ? WebGL2RenderingContext.prototype : null
const original = proto
    ? {
        getExtension: proto.getExtension,
        texImage2D: proto.texImage2D,
        framebufferTexture2D: proto.framebufferTexture2D,
        checkFramebufferStatus: proto.checkFramebufferStatus,
    }
    : null

const hostileGpu = (mode) => {
    if (!proto) return false
    restoreGpu()
    if (mode === 'noFloat') {
        proto.getExtension = function patched(name) {
            if (name === 'EXT_color_buffer_float') return null
            return original.getExtension.call(this, name)
        }
    } else if (mode === 'refuseFloatFbo') {
        // Sizes are tracked so the renderer's 1×1 renderability probe still
        // passes: the driver being modelled here advertises float targets and
        // accepts a tiny one, then refuses a full-size map.
        const floatWidths = new WeakMap()
        proto.texImage2D = function patched(target, level, internalformat, ...rest) {
            if (internalformat === this.RGBA16F || internalformat === this.RGBA32F) {
                const bound = this.getParameter(this.TEXTURE_BINDING_2D)
                if (bound) floatWidths.set(bound, Number(rest[0]) || 0)
            }
            return original.texImage2D.call(this, target, level, internalformat, ...rest)
        }
        proto.framebufferTexture2D = function patched(target, attachment, texTarget, tex, level) {
            this.__foldAttachedFloat = Boolean(tex && (floatWidths.get(tex) || 0) > 4)
            return original.framebufferTexture2D.call(this, target, attachment, texTarget, tex, level)
        }
        proto.checkFramebufferStatus = function patched(target) {
            if (this.__foldAttachedFloat) return this.FRAMEBUFFER_UNSUPPORTED
            return original.checkFramebufferStatus.call(this, target)
        }
    }
    disposeRenderer()
    return true
}

const restoreGpu = () => {
    if (!proto || !original) return
    Object.assign(proto, original)
    disposeRenderer()
}

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
    blurBench: megashaderBlurBench,
    bench: megashaderBench,
    metrics: getRenderMetrics,
    resetMetrics: resetRenderMetrics,
    hostileGpu,
    restoreGpu,
}
