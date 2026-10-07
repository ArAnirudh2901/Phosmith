import { useRef } from "react"
import Colorful from "@uiw/react-color-colorful"
import { ProRulerSlider } from "@/components/editor/ProRulerSlider"
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from "@/lib/color-utils"
import { clamp } from "./utils"

export const ColorWheelPicker = ({ color, onChange }) => {
    const wheelRef = useRef(null)
    const hsv = rgbToHsv(hexToRgb(color))
    const pointerAngle = ((hsv.h - 90) * Math.PI) / 180
    const pointerRadius = hsv.s * 43

    const updateColorFromEvent = (event) => {
        const rect = wheelRef.current?.getBoundingClientRect()
        if (!rect) return
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        const dx = event.clientX - cx
        const dy = event.clientY - cy
        const radius = Math.max(1, Math.min(rect.width, rect.height) / 2)
        const saturation = clamp(Math.sqrt(dx * dx + dy * dy) / radius, 0, 1)
        const hue = (Math.atan2(dy, dx) * 180) / Math.PI + 90
        const rgb = hsvToRgb((hue + 360) % 360, saturation, 1)
        onChange(rgbToHex(rgb.r, rgb.g, rgb.b))
    }

    const handlePointerDown = (event) => {
        event.preventDefault()
        updateColorFromEvent(event)
        const handleMove = (moveEvent) => updateColorFromEvent(moveEvent)
        const handleUp = () => {
            window.removeEventListener("pointermove", handleMove)
            window.removeEventListener("pointerup", handleUp)
            window.removeEventListener("pointercancel", handleUp)
        }
        window.addEventListener("pointermove", handleMove)
        window.addEventListener("pointerup", handleUp)
        window.addEventListener("pointercancel", handleUp)
    }

    return (
        <div
            ref={wheelRef}
            className="adjust-wheel-picker"
            role="button"
            aria-label="Color wheel"
            tabIndex={0}
            onPointerDown={handlePointerDown}
        >
            <span
                style={{
                    left: `${50 + Math.cos(pointerAngle) * pointerRadius}%`,
                    top: `${50 + Math.sin(pointerAngle) * pointerRadius}%`,
                    background: color,
                }}
            />
        </div>
    )
}

export const ColorWheelCard = ({ config, values, onColor, onAmount }) => (
    <div className="adjust-color-wheel-card">
        <div className="adjust-color-wheel-top">
            <div>
                <span>{config.label}</span>
                <strong>{values[config.key]}</strong>
            </div>
            <span className="adjust-color-chip" style={{ background: values[config.colorKey] }} />
        </div>
        <ColorWheelPicker
            color={values[config.colorKey]}
            onChange={(nextColor) => onColor(config.colorKey, nextColor)}
        />
        <Colorful
            color={values[config.colorKey]}
            disableAlpha
            className="adjust-colorful"
            onChange={(color) => onColor(config.colorKey, color.hex)}
        />
        <ProRulerSlider
            variant="instrument"
            value={values[config.key]}
            onPreview={(v) => onAmount(config.key, v, false)}
            onCommit={(v) => onAmount(config.key, v, true)}
            min={0}
            max={100}
            step={1}
            label="Strength"
            visual={{ fill: "rgba(60, 72, 86, 0.48)", accent: values[config.colorKey], trackBg: "rgba(14, 16, 20, 0.98)" }}
        />
    </div>
)
