(() => {
  // ../../src/lib/megashader/glsl-mask-kinds.js
  var LUMINANCE_SCHEMA = {
    kind: "luminance",
    uniforms: [
      { name: "min", glsl: "uLayer_<S>_kind_luminance_min", type: "float", min: 0, max: 1, default: 0 },
      { name: "max", glsl: "uLayer_<S>_kind_luminance_max", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "softness", glsl: "uLayer_<S>_kind_luminance_softness", type: "float", min: 0, max: 1, default: 0.1 }
    ]
  };
  var COLOR_SCHEMA = {
    kind: "color",
    uniforms: [
      { name: "targetH", glsl: "uLayer_<S>_kind_color_targetH", type: "float", min: 0, max: 360, default: 0 },
      { name: "targetS", glsl: "uLayer_<S>_kind_color_targetS", type: "float", min: 0, max: 1, default: 1 },
      { name: "targetB", glsl: "uLayer_<S>_kind_color_targetB", type: "float", min: 0, max: 1, default: 1 },
      { name: "tolerance", glsl: "uLayer_<S>_kind_color_tolerance", type: "float", min: 0, max: 1, default: 0.15 },
      { name: "softness", glsl: "uLayer_<S>_kind_color_softness", type: "float", min: 0, max: 1, default: 0.1 }
    ]
  };
  var LINEAR_SCHEMA = {
    kind: "linear",
    uniforms: [
      { name: "p1", glsl: "uLayer_<S>_kind_linear_p1", type: "vec2", min: 0, max: 1e5, default: [0, 0] },
      { name: "p2", glsl: "uLayer_<S>_kind_linear_p2", type: "vec2", min: 0, max: 1e5, default: [100, 0] },
      { name: "position", glsl: "uLayer_<S>_kind_linear_position", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "feather", glsl: "uLayer_<S>_kind_linear_feather", type: "float", min: 0, max: 1, default: 0.1 }
    ]
  };
  var RADIAL_SCHEMA = {
    kind: "radial",
    uniforms: [
      { name: "center", glsl: "uLayer_<S>_kind_radial_center", type: "vec2", min: 0, max: 1e5, default: [50, 50] },
      { name: "rotation", glsl: "uLayer_<S>_kind_radial_rotation", type: "float", min: 0, max: 6.2832, default: 0 },
      { name: "radius", glsl: "uLayer_<S>_kind_radial_radius", type: "vec2", min: 0.001, max: 1e5, default: [50, 50] },
      { name: "feather", glsl: "uLayer_<S>_kind_radial_feather", type: "float", min: 0, max: 1, default: 0.1 }
    ]
  };
  var SEMANTIC_SCHEMA = {
    kind: "semantic",
    uniforms: [
      { name: "feather", glsl: "uLayer_<S>_kind_semantic_feather", type: "float", min: 0, max: 1, default: 0.1 }
    ],
    samplers: [
      { name: "mask", glsl: "uLayer_<S>_kind_semantic_mask" }
    ]
  };
  var DEPTH_SCHEMA = {
    kind: "depth",
    uniforms: [
      { name: "min", glsl: "uLayer_<S>_kind_depth_min", type: "float", min: 0, max: 1, default: 0 },
      { name: "max", glsl: "uLayer_<S>_kind_depth_max", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "softness", glsl: "uLayer_<S>_kind_depth_softness", type: "float", min: 0, max: 1, default: 0.1 }
    ],
    samplers: [
      { name: "map", glsl: "uLayer_<S>_kind_depth_map" }
    ]
  };
  var SMART_BRUSH_SCHEMA = {
    kind: "smartBrush",
    uniforms: [
      { name: "filterRadius", glsl: "uLayer_<S>_kind_smartBrush_filterRadius", type: "float", min: 1, max: 8, default: 3 },
      { name: "sigmaColor", glsl: "uLayer_<S>_kind_smartBrush_sigmaColor", type: "float", min: 0.01, max: 1, default: 0.15 },
      { name: "sigmaSpace", glsl: "uLayer_<S>_kind_smartBrush_sigmaSpace", type: "float", min: 0.01, max: 8, default: 2 }
    ],
    samplers: [
      { name: "brush", glsl: "uLayer_<S>_kind_smartBrush_brush" }
    ]
  };
  var LASSO_SCHEMA = {
    kind: "lasso",
    uniforms: [
      { name: "feather", glsl: "uLayer_<S>_kind_lasso_feather", type: "float", min: 0, max: 1, default: 0.05 }
    ],
    samplers: [
      { name: "mask", glsl: "uLayer_<S>_kind_lasso_mask" }
    ]
  };
  var BRUSH_SCHEMA = {
    kind: "brush",
    uniforms: [],
    samplers: [
      { name: "mask", glsl: "uLayer_<S>_kind_brush_mask" }
    ]
  };
  var PATH_SCHEMA = {
    kind: "path",
    uniforms: [
      { name: "feather", glsl: "uLayer_<S>_kind_path_feather", type: "float", min: 0, max: 1, default: 0.04 }
    ],
    samplers: [
      { name: "mask", glsl: "uLayer_<S>_kind_path_mask" }
    ]
  };
  var KIND_SCHEMAS = {
    luminance: LUMINANCE_SCHEMA,
    color: COLOR_SCHEMA,
    linear: LINEAR_SCHEMA,
    radial: RADIAL_SCHEMA,
    smartBrush: SMART_BRUSH_SCHEMA,
    semantic: SEMANTIC_SCHEMA,
    depth: DEPTH_SCHEMA,
    lasso: LASSO_SCHEMA,
    brush: BRUSH_SCHEMA,
    path: PATH_SCHEMA
  };
  var buildLuminance = (slot) => `
        uniform float uLayer_${slot}_kind_luminance_min;
        uniform float uLayer_${slot}_kind_luminance_max;
        uniform float uLayer_${slot}_kind_luminance_softness;

        float evalLayer_${slot}_body() {
            vec3 rgb = texture2D(uImage, vTextureCoord).rgb;
            float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));

            float lo = uLayer_${slot}_kind_luminance_min;
            float hi = uLayer_${slot}_kind_luminance_max;
            // GLSL ES 1.00's smoothstep(a, a, x) is undefined (some
            // drivers return step(a, x), some return 0/1 nondeterministically,
            // some NaN). The UI's softness slider goes down to 0, so we
            // floor to 0.001 here — same defence the linear/radial/depth
            // masks use for their feather field. The visible effect of
            // softness=0.001 vs 0 is sub-pixel and imperceptible.
            float soft = max(uLayer_${slot}_kind_luminance_softness, 0.001);
            // Lower-edge smoothstep: ramps from 0 (below lo) to 1 (above lo).
            float a = smoothstep(lo - soft, lo + soft, luma);
            // Upper-edge inverted: 1 (below hi) ramps to 0 (above hi).
            float b = 1.0 - smoothstep(hi - soft, hi + soft, luma);
            return clamp(a * b, 0.0, 1.0);
        }
    `;
  var buildColor = (slot) => `
        uniform float uLayer_${slot}_kind_color_targetH;
        uniform float uLayer_${slot}_kind_color_targetS;
        uniform float uLayer_${slot}_kind_color_targetB;
        uniform float uLayer_${slot}_kind_color_tolerance;
        uniform float uLayer_${slot}_kind_color_softness;

        float evalLayer_${slot}_body() {
            vec3 rgb = texture2D(uImage, vTextureCoord).rgb;
            vec3 hsb = rgbToHsb(rgb);

            // Cyclic hue distance in degrees, normalised to 0..1.
            float diffH = abs(hsb.x - uLayer_${slot}_kind_color_targetH);
            float dh = min(diffH, 360.0 - diffH) / 180.0;
            float ds = abs(hsb.y - uLayer_${slot}_kind_color_targetS);
            float db = abs(hsb.z - uLayer_${slot}_kind_color_targetB);

            // Combined metric — hue dominates (0.5), S+B split the rest.
            float d = dh * 0.5 + ds * 0.25 + db * 0.25;

            float tol = uLayer_${slot}_kind_color_tolerance;
            // Floor softness to 0.001 — see the luminance body's comment
            // for why GLSL ES 1.00's smoothstep(a, a, x) is undefined.
            float soft = max(uLayer_${slot}_kind_color_softness, 0.001);
            // 1 inside the tolerance, smoothly to 0 at tol + soft.
            return 1.0 - smoothstep(tol - soft, tol + soft, d);
        }
    `;
  var buildLinear = (slot) => `
        uniform vec2  uLayer_${slot}_kind_linear_p1;
        uniform vec2  uLayer_${slot}_kind_linear_p2;
        uniform float uLayer_${slot}_kind_linear_position;
        uniform float uLayer_${slot}_kind_linear_feather;

        float evalLayer_${slot}_body() {
            // Y-flip: the source texture is uploaded with UNPACK_FLIP_Y_WEBGL,
            // so vTextureCoord is GL-Y-up, but p1/p2 are authored in canvas-
            // Y-down image space. Flip Y here so the gradient lands where the
            // user dragged instead of vertically mirrored.
            vec2 pixelPos = vec2(vTextureCoord.x, 1.0 - vTextureCoord.y) * uImageSize;
            vec2 p1 = uLayer_${slot}_kind_linear_p1;
            vec2 p2 = uLayer_${slot}_kind_linear_p2;
            vec2 d = p2 - p1;
            float len2 = dot(d, d);
            // t in 0..1 along the segment (clamps past endpoints naturally
            // because abs(t - position) grows without bound outside the line).
            float t = (len2 > 0.0001) ? dot(pixelPos - p1, d) / len2 : 0.0;
            float pos = uLayer_${slot}_kind_linear_position;
            float feather = uLayer_${slot}_kind_linear_feather;
            float offset = abs(t - pos);
            float halfWidth = max(feather, 0.001);
            return 1.0 - smoothstep(0.0, halfWidth, offset);
        }
    `;
  var buildRadial = (slot) => `
        uniform vec2  uLayer_${slot}_kind_radial_center;
        uniform float uLayer_${slot}_kind_radial_rotation;
        uniform vec2  uLayer_${slot}_kind_radial_radius;
        uniform float uLayer_${slot}_kind_radial_feather;

        float evalLayer_${slot}_body() {
            // Y-flip: see buildLinear — center/rotation are authored in
            // canvas-Y-down image space, vTextureCoord is GL-Y-up.
            vec2 pixelPos = vec2(vTextureCoord.x, 1.0 - vTextureCoord.y) * uImageSize;
            vec2 c = uLayer_${slot}_kind_radial_center;
            float rot = uLayer_${slot}_kind_radial_rotation;
            vec2 r = uLayer_${slot}_kind_radial_radius;

            vec2 d = pixelPos - c;
            // Undo the ellipse's rotation so the ellipse is axis-aligned
            // in this frame.
            float cR = cos(-rot);
            float sR = sin(-rot);
            vec2 rotated = vec2(d.x * cR - d.y * sR, d.x * sR + d.y * cR);
            // Normalise by the half-axes; r=1 is the ellipse boundary.
            vec2 normalised = rotated / r;
            float dist = length(normalised);

            float feather = uLayer_${slot}_kind_radial_feather;
            float halfWidth = max(feather, 0.001);
            return 1.0 - smoothstep(1.0 - halfWidth, 1.0 + halfWidth, dist);
        }
    `;
  var buildSemantic = (slot) => `
        uniform sampler2D uLayer_${slot}_kind_semantic_mask;
        uniform float uLayer_${slot}_kind_semantic_feather;

        float evalLayer_${slot}_body() {
            float raw = texture2D(uLayer_${slot}_kind_semantic_mask, vTextureCoord).r;
            float feather = max(uLayer_${slot}_kind_semantic_feather, 0.001);
            // Smooth the transition around 0.5 with a symmetric half-width
            // of 'feather'. For a binary mask the smoothstep is a no-op
            // (edges are still hard); for a soft mask it widens the
            // transition band.
            return 1.0 - smoothstep(0.5 - feather, 0.5 + feather, 1.0 - raw);
        }
    `;
  var buildDepth = (slot) => `
        uniform sampler2D uLayer_${slot}_kind_depth_map;
        uniform float uLayer_${slot}_kind_depth_min;
        uniform float uLayer_${slot}_kind_depth_max;
        uniform float uLayer_${slot}_kind_depth_softness;

        float evalLayer_${slot}_body() {
            float depth = texture2D(uLayer_${slot}_kind_depth_map, vTextureCoord).r;
            float dMin = uLayer_${slot}_kind_depth_min;
            float dMax = uLayer_${slot}_kind_depth_max;
            float soft = max(uLayer_${slot}_kind_depth_softness, 0.001);
            // Two-edge smoothstep band: ramp up at dMin, ramp down at dMax.
            // a * b clamps to 0..1 in one multiply; both a and b are
            // already clamped by smoothstep.
            float a = smoothstep(dMin - soft, dMin + soft, depth);
            float b = 1.0 - smoothstep(dMax - soft, dMax + soft, depth);
            return clamp(a * b, 0.0, 1.0);
        }
    `;
  var buildSmartBrush = (slot) => `
        uniform sampler2D uLayer_${slot}_kind_smartBrush_brush;
        uniform float uLayer_${slot}_kind_smartBrush_filterRadius;
        uniform float uLayer_${slot}_kind_smartBrush_sigmaColor;
        uniform float uLayer_${slot}_kind_smartBrush_sigmaSpace;

        float evalLayer_${slot}_body() {
            // Compile-time loop bound. The runtime filterRadius is the
            // actual cutoff (see the abs(dx)/abs(dy) > radiusI guards).
            const int MAX_RADIUS = 8;
            int radiusI = int(uLayer_${slot}_kind_smartBrush_filterRadius + 0.5);
            if (radiusI < 1) radiusI = 1;
            if (radiusI > MAX_RADIUS) radiusI = MAX_RADIUS;

            // Floor the sigmas to keep the Gaussian weight finite even
            // if the uniform comes in as 0 (schema enforces 0.01 min,
            // this is a defense-in-depth for direct uniform writes).
            float sigmaColor = max(uLayer_${slot}_kind_smartBrush_sigmaColor, 0.01);
            float sigmaSpace = max(uLayer_${slot}_kind_smartBrush_sigmaSpace, 0.01);
            float inv2SC = 1.0 / (2.0 * sigmaColor * sigmaColor);
            float inv2SS = 1.0 / (2.0 * sigmaSpace * sigmaSpace);

            // Centre pixel's source-image colour drives the colour-weight
            // distance. texture2D returns vec4 — we only need .rgb.
            vec3 centerColor = texture2D(uImage, vTextureCoord).rgb;
            float centerBrush = texture2D(uLayer_${slot}_kind_smartBrush_brush, vTextureCoord).r;

            // The user-painted brush alpha already excludes a lot of
            // background — if the centre is 0, the filter result should
            // also be near 0. Run a quick early-out: if the centre alpha
            // is below a tiny threshold AND none of the 4-neighbours
            // have any alpha, return 0. This skips the inner loop in
            // the common "clicked-once-and-moved" case where most of the
            // image is empty.
            float sumBrush = 0.0;
            float sumWeight = 0.0;

            for (int dy = -MAX_RADIUS; dy <= MAX_RADIUS; dy += 1) {
                for (int dx = -MAX_RADIUS; dx <= MAX_RADIUS; dx += 1) {
                    // Skip neighbours outside the actual radius. Using a
                    // continue instead of two nested loops so the loop
                    // bounds stay GLSL-ES-1.00-legal.
                    if (abs(dx) > radiusI) continue;
                    if (abs(dy) > radiusI) continue;
                    vec2 offset = vec2(float(dx), float(dy)) / uImageSize;
                    vec2 sampleUV = vTextureCoord + offset;
                    // Defensive clamp: CLAMP_TO_EDGE on the texture means
                    // the sample is bounded to the image, but if the
                    // uniform is misconfigured the loop could wander
                    // outside [0,1] and produce undefined output.
                    sampleUV = clamp(sampleUV, vec2(0.0), vec2(1.0));

                    vec3 neighborColor = texture2D(uImage, sampleUV).rgb;
                    float neighborBrush = texture2D(uLayer_${slot}_kind_smartBrush_brush, sampleUV).r;

                    // Spatial weight — Gaussian over pixel distance.
                    float r2 = float(dx * dx + dy * dy);
                    float wSpace = exp(-r2 * inv2SS);

                    // Colour weight — Gaussian over RGB distance.
                    vec3 dC = neighborColor - centerColor;
                    float dc2 = dot(dC, dC);
                    float wColor = exp(-dc2 * inv2SC);

                    float w = wSpace * wColor;
                    sumBrush += w * neighborBrush;
                    sumWeight += w;
                }
            }

            // Degenerate-window fallback: every neighbour's colour is
            // outside the colour Gaussian (e.g. centre pixel sits on a
            // hard edge with no nearby same-colour pixels). Returning
            // the raw centerBrush would bypass the bilateral filter
            // entirely and leak the unfiltered painted alpha at the
            // boundary of every stroke. 0.0 is the correct result — the
            // filter found no similar neighbours, so the output is no
            // contribution. The strict > guards the divide and the 1e-6
            // epsilon avoids a divide-by-near-zero on mediump hardware
            // where exp(-large) can underflow to exactly 0 and then
            // sumBrush can be a small but non-zero tail.
            return sumWeight > 1e-6 ? (sumBrush / sumWeight) : 0.0;
        }
    `;
  var buildLasso = (slot) => `
        uniform sampler2D uLayer_${slot}_kind_lasso_mask;
        uniform float uLayer_${slot}_kind_lasso_feather;

        float evalLayer_${slot}_body() {
            float raw = texture2D(uLayer_${slot}_kind_lasso_mask, vTextureCoord).r;
            float feather = max(uLayer_${slot}_kind_lasso_feather, 0.001);
            // raw ~1 inside the polygon, ~0 outside. Smoothstep around 0.5
            // widens the (already anti-aliased) edge when feather > 0.
            return smoothstep(0.5 - feather, 0.5 + feather, raw);
        }
    `;
  var buildBrush = (slot) => `
        uniform sampler2D uLayer_${slot}_kind_brush_mask;

        float evalLayer_${slot}_body() {
            // The painted brush alpha carries the soft falloff in the A
            // channel; clamp for safety on mediump hardware.
            return clamp(texture2D(uLayer_${slot}_kind_brush_mask, vTextureCoord).a, 0.0, 1.0);
        }
    `;
  var buildPath = (slot) => `
        uniform sampler2D uLayer_${slot}_kind_path_mask;
        uniform float uLayer_${slot}_kind_path_feather;

        float evalLayer_${slot}_body() {
            float raw = texture2D(uLayer_${slot}_kind_path_mask, vTextureCoord).r;
            float feather = max(uLayer_${slot}_kind_path_feather, 0.001);
            return smoothstep(0.5 - feather, 0.5 + feather, raw);
        }
    `;
  var KIND_BUILDERS = {
    luminance: buildLuminance,
    color: buildColor,
    linear: buildLinear,
    radial: buildRadial,
    semantic: buildSemantic,
    depth: buildDepth,
    smartBrush: buildSmartBrush,
    lasso: buildLasso,
    brush: buildBrush,
    path: buildPath
  };
  var getKindBuilder = (kind) => {
    const builder = KIND_BUILDERS[kind];
    if (!builder) {
      throw new Error(`[megashader] getKindBuilder: unknown mask kind "${kind}"`);
    }
    return builder;
  };
  var getKindSchema = (kind) => {
    const schema = KIND_SCHEMAS[kind];
    if (!schema) {
      throw new Error(`[megashader] getKindSchema: unknown mask kind "${kind}"`);
    }
    return schema;
  };
  var normaliseUniformValue = (raw, field) => {
    const { type, min, max, default: def } = field;
    if (type === "float") {
      if (typeof raw === "number" && Number.isFinite(raw)) {
        return Math.max(min, Math.min(max, raw));
      }
      return def;
    }
    const wantLen = type === "vec2" ? 2 : type === "vec3" ? 3 : 0;
    if (wantLen === 0)
      return def;
    const clamp = (v) => typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : null;
    if (Array.isArray(raw) && raw.length >= wantLen) {
      const out = [];
      for (let i = 0;i < wantLen; i += 1) {
        const c = clamp(raw[i]);
        out.push(c === null ? 0 : c);
      }
      return out;
    }
    if (raw && typeof raw === "object") {
      const obj = raw;
      const out = [];
      for (let i = 0;i < wantLen; i += 1) {
        const c = clamp(obj[String.fromCharCode(120 + i)]);
        out.push(c === null ? 0 : c);
      }
      return out;
    }
    return def;
  };

  // ../../src/lib/megashader/glsl-fragments.js
  var buildVertexShader = () => `
    attribute vec2 aPosition;
    varying vec2 vTextureCoord;
    uniform mat4 uMatrix;

    void main() {
        vTextureCoord = aPosition * 0.5 + 0.5;
        gl_Position = uMatrix * vec4(aPosition, 0.0, 1.0);
    }
`;
  var buildFragmentTemplate = () => `
    precision highp float;

    varying vec2 vTextureCoord;

    uniform sampler2D uImage;
    uniform sampler2D uDepthMap;
    uniform sampler2D uSemanticMask;
    uniform sampler2D uBrushTex;

    // Source image dimensions in pixels. Spatial mask kinds (linear,
    // radial) use this to convert the 0..1 vTextureCoord into image-
    // space pixels so their P1/P2/center/radius uniforms land on the
    // same coordinate system as the source. The renderer uploads this
    // from sourceCanvas.width/height once per draw.
    uniform vec2 uImageSize;

    uniform float uMaskAlpha;

    // Chain-wide controls. uGlobalInvert (0/1) flips the whole composited
    // selection; uMaskOverlay (0/1) switches to a "show selected area"
    // visualisation tinted with uMaskOverlayColor (Quick-Mask / Lightroom
    // red overlay) instead of applying the edit.
    uniform float uGlobalInvert;
    uniform float uMaskOverlay;
    uniform vec3 uMaskOverlayColor;

    {{MASK_FUNCTIONS}}

    {{ADJUST_FUNCTIONS}}

    {{EVAL_DISPATCHER}}

    /**
     * Branchless RGB → HSB conversion (Hue in degrees 0..360, S and B 0..1).
     * Standard implementation, included up-front so Step 2's color mask can
     * call it without a separate code path.
     */
    vec3 rgbToHsb(vec3 c) {
        float maxC = max(max(c.r, c.g), c.b);
        float minC = min(min(c.r, c.g), c.b);
        float delta = maxC - minC;
        float b = maxC;
        float s = (maxC == 0.0) ? 0.0 : (delta / maxC);
        float h = 0.0;
        if (delta > 0.0) {
            if (maxC == c.r)      h = ((c.g - c.b) / delta) + (c.g < c.b ? 6.0 : 0.0);
            else if (maxC == c.g) h = ((c.b - c.r) / delta) + 2.0;
            else                  h = ((c.r - c.g) / delta) + 4.0;
            h *= 60.0;
        }
        return vec3(h, s, b);
    }

    void main() {
        vec4 src = texture2D(uImage, vTextureCoord);
        vec3 srcRgb = src.rgb;

        {{BOOLEAN_CHAIN}}

        // Global invert flips the whole composited selection (Lightroom
        // "Invert mask"). Applied to both the recolour and erase channels so
        // the inverted region is what gets edited / cut.
        runningAlpha = mix(runningAlpha, 1.0 - runningAlpha, uGlobalInvert);
        eraseAlpha = mix(eraseAlpha, 1.0 - eraseAlpha, uGlobalInvert);

        // "Show mask" visualisation: tint the selected region with the
        // overlay colour instead of applying the edit, so the user sees
        // exactly what's masked (select + erase coverage). Short-circuits
        // the normal output path.
        if (uMaskOverlay > 0.5) {
            float cover = clamp(max(runningAlpha, eraseAlpha) * uMaskAlpha, 0.0, 1.0);
            gl_FragColor = vec4(mix(srcRgb, uMaskOverlayColor, cover), src.a);
            return;
        }

        // Combine the per-layer chain alpha, the per-layer invert/visible
        // flags (already baked into the chain by the compiler), and the
        // global mask-alpha fader into a final 0..1 blend factor. The
        // runningColor is the per-layer-adjusted (or fill-tinted) colour
        // that survived the boolean compositing — it's the colour to show
        // "inside" the mask.
        float a = clamp(runningAlpha * uMaskAlpha, 0.0, 1.0);
        vec3 outRgb = mix(srcRgb, runningColor, a);

        // Erase output path: any layer in 'erase' fillMode accumulates into
        // eraseAlpha (the alpha-knockout channel, kept separate from the
        // recolour channel above). The masked region becomes transparent so
        // the pixels are cut out of the image — this is what makes a lasso/
        // brush "erase" produce a visible result even with no colour change.
        float eraseFactor = clamp(eraseAlpha * uMaskAlpha, 0.0, 1.0);
        float outA = src.a * (1.0 - eraseFactor);
        gl_FragColor = vec4(outRgb, outA);
    }
`;
  var buildLayerFunction = (slotIndex, kind, params = {}) => {
    const uniformPrefix = `uLayer_${slotIndex}`;
    const commonUniforms = `
        uniform float ${uniformPrefix}_opacity;
        uniform float ${uniformPrefix}_inverted;
        uniform float ${uniformPrefix}_visible;
    `;
    const commonApply = `
        float raw = evalLayer_${slotIndex}_body();
        if (${uniformPrefix}_inverted > 0.5) raw = 1.0 - raw;
        raw = raw * ${uniformPrefix}_visible;
        return clamp(raw * ${uniformPrefix}_opacity, 0.0, 1.0);
    `;
    const builder = getKindBuilder(kind);
    const bodyFn = builder(slotIndex);
    return `
        ${bodyFn}
        ${commonUniforms}
        float evalLayer_${slotIndex}() {
            ${commonApply}
        }
    `;
  };
  var buildLayerAdjustFunction = (slotIndex, params = {}) => {
    const e = `uLayer_${slotIndex}_adjust_exposure`;
    const c = `uLayer_${slotIndex}_adjust_contrast`;
    const s = `uLayer_${slotIndex}_adjust_saturation`;
    const b = `uLayer_${slotIndex}_adjust_brightness`;
    const hi = `uLayer_${slotIndex}_adjust_highlights`;
    const sh = `uLayer_${slotIndex}_adjust_shadows`;
    const wh = `uLayer_${slotIndex}_adjust_whites`;
    const bk = `uLayer_${slotIndex}_adjust_blacks`;
    const tp = `uLayer_${slotIndex}_adjust_temperature`;
    const tn = `uLayer_${slotIndex}_adjust_tint`;
    const vb = `uLayer_${slotIndex}_adjust_vibrance`;
    const tx = `uLayer_${slotIndex}_adjust_texture`;
    const dh = `uLayer_${slotIndex}_adjust_dehaze`;
    const fm = `uLayer_${slotIndex}_fillMode`;
    const fc = `uLayer_${slotIndex}_fillColor`;
    const fs = `uLayer_${slotIndex}_fillStrength`;
    return `
        uniform float ${e};
        uniform float ${c};
        uniform float ${s};
        uniform float ${b};
        uniform float ${hi};
        uniform float ${sh};
        uniform float ${wh};
        uniform float ${bk};
        uniform float ${tp};
        uniform float ${tn};
        uniform float ${vb};
        uniform float ${tx};
        uniform float ${dh};
        uniform float ${fm};
        uniform vec3  ${fc};
        uniform float ${fs};

        vec3 applyLayerAdjust_${slotIndex}(vec3 rgb) {
            // Early-out: identity adjustments. Saves the per-pixel cost for
            // the common "no-op adjust" case (a freshly created layer before
            // the user touches any slider). All thirteen fields must be 0.
            if (${e} == 0.0 && ${c} == 0.0 && ${s} == 0.0 && ${b} == 0.0
                && ${hi} == 0.0 && ${sh} == 0.0 && ${wh} == 0.0 && ${bk} == 0.0
                && ${tp} == 0.0 && ${tn} == 0.0 && ${vb} == 0.0
                && ${tx} == 0.0 && ${dh} == 0.0) {
                return rgb;
            }

            // Exposure: multiply by 2^stops. Defensive clamp even though
            // sanitiseLayer already clamps to [-3, 3].
            rgb *= pow(2.0, clamp(${e}, -3.0, 3.0));

            // White balance — Temperature (warm/cool) shifts R up & B down;
            // Tint (magenta/green) shifts the green channel. Scaled small so
            // the -100..100 slider range stays usable.
            rgb.r += ${tp} * 0.005;
            rgb.b -= ${tp} * 0.005;
            rgb.g -= ${tn} * 0.005;
            rgb = clamp(rgb, 0.0, 1.0);

            // Brightness: additive in normalized 0..1 space.
            rgb += ${b} * 0.01;

            // Tonal regions — weight each adjustment by the pixel's luma so
            // Highlights/Whites act on bright tones and Shadows/Blacks on
            // dark tones (Lightroom-style local tone curve).
            float lumT = dot(clamp(rgb, 0.0, 1.0), vec3(0.2126, 0.7152, 0.0722));
            float wHi = smoothstep(0.5, 1.0, lumT);
            float wWh = smoothstep(0.7, 1.0, lumT);
            float wSh = 1.0 - smoothstep(0.0, 0.5, lumT);
            float wBk = 1.0 - smoothstep(0.0, 0.3, lumT);
            rgb += (${hi} * 0.01) * wHi;
            rgb += (${wh} * 0.01) * wWh;
            rgb += (${sh} * 0.01) * wSh;
            rgb += (${bk} * 0.01) * wBk;
            rgb = clamp(rgb, 0.0, 1.0);

            // Contrast: pull toward 0.5 by (x - 0.5) * (1 + c) + 0.5.
            float cLocal = ${c} * 0.01;
            rgb = clamp((rgb - 0.5) * (1.0 + cLocal) + 0.5, 0.0, 1.0);

            // Saturation: lerp toward luminance, then re-mix. s = -100
            // desaturates fully (mix to lum); s = +100 doubles the
            // deviation from grey.
            float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
            rgb = mix(vec3(lum), rgb, 1.0 + ${s} * 0.01);

            // Vibrance: a smarter saturation that protects pixels that are
            // already vivid (and skin tones) by scaling the boost by the
            // pixel's current saturation. satC = max-min channel spread.
            float vbAmt = ${vb} * 0.01;
            float vMax = max(rgb.r, max(rgb.g, rgb.b));
            float vMin = min(rgb.r, min(rgb.g, rgb.b));
            float satC = vMax - vMin;                 // 0 (grey) .. 1 (pure hue)
            float lumV = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
            rgb = mix(vec3(lumV), rgb, 1.0 + vbAmt * (1.0 - satC));

            // Detail (Texture / Dehaze) — LOCAL contrast, so they sample the
            // SOURCE neighbourhood (uImage) using uImageSize for the texel step.
            // Guarded so the extra texture reads only cost when actually used.
            if (${tx} != 0.0 || ${dh} != 0.0) {
                vec2 texel = 1.0 / max(uImageSize, vec2(1.0, 1.0));
                vec3 LW = vec3(0.2126, 0.7152, 0.0722);
                if (${tx} != 0.0) {
                    // Texture / clarity: mid-frequency local contrast =
                    // source luma minus its 3×3 mean (unsharp mask on luma).
                    float m = 0.0;
                    m += dot(texture2D(uImage, vTextureCoord + texel * vec2(-1.0, -1.0)).rgb, LW);
                    m += dot(texture2D(uImage, vTextureCoord + texel * vec2( 0.0, -1.0)).rgb, LW);
                    m += dot(texture2D(uImage, vTextureCoord + texel * vec2( 1.0, -1.0)).rgb, LW);
                    m += dot(texture2D(uImage, vTextureCoord + texel * vec2(-1.0,  0.0)).rgb, LW);
                    m += dot(texture2D(uImage, vTextureCoord + texel * vec2( 1.0,  0.0)).rgb, LW);
                    m += dot(texture2D(uImage, vTextureCoord + texel * vec2(-1.0,  1.0)).rgb, LW);
                    m += dot(texture2D(uImage, vTextureCoord + texel * vec2( 0.0,  1.0)).rgb, LW);
                    m += dot(texture2D(uImage, vTextureCoord + texel * vec2( 1.0,  1.0)).rgb, LW);
                    float srcL = dot(texture2D(uImage, vTextureCoord).rgb, LW);
                    float detail = srcL - (m / 8.0);
                    rgb += (${tx} * 0.01) * detail * 2.0;
                }
                if (${dh} != 0.0) {
                    // Dehaze: local-contrast + saturation lift (negative = add
                    // haze / soften). Mean colour from a wider source sample.
                    float d = ${dh} * 0.01;
                    vec3 meanC = (
                        texture2D(uImage, vTextureCoord + texel * vec2(-3.0,  0.0)).rgb +
                        texture2D(uImage, vTextureCoord + texel * vec2( 3.0,  0.0)).rgb +
                        texture2D(uImage, vTextureCoord + texel * vec2( 0.0, -3.0)).rgb +
                        texture2D(uImage, vTextureCoord + texel * vec2( 0.0,  3.0)).rgb
                    ) * 0.25;
                    rgb += d * 0.5 * (rgb - meanC);
                    float gD = dot(clamp(rgb, 0.0, 1.0), LW);
                    rgb = mix(vec3(gD), rgb, 1.0 + d * 0.4);
                }
                rgb = clamp(rgb, 0.0, 1.0);
            }

            return clamp(rgb, 0.0, 1.0);
        }

        // The colour this layer contributes "inside" its mask. In 'fill'
        // mode (fillMode == 1) it's the fill colour mixed over the adjusted
        // source by fillStrength; otherwise it's just the adjusted source.
        // 'erase' (fillMode == 2) leaves the colour as the adjusted source —
        // the cut happens on the alpha side, not the colour side.
        vec3 layerColor_${slotIndex}(vec3 rgb) {
            vec3 adjusted = applyLayerAdjust_${slotIndex}(rgb);
            if (${fm} > 0.5 && ${fm} < 1.5) {
                return mix(adjusted, ${fc}, clamp(${fs}, 0.0, 1.0));
            }
            return adjusted;
        }
    `;
  };
  var buildBooleanChain = (chainEntries) => {
    if (!chainEntries || chainEntries.length === 0) {
      return `
            vec3 runningColor = srcRgb;
            float runningAlpha = 0.0;
            float eraseAlpha = 0.0;
        `;
    }
    const lines = [];
    lines.push(`float eraseAlpha = 0.0;`);
    const preamble = (i) => {
      lines.push(`float aFull_${i} = evalLayer(${i});`);
      lines.push(`float isErase_${i} = step(1.5, uLayer_${i}_fillMode);`);
      lines.push(`float a_${i} = aFull_${i} * (1.0 - isErase_${i});`);
      lines.push(`vec3 c_${i} = layerColor_${i}(srcRgb);`);
      lines.push(`eraseAlpha = max(eraseAlpha, aFull_${i} * isErase_${i});`);
    };
    preamble(0);
    lines.push(`vec3 runningColor = c_0;`);
    lines.push(`float runningAlpha = a_0;`);
    for (let i = 1;i < chainEntries.length; i += 1) {
      const op = chainEntries[i].op;
      const a = `a_${i}`;
      const c = `c_${i}`;
      preamble(i);
      switch (op) {
        case "add":
          lines.push(`runningColor = mix(runningColor, ${c}, ${a});`);
          lines.push(`runningAlpha = clamp(runningAlpha + ${a}, 0.0, 1.0);`);
          break;
        case "subtract":
          lines.push(`runningAlpha = max(runningAlpha - ${a}, 0.0);`);
          break;
        case "intersect":
          lines.push(`runningColor = mix(runningColor, ${c}, ${a});`);
          lines.push(`runningAlpha = runningAlpha * ${a};`);
          break;
        case "screen":
          lines.push(`runningColor = mix(runningColor, ${c}, ${a});`);
          lines.push(`runningAlpha = 1.0 - (1.0 - runningAlpha) * (1.0 - ${a});`);
          break;
        case "lighten":
          lines.push(`runningColor = mix(runningColor, ${c}, ${a});`);
          lines.push(`runningAlpha = max(runningAlpha, ${a});`);
          break;
        case "darken":
          lines.push(`runningColor = mix(runningColor, ${c}, ${a});`);
          lines.push(`runningAlpha = min(runningAlpha, ${a});`);
          break;
        case "overlay":
          lines.push(`runningColor = mix(runningColor, ${c}, ${a});`);
          lines.push(`runningAlpha = runningAlpha < 0.5`);
          lines.push(`    ? (2.0 * runningAlpha * ${a})`);
          lines.push(`    : (1.0 - 2.0 * (1.0 - runningAlpha) * (1.0 - ${a}));`);
          lines.push(`runningAlpha = clamp(runningAlpha, 0.0, 1.0);`);
          break;
        case "replace":
          lines.push(`runningColor = ${c}; // invalid replace, treated as overwrite`);
          lines.push(`runningAlpha = ${a};`);
          break;
        default:
          lines.push(`runningColor = mix(runningColor, ${c}, ${a}); // unknown op, defaulting to add`);
          lines.push(`runningAlpha = clamp(runningAlpha + ${a}, 0.0, 1.0);`);
      }
    }
    return lines.join(`
        `);
  };
  var buildEvalDispatcher = (chainEntries) => {
    const n = chainEntries && typeof chainEntries.length === "number" ? chainEntries.length : 0;
    if (n === 0) {
      return `
            float evalLayer(int idx) { return 0.0; }
        `;
    }
    const lines = ["float evalLayer(int idx) {"];
    for (let i = 0;i < n; i += 1) {
      lines.push(`    if (idx == ${i}) return evalLayer_${i}();`);
    }
    lines.push("    return 0.0;");
    lines.push("}");
    return lines.join(`
        `);
  };

  // ../../src/lib/megashader/mask-types.js
  var BLEND_OPS = [
    "replace",
    "add",
    "subtract",
    "intersect",
    "screen",
    "lighten",
    "darken",
    "overlay"
  ];
  var MASK_KINDS = [
    "linear",
    "radial",
    "luminance",
    "color",
    "smartBrush",
    "semantic",
    "depth",
    "lasso",
    "brush",
    "path"
  ];
  var FILL_MODES = ["adjust", "fill", "erase"];
  var DEFAULT_FILL_COLOR = { r: 1, g: 0, b: 0.6 };
  var fillModeToFloat = (mode) => mode === "fill" ? 1 : mode === "erase" ? 2 : 0;
  var sanitiseFill = (layer = {}) => {
    const fillMode = FILL_MODES.includes(layer.fillMode) ? layer.fillMode : "adjust";
    const c = layer.fillColor || DEFAULT_FILL_COLOR;
    const ch = (v, fb) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fb;
    return {
      fillMode,
      fillColor: { r: ch(c.r, DEFAULT_FILL_COLOR.r), g: ch(c.g, DEFAULT_FILL_COLOR.g), b: ch(c.b, DEFAULT_FILL_COLOR.b) },
      fillStrength: ch(layer.fillStrength, 0.5)
    };
  };
  var ADJUST_FIELDS = [
    "exposure",
    "contrast",
    "saturation",
    "vibrance",
    "brightness",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "temperature",
    "tint",
    "texture",
    "dehaze"
  ];
  var layerHasAdjustment = (l) => ADJUST_FIELDS.some((f) => l && l[f]);
  var stackHasNoVisibleEffect = (stack) => {
    if (!stack || !Array.isArray(stack.chain) || stack.chain.length === 0)
      return true;
    for (const entry of stack.chain) {
      const l = entry && entry.layer;
      if (!l)
        continue;
      if (l.visible === false)
        continue;
      if (typeof l.opacity === "number" && l.opacity <= 0)
        continue;
      if (layerHasAdjustment(l))
        return false;
      if (l.fillMode === "erase")
        return false;
      if (l.fillMode === "fill") {
        const strength = typeof l.fillStrength === "number" ? l.fillStrength : 0.5;
        if (strength > 0)
          return false;
      }
    }
    return true;
  };
  var clampFinite = (v, lo, hi, fallback = lo) => typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
  var sanitiseLayer = (layer) => {
    if (!layer || typeof layer !== "object" || !layer.kind) {
      throw new Error("[megashader] sanitiseLayer: layer must be an object with a `kind`");
    }
    if (!MASK_KINDS.includes(layer.kind)) {
      throw new Error(`[megashader] sanitiseLayer: unknown mask kind "${layer.kind}"`);
    }
    return {
      id: layer.id || `layer-${Math.random().toString(36).slice(2, 10)}`,
      label: layer.label || "Untitled mask",
      exposure: 0,
      contrast: 0,
      saturation: 0,
      vibrance: 0,
      brightness: 0,
      opacity: 1,
      ...layer,
      id: layer.id || `layer-${Math.random().toString(36).slice(2, 10)}`,
      label: layer.label || "Untitled mask",
      visible: layer.visible !== false,
      inverted: layer.inverted === true,
      opacity: typeof layer.opacity === "number" ? Math.max(0, Math.min(1, layer.opacity)) : 1,
      exposure: clampFinite(layer.exposure, -3, 3, 0),
      contrast: clampFinite(layer.contrast, -100, 100, 0),
      saturation: clampFinite(layer.saturation, -100, 100, 0),
      vibrance: clampFinite(layer.vibrance, -100, 100, 0),
      brightness: clampFinite(layer.brightness, -100, 100, 0),
      highlights: clampFinite(layer.highlights, -100, 100, 0),
      shadows: clampFinite(layer.shadows, -100, 100, 0),
      whites: clampFinite(layer.whites, -100, 100, 0),
      blacks: clampFinite(layer.blacks, -100, 100, 0),
      temperature: clampFinite(layer.temperature, -100, 100, 0),
      tint: clampFinite(layer.tint, -100, 100, 0),
      texture: clampFinite(layer.texture, -100, 100, 0),
      dehaze: clampFinite(layer.dehaze, -100, 100, 0),
      lock: layer.lock === true,
      ...sanitiseFill(layer)
    };
  };
  var TWO_PI = Math.PI * 2;
  var linearLayer = ({
    p1,
    p2,
    position = 0.5,
    feather = 0.1,
    imageSize,
    label
  } = {}) => {
    const defP1 = imageSize ? { x: 0, y: imageSize.height / 2 } : { x: 0, y: 0 };
    const defP2 = imageSize ? { x: imageSize.width, y: imageSize.height / 2 } : { x: 100, y: 0 };
    const finalP1 = p1 || defP1;
    const finalP2 = p2 || defP2;
    return {
      kind: "linear",
      id: `lin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      label: label || "Linear gradient",
      opacity: 1,
      visible: true,
      lock: false,
      inverted: false,
      p1: {
        x: clampFinite(finalP1.x, 0, 1e5),
        y: clampFinite(finalP1.y, 0, 1e5)
      },
      p2: {
        x: clampFinite(finalP2.x, 0, 1e5),
        y: clampFinite(finalP2.y, 0, 1e5)
      },
      position: clampFinite(position, 0, 1),
      feather: clampFinite(feather, 0, 1)
    };
  };
  var radialLayer = ({
    center,
    rotation = 0,
    radius,
    feather = 0.1,
    imageSize,
    label
  } = {}) => {
    const defCenter = imageSize ? { x: imageSize.width / 2, y: imageSize.height / 2 } : { x: 50, y: 50 };
    const defRadius = imageSize ? { x: imageSize.width / 2, y: imageSize.height / 2 } : { x: 50, y: 50 };
    const finalCenter = center || defCenter;
    const finalRadius = radius || defRadius;
    return {
      kind: "radial",
      id: `rad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      label: label || "Radial gradient",
      opacity: 1,
      visible: true,
      lock: false,
      inverted: false,
      center: {
        x: clampFinite(finalCenter.x, 0, 1e5),
        y: clampFinite(finalCenter.y, 0, 1e5)
      },
      rotation: (rotation % TWO_PI + TWO_PI) % TWO_PI,
      radius: {
        x: clampFinite(finalRadius.x, 0.001, 1e5),
        y: clampFinite(finalRadius.y, 0.001, 1e5)
      },
      feather: clampFinite(feather, 0, 1)
    };
  };
  var maskTextureCache = new Map;
  var setMaskTexture = (key, data) => {
    if (typeof key !== "string" || !key)
      return;
    if (data)
      maskTextureCache.set(key, data);
  };
  var getMaskTexture = (key) => {
    if (typeof key !== "string" || !key)
      return;
    return maskTextureCache.get(key);
  };
  var pathLayer = ({ maskTextureKey, feather = 0.04, label, fillMode = "fill", fillColor, fillStrength = 0.5 } = {}) => {
    if (typeof maskTextureKey !== "string" || !maskTextureKey) {
      throw new Error("[megashader] pathLayer: `maskTextureKey` is required");
    }
    return {
      kind: "path",
      id: `pth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      label: label || "Pen path",
      opacity: 1,
      visible: true,
      lock: false,
      inverted: false,
      maskTextureKey,
      feather: clampFinite(feather, 0, 1),
      ...sanitiseFill({ fillMode, fillColor, fillStrength })
    };
  };

  // ../../src/lib/megashader/megashader-compiler.js
  var MAX_LAYERS = 8;
  var truncateChain = (chain) => Array.isArray(chain) ? chain.slice(0, MAX_LAYERS) : [];
  var normaliseStack = (stack) => {
    if (!stack || typeof stack !== "object")
      return { chain: [] };
    const chain = truncateChain(stack.chain);
    const normalised = chain.map((entry, i) => {
      if (!entry || typeof entry !== "object" || !entry.layer) {
        throw new Error(`[megashader] normaliseStack: chain[${i}] is not a MaskChainEntry`);
      }
      const layer = entry.layer;
      if (!layer.kind) {
        throw new Error(`[megashader] normaliseStack: chain[${i}].layer has no \`kind\``);
      }
      if (!MASK_KINDS.includes(layer.kind)) {
        throw new Error(`[megashader] normaliseStack: chain[${i}].layer.kind "${layer.kind}" is not a known mask kind`);
      }
      const op = i === 0 ? "replace" : entry.op || "add";
      if (!BLEND_OPS.includes(op)) {
        throw new Error(`[megashader] normaliseStack: chain[${i}].op "${op}" is not a valid BlendOp`);
      }
      return { layer, op };
    });
    return { chain: normalised };
  };
  var computeCacheKey = (stack) => {
    const kinds = stack.chain.map((e) => e.layer.kind || "unknown").join(",");
    const ops = stack.chain.map((e) => e.op).join(",");
    return `mk|${kinds}|${ops}|${stack.chain.length}`;
  };
  var compileMegashader = (rawStack) => {
    const stack = normaliseStack(rawStack);
    const vert = buildVertexShader();
    const fragmentTemplate = buildFragmentTemplate();
    const cacheKey = computeCacheKey(stack);
    if (stack.chain.length === 0) {
      return {
        frag: fragmentTemplate.replace("{{MASK_FUNCTIONS}}", "// passthrough — no layers").replace("{{ADJUST_FUNCTIONS}}", "// passthrough — no adjustments").replace("{{EVAL_DISPATCHER}}", "float evalLayer(int idx) { return 0.0; }").replace("{{BOOLEAN_CHAIN}}", `vec3 runningColor = srcRgb;
        float runningAlpha = 0.0;
        float eraseAlpha = 0.0;`),
        vert,
        cacheKey,
        passthrough: true
      };
    }
    const layerFns = stack.chain.map((entry, i) => buildLayerFunction(i, entry.layer.kind, entry.layer)).join(`
`);
    const adjustFns = stack.chain.map((entry, i) => buildLayerAdjustFunction(i, entry.layer)).join(`
`);
    const booleanChain = buildBooleanChain(stack.chain);
    const evalDispatcher = buildEvalDispatcher(stack.chain);
    const frag = fragmentTemplate.replace("{{MASK_FUNCTIONS}}", layerFns).replace("{{ADJUST_FUNCTIONS}}", adjustFns).replace("{{EVAL_DISPATCHER}}", evalDispatcher).replace("{{BOOLEAN_CHAIN}}", booleanChain);
    return { frag, vert, cacheKey, passthrough: false };
  };

  // ../../src/lib/megashader/megashader-renderer.js
  var MAX_PROGRAM_CACHE = 64;
  var renderMetrics = {
    compileCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
    evictions: 0,
    lastCompileMs: 0,
    totalCompileMs: 0,
    drawCount: 0,
    identityShortCircuits: 0
  };
  var QUAD_VERT = `attribute vec2 aPosition;
varying vec2 vUV;
void main() {
    vUV = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;
  var QUAD_FRAG = `precision mediump float;
