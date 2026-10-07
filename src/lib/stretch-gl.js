// GPU renderer for Pixel Stretch: the stretched band drawn as a texture on one
// continuous mesh, the way Photoshop's Free Transform + Warp draws it.
//
// The Canvas2D path draws hundreds of separately clipped affine triangles. Each
// seam needs a sub-pixel overlap, which leaves faint ribs, and a 2D canvas has no
// mipmaps, so stripes squeezed together at a fan or a twist alias into noise.
// Here the mesh shares its vertices (no seams), edges are multisampled, and the
// texture is mipmapped, so a stripe stays crisp when the ribbon spreads and
// averages cleanly where it converges.
//
// Returns null whenever WebGL2 is missing, a context is lost or a draw fails; the
// caller then keeps its Canvas2D path.

const VS = `#version 300 es
in vec2 aPos;
in vec2 aUV;
in float aT;
uniform vec2 uSize;
out vec2 vUV;
out float vT;
void main() {
  vUV = aUV;
  vT = aT;
  vec2 c = aPos / uSize * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`

// Texture is uploaded premultiplied, so mip levels average colour and alpha
// together and the output stays premultiplied for the canvas.
const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uFade;
uniform float uFadeIn;
in vec2 vUV;
in float vT;
out vec4 outColor;
void main() {
  float ramp = max(0.02, uFadeIn * 0.6);
  float a = clamp((1.0 - uFadeIn * (1.0 - min(1.0, vT / ramp))) * (1.0 - uFade * vT), 0.0, 1.0);
  outColor = texture(uTex, vUV) * a;
}`

let state = null

const reset = () => { state = null }

function init() {
  if (state === false) return null
  if (state) return state
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') { state = false; return null }
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1)
  const gl = canvas.getContext('webgl2', {
    alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
    preserveDrawingBuffer: true,
  })
  if (!gl) { state = false; return null }
  canvas.addEventListener?.('webglcontextlost', reset)

  const compile = (type, src) => {
    const sh = gl.createShader(type)
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader')
    return sh
  }
  let prog
  try {
    prog = gl.createProgram()
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link')
  } catch {
    state = false
    return null
  }
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
  state = {
    canvas, gl, prog, aniso,
    maxAniso: aniso ? Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) : 1,
    maxSamples: gl.getParameter(gl.MAX_SAMPLES) || 0,
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    loc: {
      aPos: gl.getAttribLocation(prog, 'aPos'),
      aUV: gl.getAttribLocation(prog, 'aUV'),
      aT: gl.getAttribLocation(prog, 'aT'),
      uSize: gl.getUniformLocation(prog, 'uSize'),
      uTex: gl.getUniformLocation(prog, 'uTex'),
      uFade: gl.getUniformLocation(prog, 'uFade'),
      uFadeIn: gl.getUniformLocation(prog, 'uFadeIn'),
    },
    vao: gl.createVertexArray(),
    bufs: { pos: gl.createBuffer(), uv: gl.createBuffer(), t: gl.createBuffer(), idx: gl.createBuffer() },
    tex: gl.createTexture(),
    texKey: null,
    fbo: null, rb: null, size: '',
  }
  return state
}

/** True when the GPU path can run here. Cheap after the first call. */
export const stretchGLAvailable = () => Boolean(init())

// Multisampled target sized to the frame. Large bakes use fewer samples: an 8×
// 4096² target is half a gigabyte, and edges stop improving visibly past 4.
function ensureTarget(s, W, H) {
  const { gl } = s
  const samples = Math.min(s.maxSamples, W * H > 4e6 ? 2 : 4)
  const key = `${W}x${H}x${samples}`
  if (s.size === key) return true
  if (s.rb) gl.deleteRenderbuffer(s.rb)
  if (s.fbo) gl.deleteFramebuffer(s.fbo)
  s.canvas.width = W
  s.canvas.height = H
  s.rb = gl.createRenderbuffer()
  gl.bindRenderbuffer(gl.RENDERBUFFER, s.rb)
  if (samples > 0) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, W, H)
  else gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, H)
  s.fbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo)
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, s.rb)
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  s.size = ok ? key : ''
  return ok
}

function uploadTexture(s, source, key) {
  const { gl } = s
  if (key && s.texKey === key) return
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, s.tex)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  if (s.aniso) gl.texParameterf(gl.TEXTURE_2D, s.aniso.TEXTURE_MAX_ANISOTROPY_EXT, s.maxAniso)
  s.texKey = key || null
}

/**
 * Draw `meshes` textured with `source` into a W×H premultiplied canvas.
 *
 * A mesh is a cols×rows vertex grid, row-major: `pos` (x, y in px), `uv`
 * (texture coords 0..1) and `t` (0 at the ribbon's root, 1 at its tip, for the
 * fades). Rows draw in order, so later rows land on top where the sheet folds
 * over itself — Photoshop's warp does the same.
 *
 * @returns {HTMLCanvasElement|OffscreenCanvas|null} the GL canvas; draw it
 *   straight away (the next call reuses it), or null to fall back to Canvas2D.
 */
export function renderMeshGL({ source, sourceKey, meshes, W, H, fade = 0, fadeIn = 0 }) {
  // A/B switch for the preview harness: force the Canvas2D path.
  if (globalThis.__phosmithStretchNoGL) return null
  const s = init()
  if (!s) return null
  const { gl, loc } = s
  W = Math.max(1, Math.round(W))
  H = Math.max(1, Math.round(H))
  if (W > s.maxTex || H > s.maxTex || gl.isContextLost()) return null
  if (!source || !(source.width > 0) || !(source.height > 0) || source.width > s.maxTex) return null
  try {
    if (!ensureTarget(s, W, H)) return null
    uploadTexture(s, source, sourceKey)

    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo)
    gl.viewport(0, 0, W, H)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(s.prog)
    gl.uniform2f(loc.uSize, W, H)
    gl.uniform1i(loc.uTex, 0)
    gl.uniform1f(loc.uFade, fade)
    gl.uniform1f(loc.uFadeIn, fadeIn)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindVertexArray(s.vao)

    const attr = (buf, data, location, size) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW)
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0)
    }
    for (const m of meshes) {
      const { cols, rows } = m
      if (!(cols >= 2 && rows >= 2)) continue
      attr(s.bufs.pos, m.pos, loc.aPos, 2)
      attr(s.bufs.uv, m.uv, loc.aUV, 2)
      attr(s.bufs.t, m.t, loc.aT, 1)
      const quads = (cols - 1) * (rows - 1)
      const idx = new Uint32Array(quads * 6)
      let k = 0
      for (let j = 0; j < rows - 1; j++) {
        for (let i = 0; i < cols - 1; i++) {
          const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1
          idx[k++] = a; idx[k++] = b; idx[k++] = c
          idx[k++] = b; idx[k++] = d; idx[k++] = c
        }
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.bufs.idx)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STREAM_DRAW)
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0)
    }
    gl.bindVertexArray(null)

    // Resolve the multisampled target into the canvas the caller draws.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.fbo)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) return null
    return s.canvas
  } catch {
    return null
  }
}

/** Ribbon sections ({ cx, cy, nx, ny, hw }, root → tip) as a two-column mesh. */
/** Drop the render target and texture; a bake leaves them at full image size. */
export function releaseStretchGL() {
  if (!state) return
  const { gl } = state
  if (state.rb) gl.deleteRenderbuffer(state.rb)
  if (state.fbo) gl.deleteFramebuffer(state.fbo)
  state.rb = null
  state.fbo = null
  state.size = ''
  gl.bindTexture(gl.TEXTURE_2D, state.tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  state.texKey = null
  state.canvas.width = 1
  state.canvas.height = 1
}

export function sectionsToMesh(sections) {
  const n = sections.length
  const pos = new Float32Array(n * 4)
  const uv = new Float32Array(n * 4)
  const t = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const s = sections[i]
    const ti = s.t ?? (n > 1 ? i / (n - 1) : 0)
    pos[i * 4] = s.cx - s.nx * s.hw
    pos[i * 4 + 1] = s.cy - s.ny * s.hw
    pos[i * 4 + 2] = s.cx + s.nx * s.hw
    pos[i * 4 + 3] = s.cy + s.ny * s.hw
    uv[i * 4] = 0; uv[i * 4 + 1] = 0.5
    uv[i * 4 + 2] = 1; uv[i * 4 + 3] = 0.5
    t[i * 2] = ti
    t[i * 2 + 1] = ti
  }
  return { cols: 2, rows: n, pos, uv, t }
}
