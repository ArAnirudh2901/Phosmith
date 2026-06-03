/**
 * Megashader GLSL Fragment String Builders
 * -----------------------------------------
 * Pure functions that return GLSL ES 1.00 strings. No side effects, no
 * closures over runtime values — every input must be a string the compiler
 * can splice verbatim. This keeps the compiler trivially testable (it can
 * run in Node and string-assert the output without a GL context).
 *
 * What lives here:
 *   - The megashader fragment-shader TEMPLATE with `{{PLACEHOLDER}}` slots
 *   - The vertex-shader template (passthrough quad)
 *   - The shared `rgbToHsb` helper used by the color mask
 *   - The boolean-compositing chain builder
 *
 * Per-mask-kind GLSL function BODIES live in `glsl-mask-kinds.js` (one
 * builder + one uniform schema per kind). Adding a new kind in Steps 3-6
 * is a one-file change there; this file stays untouched.
 *
 * The compiler (`megashader-compiler.js`) splices these together based on the
 * active `MaskStack`. Re-compilation only happens when the *set* of layer
 * kinds or the *op chain* changes, never on per-layer parameter edits.
 *
 * Conventions:
 *   - `vTextureCoord` is the standard Fabric/Megashader texcoord varying.
 *   - All layer functions take NO arguments and read their parameters from
 *     uniforms (so the same compiled shader can be reused across parameter
 *     changes — only uniform updates are needed per frame).
 *   - The function name is always `evalLayer_<slot>()`, where `<slot>` is
 *     the per-stack layer index (0..7). The dispatcher `evalLayer(int)`
 *     is emitted in the template.
 *
 * @module megashader/glsl-fragments
 */

import { getKindBuilder } from './glsl-mask-kinds'

/**
 * The standard passthrough vertex shader used by every megashader program.
 * Maps a fullscreen quad through the Fabric Image's transform so the
 * megashader's coordinate system is identical to the base image's.
 *
 * Uniforms:
 *   - uMatrix (mat4): the base image's transform (provided by Fabric when it
 *     applies the filter; we mirror its convention).
 *
 * @returns {string}
 */
export const buildVertexShader = () => /* glsl */ `
    attribute vec2 aPosition;
    varying vec2 vTextureCoord;
    uniform mat4 uMatrix;

    void main() {
        vTextureCoord = aPosition * 0.5 + 0.5;
        gl_Position = uMatrix * vec4(aPosition, 0.0, 1.0);
    }
`

/**
 * The megashader fragment-shader TEMPLATE. The compiler substitutes
 * `{{MASK_FUNCTIONS}}`, `{{ADJUST_FUNCTIONS}}` and `{{BOOLEAN_CHAIN}}`
 * with the actual evaluated code. Anything else is treated as a literal
 * GLSL token.
 *
 * Reserved uniforms (always declared, may be unused in Step 1):
 *   - uImage (sampler2D): the base image to apply the mask against.
 *   - uDepthMap, uSemanticMask, uBrushTex (sampler2D): reserved slots for
 *     Steps 4-6. Declaring them upfront means later steps just need to
 *     upload a texture, not recompile.
 *   - uMaskAlpha (float): global mask strength (0..1) — extra UI fader on
 *     top of the per-layer opacity chain.
 *
 * Step 8: image adjustments moved to PER-LAYER (each layer has its own
 * Exposure/Contrast/Saturation/Brightness). The global `uAdjust*`
 * uniforms and the `applyAdjustments` function are gone. The chain
 * tracks a `runningColor` (vec3, the colour "inside the mask so far")
 * and a `runningAlpha` (float, the mask strength) and the final
 * composite is `mix(src, runningColor, runningAlpha)`.
 *
 * @returns {string}
 */
export const buildFragmentTemplate = () => /* glsl */ `
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

    // {{MASK_FUNCTIONS}}

    // {{ADJUST_FUNCTIONS}}

    // {{EVAL_DISPATCHER}}

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

        // {{BOOLEAN_CHAIN}}

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
`