void main() {
    gl_FragColor = vec4(0.0);
}
`;
  var glContext = null;
  var glCanvas = null;
  var programCache = new Map;
  var quadProgram = null;
  var quadVbo = null;
  var quadVao = null;
  var isBrowser = () => typeof window !== "undefined" && typeof document !== "undefined";
  var ensureGl = () => {
    if (!isBrowser())
      return null;
    if (glContext)
      return glContext;
    if (typeof document.createElement !== "function")
      return null;
    glCanvas = document.createElement("canvas");
    glCanvas.width = 1;
    glCanvas.height = 1;
    const ctx = glCanvas.getContext("webgl2", {
      premultipliedAlpha: false,
      preserveDrawingBuffer: false
    }) || glCanvas.getContext("webgl");
    if (!ctx)
      return null;
    glContext = ctx;
    return glContext;
  };
  var getOrCreateProgram = (compiled) => {
    const gl = ensureGl();
    if (!gl)
      return null;
    if (programCache.has(compiled.cacheKey)) {
      renderMetrics.cacheHits += 1;
      return programCache.get(compiled.cacheKey) ?? null;
    }
    renderMetrics.cacheMisses += 1;
    const t0 = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
    const vert = compileShader(gl, gl.VERTEX_SHADER, compiled.vert);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, compiled.frag);
    if (!vert || !frag)
      return null;
    const program = gl.createProgram();
    if (!program)
      return null;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program) || "(no info log)";
      console.warn("[megashader] program link failed:", info);
      gl.deleteShader(vert);
      gl.deleteShader(frag);
      gl.deleteProgram(program);
      return null;
    }
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (programCache.size >= MAX_PROGRAM_CACHE) {
      const oldest = programCache.keys().next().value;
      if (oldest) {
        const oldProgram = programCache.get(oldest);
        if (oldProgram)
          gl.deleteProgram(oldProgram);
        programCache.delete(oldest);
        renderMetrics.evictions += 1;
      }
    }
    programCache.set(compiled.cacheKey, program);
    renderMetrics.compileCount += 1;
    const t1 = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
    const dt = t1 - t0;
    renderMetrics.lastCompileMs = dt;
    renderMetrics.totalCompileMs += dt;
    return program;
  };
  var compileShader = (gl, type, source) => {
    const shader = gl.createShader(type);
    if (!shader)
      return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader) || "(no info log)";
      console.warn(`[megashader] shader compile failed (${type === gl.VERTEX_SHADER ? "vertex" : "fragment"}):`, info);
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };
  var getQuadProgram = (gl) => {
    if (quadProgram)
      return quadProgram;
    const program = gl.createProgram();
    if (!program)
      return null;
    const vert = compileShader(gl, gl.VERTEX_SHADER, QUAD_VERT);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, QUAD_FRAG);
    if (!vert || !frag) {
      if (vert)
        gl.deleteShader(vert);
      if (frag)
        gl.deleteShader(frag);
      gl.deleteProgram(program);
      return null;
    }
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program) || "(no info log)";
      console.warn("[megashader] quad program link failed:", info);
      gl.deleteProgram(program);
      return null;
    }
    quadProgram = program;
    return quadProgram;
  };
  var writeKindSamplers = (gl, program, layer, slotIndex, textureBindings) => {
    let schema;
    try {
      schema = getKindSchema(layer.kind);
    } catch {
      return;
    }
    const samplers = schema.samplers;
    if (!Array.isArray(samplers) || samplers.length === 0)
      return;
    const unit = textureBindings.kindUnits?.get(slotIndex);
    for (const sampler of samplers) {
      const glslName = sampler.glsl.replace("<S>", String(slotIndex));
      const loc = gl.getUniformLocation(program, glslName);
      if (!loc)
        continue;
      if (unit !== undefined)
        gl.uniform1i(loc, unit);
    }
  };
  var writeKindUniforms = (gl, program, layer, slotIndex) => {
    let schema;
    try {
      schema = getKindSchema(layer.kind);
    } catch {
      return;
    }
    const uniforms = schema.uniforms;
    if (!Array.isArray(uniforms) || uniforms.length === 0)
      return;
    for (const field of uniforms) {
      const glslName = field.glsl.replace("<S>", String(slotIndex));
      const loc = gl.getUniformLocation(program, glslName);
      if (!loc)
        continue;
      let raw = layer[field.name];
      if (layer.kind === "color" && raw === undefined && layer.target && typeof layer.target === "object") {
        if (field.name === "targetH")
          raw = layer.target.h;
        else if (field.name === "targetS")
          raw = layer.target.s;
        else if (field.name === "targetB")
          raw = layer.target.b;
      }
      const value = normaliseUniformValue(raw, field);
      if (field.type === "float" && typeof value === "number") {
        gl.uniform1f(loc, value);
      } else if (field.type === "vec2" && Array.isArray(value) && value.length === 2) {
        gl.uniform2f(loc, value[0], value[1]);
      } else if (field.type === "vec3" && Array.isArray(value) && value.length === 3) {
        gl.uniform3f(loc, value[0], value[1], value[2]);
      }
    }
  };
  var writeLayerCommonUniforms = (gl, program, layer, slotIndex) => {
    const prefix = `uLayer_${slotIndex}`;
    const opacityLoc = gl.getUniformLocation(program, `${prefix}_opacity`);
    if (opacityLoc) {
      const op = typeof layer.opacity === "number" && Number.isFinite(layer.opacity) ? Math.max(0, Math.min(1, layer.opacity)) : 1;
      gl.uniform1f(opacityLoc, op);
    }
    const invLoc = gl.getUniformLocation(program, `${prefix}_inverted`);
    if (invLoc)
      gl.uniform1f(invLoc, layer.inverted === true ? 1 : 0);
    const visLoc = gl.getUniformLocation(program, `${prefix}_visible`);
    if (visLoc)
      gl.uniform1f(visLoc, layer.visible === false ? 0 : 1);
  };
  var writeLayerAdjustUniforms = (gl, program, layer, slotIndex) => {
    const prefix = `uLayer_${slotIndex}_adjust_`;
    const set = (name, raw, lo, hi) => {
      const loc = gl.getUniformLocation(program, `${prefix}${name}`);
      if (!loc)
        return;
      const value = typeof raw === "number" && Number.isFinite(raw) ? Math.max(lo, Math.min(hi, raw)) : 0;
      gl.uniform1f(loc, value);
    };
    set("exposure", layer.exposure, -3, 3);
    set("contrast", layer.contrast, -100, 100);
    set("saturation", layer.saturation, -100, 100);
    set("vibrance", layer.vibrance, -100, 100);
    set("brightness", layer.brightness, -100, 100);
    set("highlights", layer.highlights, -100, 100);
    set("shadows", layer.shadows, -100, 100);
    set("whites", layer.whites, -100, 100);
    set("blacks", layer.blacks, -100, 100);
    set("temperature", layer.temperature, -100, 100);
    set("tint", layer.tint, -100, 100);
    set("texture", layer.texture, -100, 100);
    set("dehaze", layer.dehaze, -100, 100);
  };
  var writeLayerFillUniforms = (gl, program, layer, slotIndex) => {
    const prefix = `uLayer_${slotIndex}_`;
    const modeLoc = gl.getUniformLocation(program, `${prefix}fillMode`);
    if (modeLoc)
      gl.uniform1f(modeLoc, fillModeToFloat(layer.fillMode));
    const colorLoc = gl.getUniformLocation(program, `${prefix}fillColor`);
    if (colorLoc) {
      const c = layer.fillColor || { r: 1, g: 0, b: 0.6 };
      const ch = (v, fb) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fb;
      gl.uniform3f(colorLoc, ch(c.r, 1), ch(c.g, 0), ch(c.b, 0.6));
    }
    const strengthLoc = gl.getUniformLocation(program, `${prefix}fillStrength`);
    if (strengthLoc) {
      const s = typeof layer.fillStrength === "number" && Number.isFinite(layer.fillStrength) ? Math.max(0, Math.min(1, layer.fillStrength)) : 0.5;
      gl.uniform1f(strengthLoc, s);
    }
  };
  var writeUniforms = (gl, program, stack, renderOpts, imageSize, textureBindings) => {
    const { globalMaskAlpha, globalInvert, maskOverlay, overlayColor } = renderOpts || {};
    const sizeLoc = gl.getUniformLocation(program, "uImageSize");
    if (sizeLoc)
      gl.uniform2f(sizeLoc, imageSize.width, imageSize.height);
    const maskAlphaLoc = gl.getUniformLocation(program, "uMaskAlpha");
    if (maskAlphaLoc) {
      const a = typeof globalMaskAlpha === "number" && Number.isFinite(globalMaskAlpha) ? Math.max(0, Math.min(1, globalMaskAlpha)) : 1;
      gl.uniform1f(maskAlphaLoc, a);
    }
    const invertLoc = gl.getUniformLocation(program, "uGlobalInvert");
    if (invertLoc)
      gl.uniform1f(invertLoc, globalInvert ? 1 : 0);
    const overlayLoc = gl.getUniformLocation(program, "uMaskOverlay");
    if (overlayLoc)
      gl.uniform1f(overlayLoc, maskOverlay ? 1 : 0);
    const overlayColLoc = gl.getUniformLocation(program, "uMaskOverlayColor");
    if (overlayColLoc) {
      const c = overlayColor || { r: 1, g: 0, b: 0.25 };
      const ch = (v, fb) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fb;
      gl.uniform3f(overlayColLoc, ch(c.r, 1), ch(c.g, 0), ch(c.b, 0.25));
    }
    if (!stack || !Array.isArray(stack.chain))
      return;
    for (let i = 0;i < stack.chain.length; i += 1) {
      const layer = stack.chain[i].layer;
      if (!layer)
        continue;
      writeLayerCommonUniforms(gl, program, layer, i);
      writeKindUniforms(gl, program, layer, i);
      writeLayerAdjustUniforms(gl, program, layer, i);
      writeLayerFillUniforms(gl, program, layer, i);
      writeKindSamplers(gl, program, layer, i, textureBindings);
    }
  };
  var bindKindTextures = (gl, stack) => {
    const ownedTextures = [];
    const kindUnits = new Map;
    let nextUnit = 1;
    let nullUnit = -1;
    const ensureNullUnit = () => {
      if (nullUnit >= 0)
        return nullUnit;
      if (nextUnit >= 16)
        return -1;
      const tex = gl.createTexture();
      if (!tex)
        return -1;
      const unit = nextUnit;
      nextUnit += 1;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      ownedTextures.push(tex);
      nullUnit = unit;
      return unit;
    };
    if (!stack || !Array.isArray(stack.chain)) {
      return { kindUnits, ownedTextures };
    }
    for (let i = 0;i < stack.chain.length; i += 1) {
      const layer = stack.chain[i].layer;
      let cacheKey = null;
      if (layer.kind === "semantic") {
        cacheKey = layer.maskTextureKey;
      } else if (layer.kind === "smartBrush") {
        cacheKey = layer.brushTextureKey;
      } else if (layer.kind === "depth") {
        cacheKey = layer.depthMapKey;
      } else if (layer.kind === "lasso") {
        cacheKey = layer.maskTextureKey;
      } else if (layer.kind === "brush") {
        cacheKey = layer.maskTextureKey;
      } else if (layer.kind === "path") {
        cacheKey = layer.maskTextureKey;
      } else {
        continue;
      }
      const data = typeof cacheKey === "string" && cacheKey ? getMaskTexture(cacheKey) : undefined;
      if (!data) {
        const u = ensureNullUnit();
        if (u >= 0)
          kindUnits.set(i, u);
        continue;
      }
      const tex = gl.createTexture();
      if (!tex) {
        const u = ensureNullUnit();
        if (u >= 0)
          kindUnits.set(i, u);
        continue;
      }
      gl.activeTexture(gl.TEXTURE0 + nextUnit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
      } catch {
        gl.deleteTexture(tex);
        const u = ensureNullUnit();
        if (u >= 0)
          kindUnits.set(i, u);
        continue;
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      kindUnits.set(i, nextUnit);
      ownedTextures.push(tex);
      nextUnit += 1;
      if (nextUnit >= 16) {
        break;
      }
    }
    return { kindUnits, ownedTextures };
  };
  var ensureQuadBuffers = (gl) => {
    if (quadVao && quadVbo)
      return { vao: quadVao, vbo: quadVbo };
    if (typeof gl.createVertexArray !== "function") {
      return { vao: null, vbo: null };
    }
    getQuadProgram(gl);
    const verts = new Float32Array([
      -1,
      -1,
      1,
      -1,
      -1,
      1,
      -1,
      1,
      1,
      -1,
      1,
      1
    ]);
    const vbo = gl.createBuffer();
    if (!vbo)
      return { vao: null, vbo: null };
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    if (!vao) {
      gl.deleteBuffer(vbo);
      return { vao: null, vbo: null };
    }
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    quadVbo = vbo;
    quadVao = vao;
    return { vao: quadVao, vbo: quadVbo };
  };
  var renderMegashader = (sourceCanvas, stack, options = {}) => {
    if (!sourceCanvas || typeof sourceCanvas.width !== "number") {
      return renderCpuFallback({ width: 1, height: 1 }, stack);
    }
    const compiled = compileMegashader(stack);
    const overlayOn = options.maskOverlay === true;
    if (compiled.passthrough || !overlayOn && stackHasNoVisibleEffect(stack)) {
      renderMetrics.identityShortCircuits += 1;
      if (typeof sourceCanvas.getContext === "function" && sourceCanvas instanceof HTMLCanvasElement) {
        return sourceCanvas;
      }
      return renderCpuFallback(sourceCanvas, stack);
    }
    const gl = ensureGl();
    if (!gl)
      return renderCpuFallback(sourceCanvas, stack);
    const program = getOrCreateProgram(compiled);
    if (!program)
      return renderCpuFallback(sourceCanvas, stack);
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    if (glCanvas.width !== w)
      glCanvas.width = w;
    if (glCanvas.height !== h)
      glCanvas.height = h;
    gl.viewport(0, 0, w, h);
    const imageSize = { width: w, height: h };
    const texture = gl.createTexture();
    if (!texture)
      return renderCpuFallback(sourceCanvas, stack);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.useProgram(program);
    const uImage = gl.getUniformLocation(program, "uImage");
    if (uImage)
      gl.uniform1i(uImage, 0);
    const uMatrix = gl.getUniformLocation(program, "uMatrix");
    if (uMatrix) {
      gl.uniformMatrix4fv(uMatrix, false, new Float32Array([
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1
      ]));
    }
    const { kindUnits, ownedTextures } = bindKindTextures(gl, stack || { chain: [] });
    writeUniforms(gl, program, stack || { chain: [] }, {
      globalMaskAlpha: options.globalMaskAlpha ?? 1,
      globalInvert: options.globalInvert === true,
      maskOverlay: options.maskOverlay === true,
      overlayColor: options.overlayColor
    }, imageSize, { kindUnits });
    const { vao } = ensureQuadBuffers(gl);
    if (vao) {
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    }
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    if (ctx) {
      const pixels = new Uint8Array(w * h * 4);
      try {
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      } catch {
        gl.deleteTexture(texture);
        for (const tex of ownedTextures)
          gl.deleteTexture(tex);
        return renderCpuFallback(sourceCanvas, stack);
      }
      const imageData = ctx.createImageData(w, h);
      const rowBytes = w * 4;
      for (let y = 0;y < h; y += 1) {
        const srcStart = (h - 1 - y) * rowBytes;
        const dstStart = y * rowBytes;
        imageData.data.set(pixels.subarray(srcStart, srcStart + rowBytes), dstStart);
      }
      ctx.putImageData(imageData, 0, 0);
    }
    gl.deleteTexture(texture);
    for (const tex of ownedTextures)
      gl.deleteTexture(tex);
    renderMetrics.drawCount += 1;
    return out;
  };
  var renderCpuFallback = (source, stack) => {
    if (typeof document === "undefined") {
      const out2 = { width: 1, height: 1, getContext: () => null };
      return out2;
    }
    const out = document.createElement("canvas");
    if (source && typeof source.width === "number" && typeof source.height === "number") {
      out.width = source.width;
      out.height = source.height;
    } else {
      out.width = 1;
      out.height = 1;
      return out;
    }
    if (typeof source.getContext === "function" && source instanceof HTMLCanvasElement) {
      const ctx = out.getContext("2d");
      if (ctx) {
        try {
          ctx.drawImage(source, 0, 0);
        } catch {}
      }
    }
    return out;
  };

  // ../../src/lib/megashader/path-raster.js
  var hasHandles = (a, b) => !!(a && b && a.cOut && b.cIn);
  var cubicAt = (p0, c0, c1, p1, t) => {
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return {
      x: a * p0.x + b * c0.x + c * c1.x + d * p1.x,
      y: a * p0.y + b * c0.y + c * c1.y + d * p1.y
    };
  };
  function smoothToBezier(points, { closed = true, tension = 1 } = {}) {
    const n = points ? points.length : 0;
    if (n < 3)
      return (points || []).map((p) => ({ x: p.x, y: p.y }));
    const k = tension / 6;
    const out = [];
    for (let i = 0;i < n; i++) {
      const prev = closed ? points[(i - 1 + n) % n] : points[Math.max(0, i - 1)];
      const next = closed ? points[(i + 1) % n] : points[Math.min(n - 1, i + 1)];
      const tx = (next.x - prev.x) * k;
      const ty = (next.y - prev.y) * k;
      out.push({
        x: points[i].x,
        y: points[i].y,
        cOut: { x: points[i].x + tx, y: points[i].y + ty },
        cIn: { x: points[i].x - tx, y: points[i].y - ty }
      });
    }
    return out;
  }
  function flattenPath(points, { closed = true, steps = 24 } = {}) {
    if (!Array.isArray(points) || points.length < 2)
      return [];
    const out = [{ x: points[0].x, y: points[0].y }];
    const n = points.length;
    const last = closed ? n : n - 1;
    for (let i = 0;i < last; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      if (hasHandles(a, b)) {
        for (let s = 1;s <= steps; s++)
          out.push(cubicAt(a, a.cOut, b.cIn, b, s / steps));
      } else {
        out.push({ x: b.x, y: b.y });
      }
    }
    return out;
  }
  function pointInPolygon(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1;i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect = yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi || 0.000000001) + xi;
      if (intersect)
        inside = !inside;
    }
    return inside;
  }
  function rasterisePathData(points, width, height, { closed = true, steps = 24 } = {}) {
    const poly = flattenPath(points, { closed, steps });
    const data = new Uint8ClampedArray(width * height * 4);
    if (poly.length >= 3) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of poly) {
        if (p.x < minX)
          minX = p.x;
        if (p.x > maxX)
          maxX = p.x;
        if (p.y < minY)
          minY = p.y;
        if (p.y > maxY)
          maxY = p.y;
      }
      minX = Math.max(0, Math.floor(minX));
      minY = Math.max(0, Math.floor(minY));
      maxX = Math.min(width - 1, Math.ceil(maxX));
      maxY = Math.min(height - 1, Math.ceil(maxY));
      for (let y = minY;y <= maxY; y++) {
        for (let x = minX;x <= maxX; x++) {
          let hits = 0;
          for (let sy = 0;sy < 2; sy++) {
            for (let sx = 0;sx < 2; sx++) {
              if (pointInPolygon(poly, x + 0.25 + sx * 0.5, y + 0.25 + sy * 0.5))
                hits++;
            }
          }
          const cov = hits / 4 * 255;
          const idx = (y * width + x) * 4;
          data[idx] = cov;
          data[idx + 1] = cov;
          data[idx + 2] = cov;
          data[idx + 3] = 255;
        }
      }
    }
    return { width, height, data };
  }
  function tracePath(ctx, points, closed) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    const n = points.length;
    const last = closed ? n : n - 1;
    for (let i = 0;i < last; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      if (hasHandles(a, b))
        ctx.bezierCurveTo(a.cOut.x, a.cOut.y, b.cIn.x, b.cIn.y, b.x, b.y);
      else
        ctx.lineTo(b.x, b.y);
    }
    if (closed)
      ctx.closePath();
  }
  function rasterisePath(points, width, height, { closed = true } = {}) {
    if (!Array.isArray(points) || points.length < 2) {
      return rasterisePathData(points || [], width, height, { closed });
    }
    const canCanvas = typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined";
    if (canCanvas) {
      const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#ffffff";
      tracePath(ctx, points, closed);
      ctx.fill("nonzero");
      return canvas;
    }
    return rasterisePathData(points, width, height, { closed });
  }

  // entry.js
  var WORK = 1100;
  var log = (m) => {
    const el = document.getElementById("log");
    el.textContent += m + `
