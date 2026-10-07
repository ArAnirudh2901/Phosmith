import { Sparkles, WandSparkles } from "lucide-react"
import { ProRulerSlider } from "@/components/editor/ProRulerSlider"
import { FILTER_VISUAL } from "./config"
import { imageKitOpacity, signedToken, stripHex } from "./utils"

// AI transforms that are model calls — must be chained as SEPARATE steps (colon-separated).
export const AI_TRANSFORM_PREFIXES = ['e-retouch', 'e-upscale']

export const isAiTransform = (token) => AI_TRANSFORM_PREFIXES.some((p) => token.startsWith(p))

export const buildImageKitTokens = (values) => {
    const tokens = []
    if (values.autoContrast) tokens.push("e-contrast")
    if (values.retouch) tokens.push("e-retouch")
    if (values.upscale) tokens.push("e-upscale")
    if (values.grayscale) tokens.push("e-grayscale")
    if (values.sharpen > 0) tokens.push(`e-sharpen-${values.sharpen}`)
    if (values.usm > 0) tokens.push(`e-usm-2-2-${(values.usm / 100).toFixed(2)}-0.02`)
    if (values.urlBlur > 0) tokens.push(`bl-${values.urlBlur}`)
    if (values.colorize > 0) tokens.push(`e-colorize-co-${stripHex(values.colorizeColor)}_in-${values.colorize}`)
    if (values.shadow) {
        tokens.push(`e-shadow-bl-${values.shadowBlur}_st-${values.shadowSaturation}_x-${signedToken(values.shadowX)}_y-${signedToken(values.shadowY)}`)
    }
    if (values.gradient && values.gradientOpacity > 0) {
        const alpha = imageKitOpacity(values.gradientOpacity)
        tokens.push(`e-gradient-ld-${values.gradientAngle}_from-${stripHex(values.gradientFrom)}${alpha}_to-${stripHex(values.gradientTo)}${alpha}_sp-0.5`)
    }
    return tokens
}

export const ImageKitPanel = ({ imageKitValues, setImageKitValues, onApply, isApplying }) => {
    const tokens = buildImageKitTokens(imageKitValues)
    const setValue = (key, value) => setImageKitValues((prev) => ({ ...prev, [key]: value }))
    const toggle = (key) => {
        const nextValue = !imageKitValues[key]
        console.log("[Adjust ImageKit] toggle", {
            key,
            nextValue,
            tokensBefore: tokens,
        })
        setValue(key, nextValue)
    }

    return (
        <div className="adjust-imagekit-panel">
            <div className="adjust-toggle-grid">
                {[
                    ["autoContrast", "Auto contrast"],
                    ["retouch", "AI retouch"],
                    ["upscale", "AI upscale"],
                    ["grayscale", "Grayscale"],
                    ["shadow", "Shadow"],
                    ["gradient", "Gradient"],
                ].map(([key, label]) => (
                    <button
                        key={key}
                        type="button"
                        onClick={() => toggle(key)}
                        className={`adjust-toggle ${imageKitValues[key] ? "is-on" : ""}`}
                    >
                        <span />
                        {label}
                    </button>
                ))}
            </div>

            {[
                { key: "sharpen", label: "URL Sharpen", min: 0, max: 100 },
                { key: "usm", label: "Unsharp Mask", min: 0, max: 100 },
                { key: "urlBlur", label: "URL Blur", min: 0, max: 100 },
                { key: "colorize", label: "Colorize", min: 0, max: 100 },
                { key: "shadowBlur", label: "Shadow Blur", min: 0, max: 15 },
                { key: "shadowSaturation", label: "Shadow Sat", min: 0, max: 100 },
                { key: "shadowX", label: "Shadow X", min: -100, max: 100 },
                { key: "shadowY", label: "Shadow Y", min: -100, max: 100 },
                { key: "gradientAngle", label: "Gradient Angle", min: 0, max: 359, suffix: "º" },
                { key: "gradientOpacity", label: "Gradient Opacity", min: 0, max: 100 },
            ].map((config) => (
                <ProRulerSlider
                    key={config.key}
                    variant="instrument"
                    value={imageKitValues[config.key]}
                    onCommit={(v) => setValue(config.key, v)}
                    min={config.min}
                    max={config.max}
                    step={1}
                    label={config.label}
                    suffix={config.suffix || ""}
                    visual={FILTER_VISUAL.sharpness}
                />
            ))}

            <div className="adjust-mini-color-grid">
                {[
                    ["colorizeColor", "Colorize"],
                    ["gradientFrom", "Gradient A"],
                    ["gradientTo", "Gradient B"],
                ].map(([key, label]) => (
                    <label key={key} className="adjust-rgb-field">
                        <span>{label}</span>
                        <input type="color" value={imageKitValues[key]} onChange={(event) => setValue(key, event.target.value)} />
                    </label>
                ))}
            </div>

            <div className="adjust-token-preview">
                <span>URL chain</span>
                <code>{tokens.length ? tokens.join(",") : "No ImageKit URL transforms selected"}</code>
            </div>

            <button type="button" className="adjust-apply-imagekit" onClick={onApply} disabled={isApplying || tokens.length === 0}>
                {isApplying ? <Sparkles className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}
                {isApplying ? "Applying..." : "Apply ImageKit URL transforms"}
            </button>
        </div>
    )
}