/**
 * Build a per-mask-layer evaluation function. The function body itself
 * lives in `glsl-mask-kinds.js` (one builder per kind); this wrapper:
 *   1. Looks up the kind's builder via the `KIND_BUILDERS` registry.
 *   2. Appends the COMMON apply block — visible, inverted, opacity — that
 *      every layer needs regardless of kind. This means the per-kind
 *      builders only contain the math, not the housekeeping.
 *   3. Wraps the body in a `evalLayer_<slot>()` function.
 *
 * Reserved uniform naming convention (matched by the renderer in
 * `megashader-renderer.js`):
 *   - `uLayer_<slot>_opacity`  (per-layer UI opacity, 0..1)
 *   - `uLayer_<slot>_inverted` (0 or 1)
 *   - `uLayer_<slot>_visible`  (0 or 1, applied as `* 0` to short-circuit)
 *   - `uLayer_<slot>_kind_<kind>_<field>` (kind-specific, see
 *     `KIND_SCHEMAS` in glsl-mask-kinds.js)
 *   - `uLayer_<slot>_adjust_<field>` (Step 8 per-layer adjustments,
 *     universal across kinds)
 *
 * @param {number} slotIndex           0..7 — which entry in the layer array.
 * @param {string} kind                The mask kind (e.g. 'luminance').
 * @param {object} [params]            Kept for API symmetry with Step 1;
 *                                     per-kind bodies read uniforms, not
 *                                     these JS params. The compiler
 *                                     validates `kind` via the registry.
 * @returns {string} A complete GLSL function definition.
 */
export const buildLayerFunction = (slotIndex, kind, params = {}) => {
    const uniformPrefix = `uLayer_${slotIndex}`

    // Per-layer opacity/inverted/visible are ALWAYS declared (cheap, and lets
    // the compositing chain read them uniformly without branching on kind).
    const commonUniforms = /* glsl */ `
        uniform float ${uniformPrefix}_opacity;
        uniform float ${uniformPrefix}_inverted;
        uniform float ${uniformPrefix}_visible;
    `

    // The common apply block — visible gates, invert flips, opacity scales.
    // Per-kind builders emit only the raw-alpha calculation, so the same
    // housekeeping wraps every kind identically.
    //
    // Order matters: invert BEFORE the visible gate. If visible were
    // applied first, then `raw = body() * 0 = 0` for an invisible layer,
    // and the subsequent `raw = 1.0 - 0 = 1.0` for an inverted layer
    // would resurrect the alpha to 1.0 (then scaled by opacity). That
    // violates the user's "hide this layer" intent — an invisible layer
    // should contribute ZERO regardless of inversion. Inverting first
    // means the visibility gate correctly zeros the output.
    const commonApply = /* glsl */ `
        float raw = evalLayer_${slotIndex}_body();
        if (${uniformPrefix}_inverted > 0.5) raw = 1.0 - raw;
        raw = raw * ${uniformPrefix}_visible;
        return clamp(raw * ${uniformPrefix}_opacity, 0.0, 1.0);
    `

    // Each kind's builder emits a `float evalLayer_<slot>_body()` so the
    // common apply block can wrap it without the per-kind code needing
    // to know about opacity/inverted/visible. `getKindBuilder` throws
    // on unknown kinds, so the failure surfaces at compile time.
    const builder = getKindBuilder(kind)
    const bodyFn = builder(slotIndex)

    return /* glsl */ `
        ${bodyFn}
        float evalLayer_${slotIndex}() {
            ${commonUniforms}
            ${commonApply}
        }
    `
}

