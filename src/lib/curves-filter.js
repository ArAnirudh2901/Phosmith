import { filters, classRegistry } from "fabric"

export const LUT_SIZE = 256

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

export const identityLut = () => {
    const lut = new Uint8ClampedArray(LUT_SIZE)
    for (let i = 0; i < LUT_SIZE; i++) lut[i] = i
    return lut
}

const isIdentityLut = (lut) => {
    if (!lut || lut.length !== LUT_SIZE) return true
    for (let i = 0; i < LUT_SIZE; i++) if (lut[i] !== i) return false
    return true
}

// Sort points by x, ensure first and last are clamped to the edges
const normalizePoints = (points) => {
    const arr = (Array.isArray(points) ? points : [])
        .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
        .sort((a, b) => a.x - b.x)
    if (arr.length === 0) return [{ x: 0, y: 0 }, { x: 1, y: 1 }]
    if (arr[0].x > 0) arr.unshift({ x: 0, y: arr[0].y })
    if (arr[arr.length - 1].x < 1) arr.push({ x: 1, y: arr[arr.length - 1].y })
    return arr
}

// Monotonic cubic (Fritsch-Carlson) interpolation — won't overshoot, ideal for LUTs.
const monotonicSlopes = (pts) => {
    const n = pts.length
    const dx = new Array(n - 1)
    const dy = new Array(n - 1)
    const slope = new Array(n - 1)
    for (let i = 0; i < n - 1; i++) {
        dx[i] = pts[i + 1].x - pts[i].x
        dy[i] = pts[i + 1].y - pts[i].y
        slope[i] = dx[i] === 0 ? 0 : dy[i] / dx[i]
    }
    const m = new Array(n)
    m[0] = slope[0] || 0
    m[n - 1] = slope[n - 2] || 0
    for (let i = 1; i < n - 1; i++) {
        if (slope[i - 1] * slope[i] <= 0) {
            m[i] = 0
        } else {
            m[i] = (slope[i - 1] + slope[i]) / 2
        }
    }
    for (let i = 0; i < n - 1; i++) {
        if (slope[i] === 0) {
            m[i] = 0
            m[i + 1] = 0
        } else {
            const a = m[i] / slope[i]
            const b = m[i + 1] / slope[i]
            const s = a * a + b * b
            if (s > 9) {
                const t = 3 / Math.sqrt(s)
                m[i] = t * a * slope[i]
                m[i + 1] = t * b * slope[i]
            }
        }
    }
    return m
}

const evalSegment = (p0, p1, m0, m1, x) => {
    const h = p1.x - p0.x
    if (h === 0) return p0.y
    const t = (x - p0.x) / h
    const t2 = t * t
    const t3 = t2 * t
    const h00 = 2 * t3 - 3 * t2 + 1
    const h10 = t3 - 2 * t2 + t
    const h01 = -2 * t3 + 3 * t2
    const h11 = t3 - t2
    return h00 * p0.y + h10 * h * m0 + h01 * p1.y + h11 * h * m1
}

export const buildLut = (points) => {
    const pts = normalizePoints(points)
    const isIdentity = pts.length === 2 && pts[0].x === 0 && pts[0].y === 0 && pts[1].x === 1 && pts[1].y === 1
    if (isIdentity) return identityLut()
    const slopes = monotonicSlopes(pts)
    const lut = new Uint8ClampedArray(LUT_SIZE)
    let seg = 0
    for (let i = 0; i < LUT_SIZE; i++) {
        const x = i / (LUT_SIZE - 1)
        while (seg < pts.length - 2 && x > pts[seg + 1].x) seg++
        const y = evalSegment(pts[seg], pts[seg + 1], slopes[seg], slopes[seg + 1], x)
        lut[i] = Math.round(clamp01(y) * 255)
    }
    return lut
}