`;
    console.log("[harness]", m);
  };
  var meanAbsDiff = (a, b) => {
    let s = 0, n = a.length;
    for (let i = 0;i < n; i += 4) {
      s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    }
    return s / (n / 4 * 3);
  };
  var patchDiff = (a, b, w, h, x0, y0, x1, y1) => {
    let s = 0, c = 0;
    for (let y = Math.floor(y0 * h);y < Math.floor(y1 * h); y++)
      for (let x = Math.floor(x0 * w);x < Math.floor(x1 * w); x++) {
        const i = (y * w + x) * 4;
        s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        c += 3;
      }
    return c ? s / c : 0;
  };
  function tile(parent, title) {
    const wrap = document.createElement("div");
    wrap.className = "tile";
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = title;
    const cv = document.createElement("canvas");
    cv.className = "out";
    wrap.appendChild(cv);
    wrap.appendChild(cap);
    parent.appendChild(wrap);
    return cv;
  }
  function drawResult(displayCanvas, resultCanvas) {
    displayCanvas.width = resultCanvas.width;
    displayCanvas.height = resultCanvas.height;
    displayCanvas.getContext("2d").drawImage(resultCanvas, 0, 0);
  }
  async function main() {
    const img = new Image;
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = "test.png?" + Date.now();
    });
    const scale = Math.min(1, WORK / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale);
    const src = document.createElement("canvas");
    src.width = W;
    src.height = H;
    const sctx = src.getContext("2d", { willReadFrequently: true });
    sctx.drawImage(img, 0, 0, W, H);
    const origData = sctx.getImageData(0, 0, W, H).data;
    const imageSize = { width: W, height: H };
    log(`image ${img.naturalWidth}×${img.naturalHeight} → working ${W}×${H}`);
    log(`WebGL2 available: ${(() => {
      try {
        return !!document.createElement("canvas").getContext("webgl2");
      } catch {
        return false;
      }
    })()}`);
    const grid = document.getElementById("grid");
    const adj = (base, props) => sanitiseLayer({ ...base, ...props, fillMode: props.fillMode || "adjust" });
    const center = { x: W * 0.46, y: H * 0.42 };
    const run = (title, chain) => {
      const cv = tile(grid, title);
      const result = renderMegashader(src, { chain });
      drawResult(cv, result);
      const data = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
      return data;
    };
    run("0 · Original", []);
    {
      const layer = sanitiseLayer({
        ...radialLayer({ center, radius: { x: W * 0.34, y: H * 0.34 }, feather: 0.5, imageSize }),
        fillMode: "fill",
        fillColor: { r: 1, g: 0.15, b: 0.2 },
        fillStrength: 0.6
      });
      run("1 · Radial FILL (shape)", [{ layer, op: "replace" }]);
    }
    {
      const base = radialLayer({ center, radius: { x: W * 0.34, y: H * 0.34 }, feather: 0.55, imageSize });
      const layer = adj(base, { exposure: 1.3, saturation: 35, vibrance: 85, contrast: 18 });
      const d = run("2 · Radial ADJUST exp+sat+VIBRANCE", [{ layer, op: "replace" }]);
      const inside = patchDiff(origData, d, W, H, 0.38, 0.34, 0.54, 0.5);
      const outside = patchDiff(origData, d, W, H, 0.86, 0.04, 0.99, 0.2);
      log(`#2 local? inside Δ=${inside.toFixed(1)}  outside Δ=${outside.toFixed(1)}  → ${inside > outside * 3 ? "LOCAL ✓" : "check"}`);
    }
    {
      const base = linearLayer({ p1: { x: W / 2, y: 0 }, p2: { x: W / 2, y: H * 0.55 }, feather: 0.6, imageSize });
      const layer = adj(base, { temperature: -55, contrast: 22, dehaze: 60 });
      const d = run("3 · Linear ADJUST temp+DEHAZE", [{ layer, op: "replace" }]);
      const top = patchDiff(origData, d, W, H, 0.4, 0.05, 0.6, 0.18);
      const bottom = patchDiff(origData, d, W, H, 0.4, 0.85, 0.6, 0.98);
      log(`#3 gradient? top Δ=${top.toFixed(1)}  bottom Δ=${bottom.toFixed(1)}  → ${top > bottom + 2 ? "GRADIENT ✓" : "check"}`);
    }
    {
      const base = radialLayer({ center, radius: { x: W * 0.4, y: H * 0.4 }, feather: 0.4, imageSize });
      const tex = adj(base, { texture: 95 });
      const dt = run("4a · Radial TEXTURE +95 (only)", [{ layer: tex, op: "replace" }]);
      log(`#4a TEXTURE fires? overall Δ=${meanAbsDiff(origData, dt).toFixed(2)}  → ${meanAbsDiff(origData, dt) > 0.3 ? "YES ✓" : "NO ✗"}`);
      const deh = adj(base, { dehaze: 85 });
      const dd = run("4b · Radial DEHAZE +85 (only)", [{ layer: deh, op: "replace" }]);
      log(`#4b DEHAZE fires? overall Δ=${meanAbsDiff(origData, dd).toFixed(2)}  → ${meanAbsDiff(origData, dd) > 0.3 ? "YES ✓" : "NO ✗"}`);
    }
    {
      const pts = [
        { x: W * 0.42, y: H * 0.26 },
        { x: W * 0.6, y: H * 0.32 },
        { x: W * 0.64, y: H * 0.55 },
        { x: W * 0.6, y: H * 0.74 },
        { x: W * 0.46, y: H * 0.72 },
        { x: W * 0.4, y: H * 0.5 }
      ];
      const anchors = smoothToBezier(pts, { closed: true });
      const canvas = rasterisePath(anchors, W, H, { closed: true });
      const key = "harness-path-1";
      setMaskTexture(key, canvas);
      const fillLayer = sanitiseLayer({ ...pathLayer({ maskTextureKey: key, feather: 0.04 }), fillMode: "fill", fillColor: { r: 0.32, g: 0.85, b: 1 }, fillStrength: 0.55 });
      run("5a · PEN-PATH FILL (shape)", [{ layer: fillLayer, op: "replace" }]);
      const adjLayer = adj({ ...pathLayer({ maskTextureKey: key, feather: 0.06 }) }, { exposure: 1, vibrance: 70, texture: 50 });
      const d = run("5b · PEN-PATH ADJUST exp+vib+tex", [{ layer: adjLayer, op: "replace" }]);
      const inside = patchDiff(origData, d, W, H, 0.46, 0.4, 0.56, 0.55);
      const outside = patchDiff(origData, d, W, H, 0.05, 0.05, 0.18, 0.2);
      log(`#5 path local? inside Δ=${inside.toFixed(1)}  outside Δ=${outside.toFixed(1)}  → ${inside > outside * 3 ? "LOCAL ✓" : "check"}`);
    }
    log("DONE — all cases rendered");
    window.__done = true;
  }
  main().catch((e) => {
    log("ERROR: " + (e && e.message || e));
    window.__error = String(e);
    window.__done = true;
  });
})();