/**
 * Step 8 — Build a per-layer image-adjustment function.
 *
 * Emits a `vec3 applyLayerAdjust_<slot>(vec3 rgb)` GLSL function that
 * reads the per-layer adjustment uniforms (exposure/contrast/
 * saturation/brightness) and applies them in sequence. Each layer in
 * the chain has its OWN adjust function — the megashader can apply
 * different adjustments to different regions of the image, which is
 * the whole point of per-layer adjustments.
 *
 * The function includes an early-out: if all four adjustment values
 * are exactly 0, return the input colour unchanged. This is the
 * common case for most layers, and skipping the math means a layer
 * that doesn't need adjustments pays zero per-pixel cost.
 *
 * Reserved uniform naming convention (matched by the renderer in
 * `megashader-renderer.js`):
 *   - `uLayer_<slot>_adjust_exposure`   (float, EV stops, -3..+3)
 *   - `uLayer_<slot>_adjust_contrast`   (float, -100..+100)
 *   - `uLayer_<slot>_adjust_saturation` (float, -100..+100)
 *   - `uLayer_<slot>_adjust_brightness` (float, -100..+100)
 *
 * The math is identical to the (now-removed) global `applyAdjustments`
 * function so behaviour is preserved when a layer has its own
 * adjustments and everything else is zero. The renderer writes 0
 * for any field the layer doesn't supply, so the early-out fires.
 *
 * @param {number} slotIndex           0..7 — which entry in the layer array.
 * @param {object} [params]            Per-layer adjustment values (defaults to 0).
 *                                     Accepts any object that may have
 *                                     `exposure` / `contrast` /
 *                                     `saturation` / `brightness` keys.
 * @returns {string} A complete GLSL function definition.
 */
export const buildLayerAdjustFunction = (slotIndex, params = {}) => {
    const e = `uLayer_${slotIndex}_adjust_exposure`
    const c = `uLayer_${slotIndex}_adjust_contrast`
    const s = `uLayer_${slotIndex}_adjust_saturation`
    const b = `uLayer_${slotIndex}_adjust_brightness`
    // Pro-parity tonal + white-balance adjustments (Lightroom-style),
    // applied only inside the layer's mask. All default to 0 (identity).
    const hi = `uLayer_${slotIndex}_adjust_highlights`
    const sh = `uLayer_${slotIndex}_adjust_shadows`
    const wh = `uLayer_${slotIndex}_adjust_whites`
    const bk = `uLayer_${slotIndex}_adjust_blacks`
    const tp = `uLayer_${slotIndex}_adjust_temperature`
    const tn = `uLayer_${slotIndex}_adjust_tint`
    // Per-layer fill output (root-cause #1 fix). `fillMode` selects how the
    // layer turns its mask alpha into a visible result:
    //   0 = adjust  → recolour the masked region via the adjustments above
    //                 (a layer with all-zero adjustments is colour-identity).
    //   1 = fill    → tint/overlay the masked region with `fillColor` at
    //                 `fillStrength`, so a pure selection is ALWAYS visible
    //                 without dragging an adjustment slider.
    //   2 = erase   → knock the masked region out of the image (handled on
    //                 the alpha side of the boolean chain in main()).
    const fm = `uLayer_${slotIndex}_fillMode`
    const fc = `uLayer_${slotIndex}_fillColor`
    const fs = `uLayer_${slotIndex}_fillStrength`
    return /* glsl */ `
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
        uniform float ${fm};
        uniform vec3  ${fc};
        uniform float ${fs};

        vec3 applyLayerAdjust_${slotIndex}(vec3 rgb) {
            // Early-out: identity adjustments. Saves the per-pixel cost for
            // the common "no-op adjust" case (a freshly created layer before
            // the user touches any slider). All ten fields must be 0.
            if (${e} == 0.0 && ${c} == 0.0 && ${s} == 0.0 && ${b} == 0.0
                && ${hi} == 0.0 && ${sh} == 0.0 && ${wh} == 0.0 && ${bk} == 0.0
                && ${tp} == 0.0 && ${tn} == 0.0) {
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
    `
}