// SVG path data through N points for visual rendering — uses the same Hermite spline.
export const buildCurveSvgPath = (points, viewBox) => {
    const pts = normalizePoints(points)
    const { left, right, top, bottom } = viewBox
    const w = right - left
    const h = bottom - top
    const X = (x) => left + x * w
    const Y = (y) => bottom - y * h
    const slopes = monotonicSlopes(pts)
    let d = `M ${X(pts[0].x).toFixed(2)} ${Y(pts[0].y).toFixed(2)}`
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i]
        const p1 = pts[i + 1]
        const dx = (p1.x - p0.x) / 3
        const c1x = p0.x + dx
        const c1y = p0.y + slopes[i] * dx
        const c2x = p1.x - dx
        const c2y = p1.y - slopes[i + 1] * dx
        d += ` C ${X(c1x).toFixed(2)} ${Y(c1y).toFixed(2)}, ${X(c2x).toFixed(2)} ${Y(c2y).toFixed(2)}, ${X(p1.x).toFixed(2)} ${Y(p1.y).toFixed(2)}`
    }
    return d
}

export const DEFAULT_CURVE_POINTS = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
]

export const arePointsIdentity = (points) => {
    if (!Array.isArray(points) || points.length !== 2) return false
    const [a, b] = points
    return a?.x === 0 && a?.y === 0 && b?.x === 1 && b?.y === 1
}

// Pack the 4 LUTs into a single 256×1 RGBA buffer (R=lutR, G=lutG, B=lutB, A=lutMaster).
// This is uploaded as a WebGL texture so the fragment shader can do four LUT lookups per pixel
// from a single sampler — works inside Fabric's standard texture-unit pattern.
const packLutsRgba = (lutR, lutG, lutB, lutM) => {
    const packed = new Uint8Array(LUT_SIZE * 4)
    for (let i = 0; i < LUT_SIZE; i++) {
        packed[i * 4 + 0] = lutR[i]
        packed[i * 4 + 1] = lutG[i]
        packed[i * 4 + 2] = lutB[i]
        packed[i * 4 + 3] = lutM[i]
    }
    return packed
}

const CURVES_FILTER_TYPE = "PixxelCurves"

const FRAGMENT_SOURCE = `
precision highp float;
uniform sampler2D uTexture;
uniform sampler2D uLut;
varying vec2 vTexCoord;
void main() {
  vec4 color = texture2D(uTexture, vTexCoord);
  // Step 1: per-channel LUT lookup (R from R-row, G from G-row, B from B-row).
  // Each LUT row is encoded in a single RGBA component of the 256×1 LUT texture.
  vec4 lutR_sample = texture2D(uLut, vec2(color.r, 0.5));
  vec4 lutG_sample = texture2D(uLut, vec2(color.g, 0.5));
  vec4 lutB_sample = texture2D(uLut, vec2(color.b, 0.5));
  float r1 = lutR_sample.r;
  float g1 = lutG_sample.g;
  float b1 = lutB_sample.b;
  // Step 2: master LUT applied to each per-channel result (alpha channel of LUT).
  float r = texture2D(uLut, vec2(r1, 0.5)).a;
  float g = texture2D(uLut, vec2(g1, 0.5)).a;
  float b = texture2D(uLut, vec2(b1, 0.5)).a;
  gl_FragColor = vec4(r, g, b, color.a);
}
`

export class PixxelCurvesFilter extends filters.BaseFilter {
    constructor(options = {}) {
        super(options)
        this.lutR = options.lutR || identityLut()
        this.lutG = options.lutG || identityLut()
        this.lutB = options.lutB || identityLut()
        this.lutMaster = options.lutMaster || identityLut()
        this._lutTexture = null
        this._lutTextureKey = null
        this._lutGl = null
    }

    getFragmentSource() {
        return FRAGMENT_SOURCE
    }

    _lutFingerprint() {
        // Cheap fingerprint — short hash of every 16th sample of each LUT. Two
        // identical LUTs map to the same key; modifications change it. Stable across
        // re-renders so the cached GPU texture survives instead of being recreated.
        const hash = (lut) => {
            let h = 0
            for (let i = 0; i < lut.length; i += 16) h = (h * 31 + lut[i]) | 0
            return h
        }
        return `${hash(this.lutR)}_${hash(this.lutG)}_${hash(this.lutB)}_${hash(this.lutMaster)}`
    }