/**
 * Build the boolean compositing chain. Produces a GLSL block that
 * declares runningColor (vec3, the colour "inside the mask so far")
 * and runningAlpha (float, the mask strength) and updates them via
 * each layer's evalLayer(int) and applyLayerAdjust_<slot>(...) calls.
 *
 * The chain is built so that the FIRST layer always uses `replace`
 * (we ignore the entry's `op` for slot 0 — the compiler enforces this).
 * Every subsequent layer uses the entry's `op`:
 *   - `add`:       `runningColor = mix(runningColor, c_i, a_i)`,
 *                  `runningAlpha = clamp(runningAlpha + a_i, 0, 1)`
 *   - `subtract`:  `runningAlpha = max(runningAlpha - a_i, 0)`;
 *                  `runningColor` is left intact — the final
 *                  `mix(src, runningColor, runningAlpha)` will show
 *                  the original source wherever alpha was reduced.
 *   - `intersect`: `runningColor = mix(runningColor, c_i, a_i)`,
 *                  `runningAlpha = runningAlpha * a_i`
 *   - `replace`:   valid only for slot 0; for later slots it's
 *                  treated as a full overwrite.
 *
 * `runningColor` is a *blended colour*, not a weighted sum. The final
 * composite is `mix(src.rgb, runningColor, runningAlpha)`, so each
 * layer's contribution is normalised by its own alpha — no
 * divide-by-zero risk in the chain itself.
 *
 * If the chain is empty the output is a passthrough block:
 * `runningColor = src.rgb; runningAlpha = 0.0` — the final mix shows
 * the source unchanged.
 *
 * @param {{ op: string }[]} chainEntries  Length 0..8. The compiler truncates.
 * @returns {string}
 */
export const buildBooleanChain = (chainEntries) => {
    if (!chainEntries || chainEntries.length === 0) {
        return /* glsl */ `
            vec3 runningColor = srcRgb;
            float runningAlpha = 0.0;
            float eraseAlpha = 0.0;
        `
    }

    const lines = []
    // `eraseAlpha` accumulates the alpha-knockout contribution of every
    // layer whose fillMode is 'erase' (== 2). It is kept on a SEPARATE
    // channel from the recolour `runningAlpha` so an erase layer cuts the
    // image instead of recolouring it. main() turns it into `1 - alpha`
    // on src.a.
    lines.push(`float eraseAlpha = 0.0;`)

    // Per-layer preamble: split the layer's raw mask alpha into a recolour
    // alpha (a_i) and an erase contribution. `isErase_i` is 1.0 when the
    // layer's fillMode uniform is 'erase' (>= 1.5 via step), 0.0 otherwise.
    const preamble = (i) => {
        lines.push(`float aFull_${i} = evalLayer(${i});`)
        lines.push(`float isErase_${i} = step(1.5, uLayer_${i}_fillMode);`)
        lines.push(`float a_${i} = aFull_${i} * (1.0 - isErase_${i});`)
        lines.push(`vec3 c_${i} = layerColor_${i}(srcRgb);`)
        lines.push(`eraseAlpha = max(eraseAlpha, aFull_${i} * isErase_${i});`)
    }

    // First layer: REPLACE. The colour starts as the first layer's
    // contributed colour; the recolour alpha starts as a_0 (erase layers
    // contribute 0 to the recolour channel but feed eraseAlpha above).
    preamble(0)
    lines.push(`vec3 runningColor = c_0;`)
    lines.push(`float runningAlpha = a_0;`)

    for (let i = 1; i < chainEntries.length; i += 1) {
        const op = chainEntries[i].op
        const a = `a_${i}`
        const c = `c_${i}`
        preamble(i)
        switch (op) {
            case 'add':
                // Union — blend colour proportional to the new layer's
                // alpha; bump total alpha (clamped). Photoshop "linear dodge".
                lines.push(`runningColor = mix(runningColor, ${c}, ${a});`)
                lines.push(`runningAlpha = clamp(runningAlpha + ${a}, 0.0, 1.0);`)
                break
            case 'subtract':
                // Drop alpha where the new layer is opaque. Colour stays
                // as the existing "inside" colour — the final mix will
                // show the original source wherever alpha is reduced.
                lines.push(`runningAlpha = max(runningAlpha - ${a}, 0.0);`)
                break
            case 'intersect':
                // Multiply alpha; blend colour proportional to the new
                // layer's alpha. Photoshop "multiply".
                lines.push(`runningColor = mix(runningColor, ${c}, ${a});`)
                lines.push(`runningAlpha = runningAlpha * ${a};`)
                break
            case 'screen':
                // 1 - (1 - a)(1 - b). Always lifts the running alpha.
                lines.push(`runningColor = mix(runningColor, ${c}, ${a});`)
                lines.push(`runningAlpha = 1.0 - (1.0 - runningAlpha) * (1.0 - ${a});`)
                break
            case 'lighten':
                // max(a, b). Keep the brighter selection.
                lines.push(`runningColor = mix(runningColor, ${c}, ${a});`)
                lines.push(`runningAlpha = max(runningAlpha, ${a});`)
                break
            case 'darken':
                // min(a, b). Keep the darker selection.
                lines.push(`runningColor = mix(runningColor, ${c}, ${a});`)
                lines.push(`runningAlpha = min(runningAlpha, ${a});`)
                break
            case 'overlay':
                // multiply on dark halves, screen on light halves, with
                // the running alpha as the base. Edge-enhancement blend.
                lines.push(`runningColor = mix(runningColor, ${c}, ${a});`)
                lines.push(`runningAlpha = runningAlpha < 0.5`)
                lines.push(`    ? (2.0 * runningAlpha * ${a})`)
                lines.push(`    : (1.0 - 2.0 * (1.0 - runningAlpha) * (1.0 - ${a}));`)
                lines.push(`runningAlpha = clamp(runningAlpha, 0.0, 1.0);`)
                break
            case 'replace':
                // Invalid after slot 0, but treat as a full overwrite so
                // a misuse is visible (the colour is replaced wholesale).
                lines.push(`runningColor = ${c}; // invalid replace, treated as overwrite`)
                lines.push(`runningAlpha = ${a};`)
                break
            default:
                lines.push(`runningColor = mix(runningColor, ${c}, ${a}); // unknown op, defaulting to add`)
                lines.push(`runningAlpha = clamp(runningAlpha + ${a}, 0.0, 1.0);`)
        }
    }
    return lines.join('\n        ')
}

/**
 * Build the `evalLayer(int idx)` dispatcher. Returns a GLSL function that
 * routes a slot index to the corresponding `evalLayer_<slot>()` function.
 *
 * Bug history: pre-Step 8 the template hardcoded all 8 slot dispatches
 * (`if (idx == 0) return evalLayer_0(); ... if (idx == 7) return evalLayer_7();`).
 * But `buildLayerFunction` only emits the functions for slots that are
 * actually present in the chain, so a chain of e.g. 2 layers would compile
 * the dispatcher referencing 6 undefined functions and the GLSL compiler
 * would fail at link time. The chain never reached `evalLayer(2..7)` at
 * runtime, but the references themselves are what broke the compile.
 *
 * This helper emits a dispatcher that ONLY references the slots in the
 * chain, leaving the fall-through `return 0.0` to handle any out-of-range
 * index (which the chain also never produces — defensive).
 *
 * @param {{ length: number }} chainEntries
 * @returns {string}
 */
export const buildEvalDispatcher = (chainEntries) => {
    const n = (chainEntries && typeof chainEntries.length === 'number') ? chainEntries.length : 0
    if (n === 0) {
        // No layers: dispatcher returns 0 unconditionally. The chain body
        // also short-circuits to passthrough when the chain is empty, so
        // this dispatcher is never actually called at runtime.
        return /* glsl */ `
            float evalLayer(int idx) { return 0.0; }
        `
    }
    const lines = ['float evalLayer(int idx) {']
    for (let i = 0; i < n; i += 1) {
        lines.push(`    if (idx == ${i}) return evalLayer_${i}();`)
    }
    lines.push('    return 0.0;')
    lines.push('}')
    return lines.join('\n        ')
}