    getCacheKey() {
        return `${this.type}_${this._lutFingerprint()}`
    }

    isNeutralState() {
        return (
            isIdentityLut(this.lutR) &&
            isIdentityLut(this.lutG) &&
            isIdentityLut(this.lutB) &&
            isIdentityLut(this.lutMaster)
        )
    }

    applyTo2d({ imageData }) {
        const data = imageData.data
        const lutR = this.lutR
        const lutG = this.lutG
        const lutB = this.lutB
        const lutM = this.lutMaster
        for (let i = 0; i < data.length; i += 4) {
            const r = lutR[data[i]]
            const g = lutG[data[i + 1]]
            const b = lutB[data[i + 2]]
            data[i] = lutM[r]
            data[i + 1] = lutM[g]
            data[i + 2] = lutM[b]
        }
    }

    applyToWebGL(options) {
        const gl = options.context
        if (!gl) return
        // Cache the LUT texture on the filter instance, only recreating when LUTs change.
        // Deleting a texture mid-draw (the old behavior) made the shader sample from a
        // destroyed texture, which returns black on most drivers — that's why the image
        // disappeared after applying any non-identity curve.
        const fingerprint = this._lutFingerprint()
        if (this._lutGl !== gl) {
            // GL context changed (canvas re-created): drop old texture, it's invalid.
            this._lutTexture = null
            this._lutTextureKey = null
            this._lutGl = gl
        }
        if (!this._lutTexture || this._lutTextureKey !== fingerprint) {
            if (this._lutTexture) gl.deleteTexture(this._lutTexture)
            this._lutTexture = this._createLutTexture(gl)
            this._lutTextureKey = fingerprint
        }
        if (!this._lutTexture) return
        this.bindAdditionalTexture(gl, this._lutTexture, gl.TEXTURE1)
        try {
            super.applyToWebGL(options)
        } finally {
            this.unbindAdditionalTexture(gl, gl.TEXTURE1)
        }
    }

    _createLutTexture(gl) {
        const packed = packLutsRgba(this.lutR, this.lutG, this.lutB, this.lutMaster)
        const texture = gl.createTexture()
        if (!texture) return null
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUT_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, packed)
        gl.bindTexture(gl.TEXTURE_2D, null)
        return texture
    }

    sendUniformData(gl, uniformLocations) {
        // uTexture is bound to TEXTURE0 by Fabric automatically; our LUT is on TEXTURE1.
        gl.uniform1i(uniformLocations.uLut, 1)
    }

    toObject() {
        return {
            ...super.toObject(),
            lutR: Array.from(this.lutR),
            lutG: Array.from(this.lutG),
            lutB: Array.from(this.lutB),
            lutMaster: Array.from(this.lutMaster),
        }
    }

    // Fabric calls this when rehydrating from saved canvas JSON.
    // Plain arrays come back in — convert them back to typed arrays for fast LUT lookup.
    static async fromObject({ lutR, lutG, lutB, lutMaster, ...rest } = {}) {
        const asTyped = (arr) => {
            if (!Array.isArray(arr) || arr.length !== LUT_SIZE) return identityLut()
            const out = new Uint8ClampedArray(LUT_SIZE)
            for (let i = 0; i < LUT_SIZE; i++) out[i] = arr[i] | 0
            return out
        }
        return new PixxelCurvesFilter({
            ...rest,
            lutR: asTyped(lutR),
            lutG: asTyped(lutG),
            lutB: asTyped(lutB),
            lutMaster: asTyped(lutMaster),
        })
    }
}

Object.defineProperty(PixxelCurvesFilter, "type", { value: CURVES_FILTER_TYPE })
Object.defineProperty(PixxelCurvesFilter, "uniformLocations", { value: ["uLut"] })

// Register with Fabric's class registry so loadFromJSON / enliveObjects can rehydrate
// saved canvas state that includes this filter. Without this, projects saved after
// applying curves fail to load with "No class registered for PixxelCurves".
// Calling setClass with no second arg registers BOTH the original type name AND its
// lowercase form, so saved JSON works regardless of which casing Fabric emitted.
classRegistry.setClass(PixxelCurvesFilter)
